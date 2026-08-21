/**
 * The team page: one HTML page at screenless.sh/team, served by this Worker
 * via a route on the site's zone, plus the /team/api it talks to.
 *
 * One page, deliberately. Sign-in, the roster, invites, the accept flow and
 * the billing tab are states of the same document, switched client-side — an
 * invite link is this page with `?invite=<token>`, not a second page.
 *
 * Web identity is a cookie carrying a user id, distinct from the CLI's
 * phone-bound bearer token, because the page's most important visitor — a
 * fresh invitee — has no verified phone yet. Phones are verified here through
 * exactly the same Telnyx Verify profile and rate limits as the CLI, and a
 * number can be re-entered and re-verified at any time: the person who typo'd
 * their number is the person this flow most needs to let back in.
 */

import type { Env } from "./index";
import * as db from "./db";
import * as billing from "./billing";
import * as telnyx from "./telnyx";
import { json, fail, isE164, destinationAllowed, rateLimit } from "./util";
import { signWeb, webSession, safeEqual } from "./auth";
import { layout, button, codeBlock, esc } from "./emailhtml";
import { sendHtml, isEmail } from "./mail";

const COOKIE_TTL_SECS = 30 * 24 * 60 * 60;

async function cookieFor(env: Env, uid: string): Promise<string> {
  const token = await signWeb({ uid, exp: Math.floor(Date.now() / 1000) + COOKIE_TTL_SECS }, env.SESSION_SECRET);
  return `sl_session=${token}; Path=/team; Max-Age=${COOKIE_TTL_SECS}; HttpOnly; Secure; SameSite=Lax`;
}

async function currentUser(req: Request, env: Env): Promise<db.User | null> {
  const s = await webSession(req, env.SESSION_SECRET);
  return s ? db.userById(env, s.uid) : null;
}

const teamUrl = (env: Env) => `${env.SITE_URL || "https://screenless.sh"}/team`;

/* ------------------------------------------------------------------ emails */

export async function sendLoginCode(env: Env, to: string, code: string): Promise<void> {
  await sendHtml(
    env,
    to,
    `${code} is your screenless sign-in code`,
    layout(
      env,
      `<p>Your sign-in code for the team page:</p>
${codeBlock(code)}
<p style="color:#8d837a;">If you did not try to sign in, ignore this — nothing happens without the code.</p>`,
      `Your screenless sign-in code is ${code}`,
    ),
    `Your screenless sign-in code is ${code}.\n`,
  );
}

export async function sendInvite(env: Env, invite: db.Invite, inviter: db.User, org: db.Org): Promise<void> {
  const url = `${teamUrl(env)}?invite=${invite.token}`;
  const who = inviter.name ? `${inviter.name} (${inviter.email ?? "no email"})` : inviter.email ?? "A teammate";
  await sendHtml(
    env,
    invite.email,
    `${inviter.name || inviter.email || "A teammate"} invited you to ${org.name} on screenless`,
    layout(
      env,
      `<p><strong>${esc(who)}</strong> invited you to join <strong>${esc(org.name)}</strong> on screenless —
a phone line for the work your team's coding agents are blocked on.</p>
<p>Accept the invite, verify your phone number, and the team's screenless line is yours to call too.</p>
${button(url, `Join ${org.name}`)}
<p style="color:#8d837a;">The invite is valid for seven days. If the button does not work, open:<br>
<a href="${url}" style="color:#8d837a;">${url}</a></p>`,
      `${inviter.name || inviter.email} invited you to ${org.name} on screenless`,
    ),
    `${who} invited you to join ${org.name} on screenless.\n\nAccept here (valid 7 days): ${url}\n`,
  );
}

/** The day-later nudge for members who accepted but never verified a phone. */
export async function sendPhoneReminder(env: Env, user: db.User, org: db.Org): Promise<void> {
  if (!user.email) return;
  await sendHtml(
    env,
    user.email,
    `Verify your phone number to get started with ${org.name}`,
    layout(
      env,
      `<p>You joined <strong>${esc(org.name)}</strong> on screenless, but there is no verified
phone number on your account yet — so the morning call has nowhere to ring, and the team line
does not recognise you.</p>
<p>It takes a minute: enter your number, type the code from the text.</p>
${button(teamUrl(env), "Verify your phone")}
<p style="color:#8d837a;">Typed the wrong number before? Just enter the right one — it replaces the old one.</p>`,
      "Please verify your phone number — it takes a minute",
    ),
    `You joined ${org.name} on screenless but have no verified phone yet.\nVerify it here: ${teamUrl(env)}\n`,
  );
}

/* --------------------------------------------------------------- api bits */

const readJson = async (req: Request): Promise<Record<string, unknown>> =>
  ((await req.json().catch(() => ({}))) as Record<string, unknown>) ?? {};

function inviteState(invite: db.Invite): "accepted" | "expired" | "fresh" {
  if (invite.accepted_at) return "accepted";
  return invite.expires_at < Date.now() ? "expired" : "fresh";
}

async function requireAdmin(req: Request, env: Env): Promise<{ user: db.User; org: db.Org } | Response> {
  const user = await currentUser(req, env);
  if (!user) return fail(401, "not signed in");
  if (user.role !== "admin") return fail(403, "admins only");
  const org = await db.orgById(env, user.org_id);
  if (!org) return fail(500, "org missing");
  return { user, org };
}

async function handleApi(req: Request, env: Env, path: string, method: string): Promise<Response> {
  const sub = path.slice("/team/api".length) || "/";

  /* ---- sign in by email code ---- */

  if (method === "POST" && sub === "/login/start") {
    const { email } = await readJson(req);
    if (typeof email !== "string" || !isEmail(email)) return fail(400, "a valid email is required");
    if (!(await rateLimit(env, `weblogin:${email.toLowerCase()}`, 5)))
      return fail(429, "too many codes for this address, try again in an hour");

    // Same answer whether or not the address has an account, so the login box
    // cannot be used to enumerate who is on screenless.
    const user = await db.userByEmail(env, email);
    if (user) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
      await db.stashPut(env, `weblogin:${email.toLowerCase()}`, code, 900);
      await sendLoginCode(env, email, code);
    }
    return json({ sent: true });
  }

  if (method === "POST" && sub === "/login/verify") {
    const { email, code } = await readJson(req);
    if (typeof email !== "string" || typeof code !== "string") return fail(400, "email and code required");
    const expected = await db.stashGet(env, `weblogin:${email.toLowerCase()}`);
    if (!expected || !safeEqual(code.trim(), expected)) return fail(401, "that code is not right");
    const user = await db.userByEmail(env, email);
    if (!user) return fail(401, "that code is not right");
    await db.stashDelete(env, `weblogin:${email.toLowerCase()}`);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": await cookieFor(env, user.id) },
    });
  }

  if (method === "POST" && sub === "/logout") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "sl_session=; Path=/team; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      },
    });
  }

  /* ---- the invite accept flow (token is the credential, no cookie needed) ---- */

  if (method === "GET" && sub === "/invite") {
    const token = new URL(req.url).searchParams.get("token") ?? "";
    const invite = await db.inviteByToken(env, token);
    if (!invite) return fail(404, "unknown invite");
    const org = await db.orgById(env, invite.org_id);
    const inviter = await db.userById(env, invite.invited_by);
    const existing = await db.userByEmail(env, invite.email);
    const existingOrg = existing && existing.org_id !== invite.org_id ? await db.orgById(env, existing.org_id) : null;
    return json({
      state: inviteState(invite),
      email: invite.email,
      orgName: org?.name ?? "a team",
      inviterName: inviter?.name || "",
      inviterEmail: inviter?.email || "",
      invitedAt: invite.created_at,
      expiresAt: invite.expires_at,
      existingUser: Boolean(existing),
      currentOrgName: existingOrg?.name ?? null,
    });
  }

  if (method === "POST" && sub === "/invite/accept") {
    const { token, name } = await readJson(req);
    const invite = typeof token === "string" ? await db.inviteByToken(env, token) : null;
    if (!invite) return fail(404, "unknown invite");
    if (inviteState(invite) === "expired") return fail(410, "this invite has expired — ask for a new one");
    if (inviteState(invite) === "accepted") return fail(409, "this invite was already accepted");

    // Moving org must not leave the old org headless: the sole admin of a team
    // that still has members appoints a successor before leaving.
    const existing = await db.userByEmail(env, invite.email);
    if (existing && existing.org_id !== invite.org_id && existing.role === "admin") {
      const old = await db.members(env, existing.org_id);
      if (old.length > 1 && !old.some((m) => m.id !== existing.id && m.role === "admin"))
        return fail(409, "you are the only admin of your current team — make someone else admin first");
    }

    const user = await db.acceptInvite(env, invite, typeof name === "string" ? name.slice(0, 80) : "");
    return new Response(
      JSON.stringify({ ok: true, phoneVerified: Boolean(user.phone_verified_at) }),
      { headers: { "Content-Type": "application/json", "Set-Cookie": await cookieFor(env, user.id) } },
    );
  }

  /* ---- phone verify / change (cookie) ---- */

  if (method === "POST" && sub === "/phone/start") {
    const user = await currentUser(req, env);
    if (!user) return fail(401, "not signed in");
    const { phone } = await readJson(req);
    if (!isE164(phone)) return fail(400, "phone must be E.164, e.g. +31612345678");
    if (!destinationAllowed(phone, env.ALLOWED_DESTINATIONS))
      return fail(403, "we can't text that country yet — mail hello@screenless.sh");
    // The same spend guards as the CLI's OTP path, same KV keys.
    if (!(await rateLimit(env, `otp:${phone}`, 5)))
      return fail(429, "too many codes for this number, try again in an hour");
    if (!(await rateLimit(env, "otp:global", 60)))
      return fail(429, "verification is temporarily rate limited, try again shortly");

    await telnyx.triggerSmsVerification(env.TELNYX_API_KEY, phone, env.TELNYX_VERIFY_PROFILE_ID);
    // The number being verified lives server-side, so the verify step binds
    // the code to the number it was sent to, not to whatever the form resends.
    await db.stashPut(env, `webphone:${user.id}`, phone, 900);
    return json({ sent: true, phone });
  }

  if (method === "POST" && sub === "/phone/verify") {
    const user = await currentUser(req, env);
    if (!user) return fail(401, "not signed in");
    const { code } = await readJson(req);
    const phone = await db.stashGet(env, `webphone:${user.id}`);
    if (!phone) return fail(410, "no pending verification — enter your number again");
    if (typeof code !== "string" || !/^\d{4,10}$/.test(code)) return fail(400, "invalid code format");

    const ok = await telnyx.checkVerificationCode(env.TELNYX_API_KEY, phone, code, env.TELNYX_VERIFY_PROFILE_ID);
    if (!ok) return fail(401, "code rejected or expired");

    // Verifying a number that lives on another account takes it over: the
    // code just proved possession, and possession is the identity model.
    const bound = await db.setUserPhone(env, user.id, phone);
    await db.stashDelete(env, `webphone:${user.id}`);
    return json({ verified: true, phone, tookOver: Boolean(bound.tookOverFrom) });
  }

  /* ---- the roster ---- */

  if (method === "GET" && sub === "/me") {
    const user = await currentUser(req, env);
    if (!user) return fail(401, "not signed in");
    const org = await db.orgById(env, user.org_id);
    if (!org) return fail(500, "org missing");
    const roster = await db.members(env, org.id);
    const invites = await db.invitesFor(env, org.id);
    const inviterNames = new Map(roster.map((m) => [m.id, m.name || m.email || ""]));

    return json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        phone: user.phone,
        phoneVerified: Boolean(user.phone_verified_at),
      },
      org: { id: org.id, name: org.name, creditCents: org.credit_cents },
      isAdmin: user.role === "admin",
      priceCentsPerMinute: db.priceCentsPerMinute(env),
      billingEnabled: billing.billingEnabled(env),
      inboundNumber: env.TELNYX_FROM_NUMBER,
      members: roster.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        phone: m.phone,
        role: m.role,
        phoneVerified: Boolean(m.phone_verified_at),
        joinedAt: m.created_at,
        you: m.id === user.id,
      })),
      invites: invites.map((i) => ({
        token: i.token,
        email: i.email,
        invitedAt: i.created_at,
        expiresAt: i.expires_at,
        expired: i.expires_at < Date.now(),
        invitedBy: inviterNames.get(i.invited_by) ?? "",
      })),
    });
  }

  if (method === "POST" && sub === "/org") {
    const gate = await requireAdmin(req, env);
    if (gate instanceof Response) return gate;
    const { name } = await readJson(req);
    if (typeof name !== "string" || !name.trim() || name.length > 60)
      return fail(400, "a name up to 60 characters, please");
    await db.renameOrg(env, gate.org.id, name.trim());
    return json({ ok: true });
  }

  if (method === "POST" && sub === "/invites") {
    const gate = await requireAdmin(req, env);
    if (gate instanceof Response) return gate;
    const { email } = await readJson(req);
    if (typeof email !== "string" || !isEmail(email)) return fail(400, "a valid email is required");
    const already = await db.userByEmail(env, email);
    if (already?.org_id === gate.org.id) return fail(409, "they are already on this team");
    if (!(await rateLimit(env, `invites:${gate.org.id}`, 30, 86400)))
      return fail(429, "invite limit reached for today");

    const invite = await db.upsertInvite(env, gate.org.id, email, gate.user.id);
    await sendInvite(env, invite, gate.user, gate.org);
    return json({ ok: true });
  }

  if (method === "POST" && sub === "/invites/delete") {
    const gate = await requireAdmin(req, env);
    if (gate instanceof Response) return gate;
    const { token } = await readJson(req);
    if (typeof token !== "string") return fail(400, "token required");
    await db.deleteInvite(env, gate.org.id, token);
    return json({ ok: true });
  }

  if (method === "POST" && sub === "/members/role") {
    const gate = await requireAdmin(req, env);
    if (gate instanceof Response) return gate;
    const { userId, role } = await readJson(req);
    if (typeof userId !== "string" || (role !== "admin" && role !== "member"))
      return fail(400, "userId and role required");
    if (role === "member") {
      const roster = await db.members(env, gate.org.id);
      const admins = roster.filter((m) => m.role === "admin");
      if (admins.length === 1 && admins[0].id === userId)
        return fail(409, "a team needs at least one admin");
    }
    await db.setRole(env, gate.org.id, userId, role);
    return json({ ok: true });
  }

  if (method === "POST" && sub === "/members/remove") {
    const gate = await requireAdmin(req, env);
    if (gate instanceof Response) return gate;
    const { userId } = await readJson(req);
    if (typeof userId !== "string") return fail(400, "userId required");
    if (userId === gate.user.id) return fail(409, "you can't remove yourself");
    await db.removeMember(env, gate.org.id, userId);
    return json({ ok: true });
  }

  /* ---- billing (admins) ---- */

  if (method === "GET" && sub === "/billing") {
    const gate = await requireAdmin(req, env);
    if (gate instanceof Response) return gate;
    // A topup the webhook has not reported yet is picked up here, which is
    // what makes the balance move while the page polls after Checkout.
    if (billing.billingEnabled(env)) await billing.reconcilePending(env, gate.org.id);
    const org = (await db.orgById(env, gate.org.id))!;
    const stats = await db.usageStats(env, org.id);
    return json({
      creditCents: org.credit_cents,
      priceCentsPerMinute: db.priceCentsPerMinute(env),
      freeCreditCents: db.freeCreditCents(env),
      billingEnabled: billing.billingEnabled(env),
      topupOptions: billing.TOPUP_OPTIONS,
      ...stats,
    });
  }

  if (method === "POST" && sub === "/billing/topup") {
    const gate = await requireAdmin(req, env);
    if (gate instanceof Response) return gate;
    if (!billing.billingEnabled(env)) return fail(503, "billing is not configured on this Worker");
    const { cents } = await readJson(req);
    const amount = Number(cents);
    const { url } = await billing.createTopup(env, gate.org, gate.user, amount);
    return json({ url });
  }

  return fail(404, "not found");
}

/* -------------------------------------------------------------------- page */

export async function handle(req: Request, env: Env, path: string, method: string): Promise<Response | null> {
  if (path === "/team" && method === "GET") return page(env);
  if (path.startsWith("/team/api")) return handleApi(req, env, path, method);
  return null;
}

function page(env: Env): Response {
  void env;
  return new Response(PAGE, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * The whole front end. No framework, no build step, no second file: state
 * lives in one `S` object and every view is a render function into #app.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>screenless — team</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>
  :root { --ink:#14110f; --paper:#fdfcfa; --wash:#f5f1ec; --line:#ded7cf; --dim:#8d837a; --rust:#b4341f; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font-family: Georgia, 'Times New Roman', serif; font-size:16px; line-height:1.55; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 28px 20px 80px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom: 30px; }
  header img { height: 34px; }
  header .name { font-size: 22px; }
  header .org { color: var(--dim); }
  header .spacer { flex:1; }
  a { color: var(--rust); }
  h1 { font-size: 26px; font-weight: normal; margin: 0 0 6px; }
  .dim { color: var(--dim); }
  .small { font-size: 13.5px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:22px 24px; margin: 14px 0; }
  .tabs { display:flex; gap: 4px; border-bottom:1px solid var(--line); margin: 18px 0 4px; }
  .tabs button { font: inherit; background:none; border:none; padding: 8px 14px; cursor:pointer;
                 color: var(--dim); border-bottom: 2px solid transparent; }
  .tabs button.on { color: var(--ink); border-bottom-color: var(--rust); }
  input, select { font: inherit; padding: 8px 10px; border:1px solid var(--line); border-radius:6px;
                  background:#fff; color:var(--ink); }
  input:focus { outline: 2px solid #e08a72; }
  button.act { font: inherit; background: var(--rust); color:#fff; border:none; border-radius:6px;
               padding: 9px 16px; cursor:pointer; }
  button.act:disabled { opacity:.5; cursor:default; }
  button.ghost { font: inherit; background:none; border:1px solid var(--line); border-radius:6px;
                 padding: 8px 14px; cursor:pointer; color: var(--ink); }
  button.plus { font-size: 20px; line-height: 1; padding: 6px 13px 9px; }
  .row { display:flex; align-items:center; gap:12px; padding: 11px 2px; border-top: 1px solid var(--wash); }
  .row:first-child { border-top:none; }
  .row .who { flex: 1; min-width: 0; }
  .row .who .mail { color: var(--dim); font-size: 13.5px; overflow-wrap:anywhere; }
  .chip { font-size: 12.5px; padding: 2px 9px; border-radius: 99px; background: var(--wash); color: var(--dim); }
  .chip.admin { background: #f3ded9; color: var(--rust); }
  .chip.warn { background: #fbeeea; color: var(--rust); }
  .bar { height: 10px; background: var(--rust); border-radius: 3px; min-width: 2px; }
  .barrow { display:flex; align-items:center; gap:10px; font-size: 13px; color:var(--dim); padding: 2px 0; }
  .barrow .d { width: 74px; }
  table { width:100%; border-collapse: collapse; font-size: 14.5px; }
  th { text-align:left; color:var(--dim); font-weight:normal; font-size: 13px; padding: 4px 8px 4px 0; }
  td { padding: 6px 8px 6px 0; border-top: 1px solid var(--wash); }
  .err { color: var(--rust); margin: 8px 0; min-height: 1.2em; }
  .balance { font-size: 34px; }
  .form-inline { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .banner { background: var(--wash); border:1px solid var(--line); border-radius:10px; padding: 14px 18px; margin: 14px 0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="/logo.svg" alt="">
    <span class="name">screenless</span>
    <span class="org" id="orgcrumb"></span>
    <span class="spacer"></span>
    <span id="whoami" class="dim small"></span>
  </header>
  <div id="app"><p class="dim">Loading…</p></div>
</div>
<script>
var S = { me: null, tab: 'team', billing: null, err: '' };
var app = document.getElementById('app');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function api(path, body) {
  return fetch('/team/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  }).then(function (r) {
    return r.json().catch(function(){ return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  });
}
function money(cents) { return '$' + (cents / 100).toFixed(2); }
function when(ms) { return new Date(ms).toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
function minutes(secs) { return Math.round((secs||0) / 60) + ' min'; }

/* ---------------- boot ---------------- */

var inviteToken = new URLSearchParams(location.search).get('invite');

function boot() {
  if (inviteToken) return inviteFlow();
  load();
}
function load() {
  api('/me').then(function (me) {
    S.me = me; renderMain();
  }).catch(function () { renderLogin(); });
}

/* ---------------- sign in ---------------- */

function renderLogin(sent, email) {
  document.getElementById('orgcrumb').textContent = '';
  document.getElementById('whoami').textContent = '';
  app.innerHTML =
    '<div class="card" style="max-width:430px">' +
    '<h1>Team</h1>' +
    (sent
      ? '<p>A sign-in code is on its way to <strong>' + esc(email) + '</strong>.</p>' +
        '<div class="form-inline"><input id="code" inputmode="numeric" placeholder="6-digit code" size="10">' +
        '<button class="act" id="go">Sign in</button></div>'
      : '<p class="dim">Manage who can call your team\\u2019s screenless line. Sign in with the email on your account.</p>' +
        '<div class="form-inline"><input id="email" type="email" placeholder="you@company.com" size="24">' +
        '<button class="act" id="go">Send code</button></div>') +
    '<div class="err" id="err"></div></div>';
  var go = document.getElementById('go');
  go.onclick = function () {
    go.disabled = true;
    if (!sent) {
      var em = document.getElementById('email').value.trim();
      api('/login/start', { email: em })
        .then(function () { renderLogin(true, em); })
        .catch(function (e) { showErr(e); go.disabled = false; });
    } else {
      api('/login/verify', { email: email, code: document.getElementById('code').value.trim() })
        .then(load)
        .catch(function (e) { showErr(e); go.disabled = false; });
    }
  };
  focusFirst();
}
function showErr(e) { var el = document.getElementById('err'); if (el) el.textContent = e.message; }
function focusFirst() { var i = app.querySelector('input'); if (i) i.focus(); }

/* ---------------- invite flow ---------------- */

function inviteFlow() {
  api('/invite?token=' + encodeURIComponent(inviteToken)).then(function (inv) {
    var whoBy = inv.inviterName ? inv.inviterName + ' (' + inv.inviterEmail + ')' : inv.inviterEmail;
    var html = '<div class="card" style="max-width:470px"><h1>' + esc(inv.orgName) + '</h1>';
    if (inv.state === 'expired') {
      html += '<p>This invite expired on ' + when(inv.expiresAt) + '. Ask <strong>' + esc(whoBy) +
              '</strong> to send a new one.</p></div>';
      app.innerHTML = html; return;
    }
    if (inv.state === 'accepted') {
      html += '<p>This invite was already accepted. Sign in below.</p></div>';
      app.innerHTML = html;
      setTimeout(load, 900); return;
    }
    html += '<p><strong>' + esc(whoBy) + '</strong> invited you (' + esc(inv.email) +
            ') to join <strong>' + esc(inv.orgName) + '</strong> on screenless.</p>';
    if (inv.existingUser && inv.currentOrgName) {
      html += '<p>You are on <strong>' + esc(inv.currentOrgName) + '</strong> right now. ' +
              'Joining ' + esc(inv.orgName) + ' means leaving that team \\u2014 screenless accounts are on one team at a time.</p>';
    }
    if (!inv.existingUser) {
      html += '<p class="form-inline"><input id="name" placeholder="Your name" size="22"></p>';
    }
    html += '<button class="act" id="accept">' +
            (inv.existingUser ? 'Join ' + esc(inv.orgName) : 'Accept invite') +
            '</button><div class="err" id="err"></div></div>';
    app.innerHTML = html;
    document.getElementById('accept').onclick = function () {
      this.disabled = true;
      var nameEl = document.getElementById('name');
      api('/invite/accept', { token: inviteToken, name: nameEl ? nameEl.value.trim() : '' })
        .then(function (res) {
          history.replaceState(null, '', '/team');
          inviteToken = null;
          if (!res.phoneVerified) { S.forcePhone = true; }
          load();
        })
        .catch(function (e) { showErr(e); });
    };
    focusFirst();
  }).catch(function (e) {
    app.innerHTML = '<div class="card"><p>' + esc(e.message) + '</p></div>';
  });
}

/* ---------------- main ---------------- */

function renderMain() {
  var me = S.me;
  document.getElementById('orgcrumb').textContent = '\\u00b7 ' + me.org.name;
  document.getElementById('whoami').innerHTML =
    esc(me.user.email || me.user.phone || '') + ' \\u00b7 <a href="#" id="signout">sign out</a>';
  document.getElementById('signout').onclick = function (e) {
    e.preventDefault();
    api('/logout', {}).then(function () { S.me = null; S.tab = 'team'; renderLogin(); });
  };
  var html = '';

  if (me.isAdmin) {
    html += '<div class="tabs">' +
      '<button id="t-team" class="' + (S.tab === 'team' ? 'on' : '') + '">Team</button>' +
      '<button id="t-billing" class="' + (S.tab === 'billing' ? 'on' : '') + '">Billing</button></div>';
  }
  html += '<div id="tabbody"></div>';
  app.innerHTML = html;
  if (me.isAdmin) {
    document.getElementById('t-team').onclick = function () { S.tab = 'team'; renderMain(); };
    document.getElementById('t-billing').onclick = function () { S.tab = 'billing'; loadBilling(); };
  }
  if (S.tab === 'billing' && me.isAdmin) renderBilling();
  else renderTeam();
}

function renderTeam() {
  var me = S.me;
  var body = document.getElementById('tabbody');
  var html = '';

  if (!me.user.phoneVerified || S.forcePhone) {
    html += phonePanel(S.forcePhone && me.user.phoneVerified);
  } else {
    html += '<div class="banner small">Your number: <strong>' + esc(me.user.phone) + '</strong>' +
            ' \\u00b7 the team line is <strong>' + esc(me.inboundNumber) + '</strong>' +
            ' \\u00b7 <a href="#" id="changephone">change your number</a></div>';
  }

  html += '<div class="card"><div style="display:flex;align-items:center;gap:10px;">' +
          '<h1 style="flex:1">' + esc(me.org.name) + '</h1>' +
          (me.isAdmin ? '<button class="ghost small" id="rename">Rename</button>' +
                        '<button class="act plus" id="add" title="Invite someone">+</button>' : '') +
          '</div><div id="addform"></div><div class="err" id="err"></div>';

  me.members.forEach(function (m) {
    html += '<div class="row"><div class="who">' +
      '<div>' + esc(m.name || m.email || m.phone || 'member') + (m.you ? ' <span class="dim small">(you)</span>' : '') + '</div>' +
      '<div class="mail">' + esc(m.email || '') + (m.phone ? ' \\u00b7 ' + esc(m.phone) : '') +
      (m.phoneVerified ? '' : ' \\u00b7 <span class="chip warn">phone unverified</span>') + '</div></div>' +
      '<span class="chip ' + m.role + '">' + m.role + '</span>' +
      (S.me.isAdmin && !m.you
        ? '<button class="ghost small" data-role="' + m.id + '" data-to="' + (m.role === 'admin' ? 'member' : 'admin') + '">' +
            (m.role === 'admin' ? 'Make member' : 'Make admin') + '</button>' +
          '<button class="ghost small" data-remove="' + m.id + '">Remove</button>'
        : '') +
      '</div>';
  });

  me.invites.forEach(function (i) {
    html += '<div class="row"><div class="who">' +
      '<div>' + esc(i.email) + '</div>' +
      '<div class="mail">invited ' + when(i.invitedAt) + (i.invitedBy ? ' by ' + esc(i.invitedBy) : '') + '</div></div>' +
      '<span class="chip' + (i.expired ? ' warn' : '') + '">' + (i.expired ? 'invite expired' : 'invited') + '</span>' +
      (S.me.isAdmin
        ? '<button class="ghost small" data-resend="' + esc(i.email) + '">Resend</button>' +
          '<button class="ghost small" data-revoke="' + i.token + '">Revoke</button>'
        : '') +
      '</div>';
  });

  html += '</div>';
  body.innerHTML = html;

  var change = document.getElementById('changephone');
  if (change) change.onclick = function (e) { e.preventDefault(); S.forcePhone = true; renderMain(); };

  if (me.isAdmin) {
    document.getElementById('rename').onclick = function () {
      var form = document.getElementById('addform');
      form.innerHTML = '<div class="form-inline" style="margin:10px 0"><input id="orgname" value="' + esc(me.org.name) +
        '" size="24"><button class="act" id="saveorg">Save</button></div>';
      document.getElementById('saveorg').onclick = function () {
        api('/org', { name: document.getElementById('orgname').value.trim() }).then(load).catch(showErr);
      };
      document.getElementById('orgname').focus();
    };
    document.getElementById('add').onclick = function () {
      var form = document.getElementById('addform');
      form.innerHTML = '<div class="form-inline" style="margin:10px 0"><input id="invmail" type="email" placeholder="teammate@company.com" size="26">' +
        '<button class="act" id="sendinv">Invite</button></div>' +
        '<p class="dim small">They get an email; accepting it asks them to verify their own phone number.</p>';
      document.getElementById('sendinv').onclick = function () {
        this.disabled = true;
        api('/invites', { email: document.getElementById('invmail').value.trim() }).then(load).catch(function (e) {
          showErr(e); document.getElementById('sendinv').disabled = false;
        });
      };
      document.getElementById('invmail').focus();
    };
    body.querySelectorAll('[data-role]').forEach(function (b) {
      b.onclick = function () { api('/members/role', { userId: b.dataset.role, role: b.dataset.to }).then(load).catch(showErr); };
    });
    body.querySelectorAll('[data-remove]').forEach(function (b) {
      b.onclick = function () {
        b.textContent = 'Sure?';
        b.onclick = function () { api('/members/remove', { userId: b.dataset.remove }).then(load).catch(showErr); };
      };
    });
    body.querySelectorAll('[data-resend]').forEach(function (b) {
      b.onclick = function () { api('/invites', { email: b.dataset.resend }).then(load).catch(showErr); };
    });
    body.querySelectorAll('[data-revoke]').forEach(function (b) {
      b.onclick = function () { api('/invites/delete', { token: b.dataset.revoke }).then(load).catch(showErr); };
    });
  }
}

function phonePanel(isChange) {
  return '<div class="card" id="phonecard">' +
    '<h1>' + (isChange ? 'Change your number' : 'Verify your phone') + '</h1>' +
    '<p class="dim">This is the number the morning call rings and the number the team line recognises. ' +
    'Typed it wrong? Enter the right one \\u2014 it replaces the old one. A number that is on ' +
    'another screenless account moves to this one when you verify it.</p>' +
    '<div class="form-inline"><input id="phone" placeholder="+31612345678" size="17">' +
    '<button class="act" id="sendotp">Text me a code</button></div>' +
    '<div class="form-inline" id="otprow" style="margin-top:10px;display:none">' +
    '<input id="otp" inputmode="numeric" placeholder="code" size="8">' +
    '<button class="act" id="checkotp">Verify</button></div>' +
    '<div class="err" id="perr"></div></div>';
}
/* Enter submits: the page has no <form>s, so pair each input with its action
   button — the one sharing its row, or the mapped one where the button sits
   outside the row (the invite-accept name field). */
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' || !e.target || e.target.tagName !== 'INPUT') return;
  var pair = { name: 'accept', orgname: 'saveorg', invmail: 'sendinv', phone: 'sendotp', otp: 'checkotp' };
  var row = e.target.closest ? e.target.closest('.form-inline') : null;
  var btn = (row && row.querySelector('button.act')) ||
            (pair[e.target.id] && document.getElementById(pair[e.target.id]));
  if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
});

document.addEventListener('click', function (e) {
  if (e.target && e.target.id === 'sendotp') {
    e.target.disabled = true;
    api('/phone/start', { phone: document.getElementById('phone').value.trim() })
      .then(function () {
        document.getElementById('otprow').style.display = 'flex';
        document.getElementById('sendotp').textContent = 'Send again';
        document.getElementById('sendotp').disabled = false;
        document.getElementById('perr').textContent = '';
        document.getElementById('otp').focus();
      })
      .catch(function (err) { document.getElementById('perr').textContent = err.message; e.target.disabled = false; });
  }
  if (e.target && e.target.id === 'checkotp') {
    e.target.disabled = true;
    api('/phone/verify', { code: document.getElementById('otp').value.trim() })
      .then(function () { S.forcePhone = false; load(); })
      .catch(function (err) { document.getElementById('perr').textContent = err.message; e.target.disabled = false; });
  }
});

/* ---------------- billing ---------------- */

function loadBilling() {
  S.tab = 'billing';
  renderMain();
  api('/billing').then(function (b) { S.billing = b; renderBilling(); }).catch(function (e) {
    document.getElementById('tabbody').innerHTML = '<div class="card"><p>' + esc(e.message) + '</p></div>';
  });
}
function renderBilling() {
  var body = document.getElementById('tabbody');
  var b = S.billing;
  if (!b) { body.innerHTML = '<p class="dim">Loading\\u2026</p>'; return; }

  var html = '<div class="card"><div class="dim small">Credit left</div>' +
    '<div class="balance">' + money(b.creditCents) + '</div>' +
    '<p class="dim small">Calls bill per minute at ' + money(b.priceCentsPerMinute) + '/min \\u00b7 ' +
    'used so far: ' + money(b.usedCents) + ' across ' + b.calls + ' call' + (b.calls === 1 ? '' : 's') +
    ' (' + minutes(b.usedSeconds) + ')</p>';
  if (b.billingEnabled) {
    html += '<div class="form-inline">' + b.topupOptions.map(function (c) {
      return '<button class="act" data-topup="' + c + '">Add ' + money(c) + '</button>';
    }).join('') + '</div>';
  } else {
    html += '<p class="dim small">Billing is not configured on this Worker \\u2014 calls are free here.</p>';
  }
  html += '<div class="err" id="err"></div></div>';

  if (b.perDay.length) {
    var max = Math.max.apply(null, b.perDay.map(function (d) { return d.cents; }));
    html += '<div class="card"><h1 style="font-size:19px">Last 30 days</h1>';
    b.perDay.forEach(function (d) {
      html += '<div class="barrow"><span class="d">' + d.day.slice(5) + '</span>' +
        '<span class="bar" style="width:' + Math.max(2, Math.round((d.cents / max) * 320)) + 'px"></span>' +
        '<span>' + money(d.cents) + ' \\u00b7 ' + d.calls + ' call' + (d.calls === 1 ? '' : 's') + '</span></div>';
    });
    html += '</div>';
  }

  if (b.perMember.length) {
    html += '<div class="card"><h1 style="font-size:19px">Who is calling</h1><table>' +
      '<tr><th>member</th><th>calls</th><th>minutes</th><th>cost</th></tr>';
    b.perMember.forEach(function (m) {
      html += '<tr><td>' + esc(m.name || m.email || 'unknown') + '</td><td>' + m.calls + '</td>' +
        '<td>' + minutes(m.seconds) + '</td><td>' + money(m.cents) + '</td></tr>';
    });
    html += '</table></div>';
  }

  if (b.ledger.length) {
    html += '<div class="card"><h1 style="font-size:19px">Recent activity</h1><table>';
    b.ledger.forEach(function (l) {
      html += '<tr><td>' + when(l.createdAt) + '</td><td>' + esc(l.kind) + '</td>' +
        '<td style="text-align:right">' + (l.deltaCents >= 0 ? '+' : '') + money(l.deltaCents) + '</td></tr>';
    });
    html += '</table></div>';
  }

  body.innerHTML = html;
  body.querySelectorAll('[data-topup]').forEach(function (btn) {
    btn.onclick = function () {
      btn.disabled = true;
      api('/billing/topup', { cents: Number(btn.dataset.topup) })
        .then(function (r) { location.href = r.url; })
        .catch(function (e) { showErr(e); btn.disabled = false; });
    };
  });
}

boot();
</script>
</body>
</html>`;
