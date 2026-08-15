#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit, platform } from "node:process";
import * as config from "./config.js";

/**
 * The zone this machine is set to.
 *
 * This is the only source of timezone truth in the product. It is not
 * configurable anywhere, on purpose: the laptop that runs the loop already
 * knows where it is, and every alternative — asking, or guessing from the
 * dialling code — is a second copy of the answer that can disagree with the
 * first. Travelling fixes itself, because this is re-read and re-sent on every
 * settings call.
 */
function machineTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Validated here so a machine reporting something exotic cannot make a
    // settings call fail — worst case we send nothing and keep the old value.
    if (!tz) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The hosted API. Self-hosting is a supported detour, not the default path. */
const HOSTED_API = "https://api.screenless.sh";
const SITE = "https://screenless.sh";

/* ------------------------------------------------------------------ output */

const isTTY = stdout.isTTY;
const c = {
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};

function die(message: string): never {
  console.error(`${c.red("error")} ${message}`);
  exit(1);
}

/* --------------------------------------------------------------- http glue */

interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function api<T>(base: string, path: string, o: ApiOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: o.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  } catch (err) {
    return die(`could not reach ${base} — ${(err as Error).message}`);
  }

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const body = parsed as { error?: string; checkoutUrl?: string };
    // 402 is the paywall. It is answered here rather than by sending someone
    // to a web page to work out what went wrong: the server hands back the
    // exact link, so the terminal that hit the wall also gets past it.
    if (res.status === 402) return paywall(body.error, body.checkoutUrl);
    return die(body.error ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

function paywall(message?: string, url?: string): never {
  console.error(`\n${c.red("✗")} ${message ?? "subscription required"}`);
  if (url) {
    console.error(`\n  Start your 7-day free trial:\n  ${c.cyan(url)}\n`);
    void openInBrowser(url);
  } else {
    console.error(`\n  Run ${c.cyan("screenless billing")} to sort it out.\n`);
  }
  exit(1);
}

/**
 * Best-effort browser launch. A failure is silent on purpose — the URL has
 * already been printed, and a headless box is a normal place to run this.
 */
async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform === "win32" })
      .on("error", () => {})
      .unref();
  } catch {
    /* printed above; nothing else to do */
  }
}

/* ----------------------------------------------------------------- billing */

interface BillingStatus {
  active: boolean;
  status: string;
  trialEnd?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}

const dateOf = (secs?: number) => (secs ? new Date(secs * 1000).toLocaleDateString() : null);

function describe(status: BillingStatus): string {
  switch (status.status) {
    case "trialing": {
      const until = dateOf(status.trialEnd);
      return `free trial${until ? `, first charge ${until}` : ""}`;
    }
    case "active": {
      const renews = dateOf(status.currentPeriodEnd);
      return status.cancelAtPeriodEnd
        ? `active, ends ${renews ?? "at period end"}`
        : `active${renews ? `, renews ${renews}` : ""}`;
    }
    case "unmetered":
      return "no billing configured on this Worker";
    case "past_due":
      return "payment failed — update your card";
    case "none":
      return "no subscription";
    default:
      return status.status;
  }
}

/**
 * Walks an unsubscribed user through Checkout and waits for Stripe to confirm.
 *
 * Polling rather than a callback because there is nothing to call back to: the
 * CLI is a process on someone's laptop, and the Worker learns about the
 * payment from Stripe either way.
 */
async function ensureSubscription(base: string, token: string): Promise<boolean> {
  const status = await api<BillingStatus>(base, "/billing/status", { token });
  if (status.active) {
    console.log(`${c.green("✓")} subscription ${c.dim(`(${describe(status)})`)}`);
    return true;
  }

  const { url } = await api<{ url: string }>(base, "/billing/checkout", {
    method: "POST",
    token,
  });

  console.log(`\n${c.bold("One more step — start your free trial.")}`);
  console.log(`  7 days free, then $99/month. Card required, cancel any time.\n`);
  console.log(`  ${c.cyan(url)}\n`);
  await openInBrowser(url);
  console.log(c.dim("  waiting for payment... (ctrl-c to finish this later)"));

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const now = await api<BillingStatus>(base, "/billing/status", { token });
    if (now.active) {
      console.log(`\n${c.green("✓")} ${describe(now)}`);
      return true;
    }
  }

  console.log(`\n${c.red("✗")} timed out waiting for payment.`);
  console.log(c.dim(`  Run ${"screenless billing"} when you're ready — nothing was lost.`));
  return false;
}

async function billing(args: string[]): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");

  // Managing an existing subscription is Stripe's job, not ours: we never see
  // the card, so "change it" can only ever mean "here is their portal".
  if (args.includes("--manage")) {
    const { url } = await api<{ url: string }>(cfg.apiUrl, "/billing/portal", {
      method: "POST",
      token: cfg.token,
    });
    console.log(`${c.cyan(url)}`);
    await openInBrowser(url);
    return;
  }

  const status = await api<BillingStatus>(cfg.apiUrl, "/billing/status", { token: cfg.token });
  console.log(
    `${status.active ? c.green("✓") : c.red("✗")} ${c.bold(describe(status))} ${c.dim(`· ${cfg.phone}`)}`,
  );
  if (!status.active) await ensureSubscription(cfg.apiUrl, cfg.token);
}

/* ------------------------------------------------------------------- setup */

async function setup(args: string[]): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const existing = await config.load();

    // Almost nobody self-hosts, so the hosted service is the default and the
    // question is asked the way it is actually answered: y/N, one keystroke,
    // and the URL prompt only appears for the people who need it.
    const flagged = argFlag(args, "--api");
    let apiUrl = flagged || existing?.apiUrl || HOSTED_API;

    if (!flagged) {
      const answer = (await rl.question(`Self-hosted Worker? ${c.dim("y/N")}: `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        const entered = (
          await rl.question(`  Worker URL ${c.dim(existing?.apiUrl ?? "https://api.example.workers.dev")}: `)
        ).trim();
        apiUrl = entered || existing?.apiUrl || "";
        if (!apiUrl) die("a Worker URL is required when self-hosting");
      } else {
        apiUrl = HOSTED_API;
      }
    }

    const base = apiUrl.replace(/\/$/, "");

    await api(base, "/health");
    console.log(`${c.green("✓")} reached ${base}`);

    const phone = (await rl.question("Your phone number (E.164, e.g. +31612345678): ")).trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) die("that is not a valid E.164 number");

    const channel = argFlag(args, "--voice") !== undefined ? "call" : "sms";
    await api(base, "/auth/start", { method: "POST", body: { phone, channel } });
    console.log(
      `${c.green("✓")} code sent to ${phone} ${c.dim(channel === "call" ? "(by phone call)" : "(by SMS)")}`,
    );

    const code = (await rl.question("Enter the code: ")).trim();
    const result = await api<{ token: string; phone: string; expiresAt: number }>(
      base,
      "/auth/verify",
      { method: "POST", body: { phone, code } },
    );

    const path = await config.save({
      apiUrl: base,
      token: result.token,
      phone: result.phone,
      expiresAt: result.expiresAt,
    });

    console.log(`${c.green("✓")} verified as ${c.bold(result.phone)}`);
    console.log(c.dim(`  saved to ${path} (0600)`));

    // The subscription is checked here, while the user is already in a setup
    // frame of mind, rather than at the first call — where a paywall would
    // land as a failure instead of a step.
    // Terms before anything is charged or dialled. Refusing is a valid answer
    // and leaves the verified session in place, so nothing is lost by saying
    // no and coming back.
    console.log("");
    console.log(`  Terms:   ${c.cyan(`${SITE}/terms`)}`);
    console.log(`  Privacy: ${c.cyan(`${SITE}/privacy`)}`);
    const accepted = (await rl.question(`Accept? ${c.dim("y/N")}: `)).trim().toLowerCase();
    if (accepted !== "y" && accepted !== "yes") {
      console.log(`${c.red("✗")} not accepted — nothing else will run. Re-run setup when you're ready.`);
      return;
    }

    // Language before the call is ever placed, because it decides the voice as
    // well as the transcription.
    const catalogue = await api<Settings>(base, "/settings", { token: result.token });
    const langs = catalogue.languages ?? [{ code: "en", label: "English" }];
    console.log(`\n${c.bold("Language for the call")} ${c.dim("(1 = English)")}`);
    for (const [i, l] of langs.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${l.label}`);
    const picked = (await rl.question(`Choose ${c.dim("[1]")}: `)).trim();
    const chosen = langs[(Number(picked) || 1) - 1] ?? langs[0];

    await api<Settings>(base, "/settings", {
      method: "POST",
      body: { acceptTerms: true, language: chosen.code },
      token: result.token,
    });
    console.log(`${c.green("✓")} ${chosen.label}\n`);

    // The paper is the free half and works without a subscription, so this is
    // asked before the trial rather than after it.
    await confirmEmail(base, result.token, rl);


    const subscribed = await ensureSubscription(base, result.token);
    if (!subscribed) return;

    // The machine already knows its timezone, so nobody is ever asked for it.
    const detected = machineTimezone();
    const schedule = detected
      ? await api<Settings>(base, "/settings", {
          method: "POST",
          body: { timezone: detected },
          token: result.token,
        }).catch(() => null)
      : null;

    console.log("");
    if (schedule) {
      showSettings(schedule);
      console.log(c.dim(`\n  move it with `) + c.cyan("screenless settings --at 09:30"));
    }

    // Offer the repo they are standing in. The installer runs from wherever
    // they typed the curl, which for a developer is usually the project they
    // actually want a paper about — and asking beats making them discover
    // `screenless init` from the docs later.
    const { existsSync } = await import("node:fs");
    const { join, basename } = await import("node:path");
    const cwd = process.cwd();

    if (existsSync(join(cwd, ".git"))) {
      const yes = (
        await rl.question(`\nSet up the nightly loop for ${c.bold(basename(cwd))}? ${c.dim("Y/n")}: `)
      ).trim().toLowerCase();
      if (yes !== "n" && yes !== "no") {
        await init([cwd]);
        console.log(c.dim(`\n  edit .screenless.json — trackerTeam, ticketPrefix and deliverTo`));
      }
    } else {
      console.log(`\n  ${c.dim("Not in a git repo. Run")} ${c.cyan("screenless init")} ${c.dim("inside the repo you want a paper about.")}`);
    }

    console.log(`\nTry: ${c.cyan('screenless test')} ${c.dim("— a demo call, right now")}`);
  } finally {
    rl.close();
  }
}

/**
 * Confirms the address the paper is delivered to.
 *
 * The recipient is bound to the account rather than passed per send, so the
 * free surface cannot be used to point our sending domain at someone else's
 * inbox. That means it has to be proven once, here.
 */
async function confirmEmail(
  base: string,
  token: string,
  rl: { question: (q: string) => Promise<string> },
): Promise<boolean> {
  const address = (await rl.question("Email for the daily paper: ")).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    console.log(`${c.red("✗")} that is not a valid address`);
    return false;
  }

  await api(base, "/email/start", { method: "POST", body: { email: address }, token });
  console.log(`${c.green("✓")} code sent to ${c.bold(address)}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = (await rl.question("Enter the code from that email: ")).trim();
    try {
      await api(base, "/email/verify", { method: "POST", body: { code }, token });
      console.log(`${c.green("✓")} ${address} confirmed`);
      return true;
    } catch {
      // api() exits on failure, so this only runs if that ever changes.
      console.log(c.dim("  not right — try again"));
    }
  }
  return false;
}

async function email(): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await confirmEmail(cfg.apiUrl, cfg.token, rl);
  } finally {
    rl.close();
  }
}

/* -------------------------------------------------------------- test call */

/**
 * A canned rounds call, placed now.
 *
 * Someone who has just paid should not have to invent a prompt to find out
 * what they bought. This dials immediately with two made-up decisions in the
 * shape the real morning call will have, so the thing being trialled can be
 * heard inside a minute rather than tomorrow at eight.
 */
const DEMO_BRIEF = `You are running a short demo of the morning call, so the person you are
calling can hear what it sounds like. Keep the whole thing under two minutes.

Say clearly that this is a demo and the pull requests are made up. Then walk
these two, one at a time, asking for a decision on each and confirming what you
heard before moving on:

1. "HYR2-441 adds a notes field to candidates. The agent put it in a JSONB
   column rather than its own table. Nothing reads it yet. Separate table, or
   leave it?"

2. "HYR2-448 changes the default page size from 25 to 100, but it is sitting in
   a ticket about CSV export. Split it into its own PR, or leave it together?"

If they ask a question, answer briefly and get back to the decision. When both
are answered, tell them the transcript is waiting for their agent, remind them
this was a demo, and say goodbye.`;

async function test(args: string[]): Promise<void> {
  // Deliberately routed through the normal call path: if the demo works, the
  // real thing works, because it is the same code.
  await call([DEMO_BRIEF, ...args.filter((a) => a.startsWith("--"))]);
}

/* ---------------------------------------------------------------- settings */

interface Settings {
  email: string;
  emailVerifiedAt: number;
  callAt: string;
  timezone: string;
  callEnabled: boolean;
  language: string;
  termsAcceptedAt: number;
  languages?: Array<{ code: string; label: string }>;
  /** Next actual ring, ms since epoch. */
  nextCallAt: number;
  /** The number to ring back on, to take the call early or late. */
  inboundNumber: string;
}

function showSettings(s: Settings): void {
  const when = new Date(s.nextCallAt);
  const mins = Math.max(0, Math.round((s.nextCallAt - Date.now()) / 60000));
  const away = mins >= 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${mins}m`;

  console.log(
    `${c.bold("call time")}   ${s.callAt} ${c.dim(`${s.timezone} · from this machine`)}`,
  );
  console.log(
    `${c.bold("next call")}   ${s.callEnabled ? `${when.toLocaleString()} ${c.dim(`(${away})`)}` : c.red("paused")}`,
  );
  const lang = s.languages?.find((l) => l.code === s.language);
  console.log(`${c.bold("language")}    ${lang?.label ?? s.language}`);
  console.log(`${c.bold("ring back")}   ${s.inboundNumber} ${c.dim("— take the call early or late")}`);
}

async function settings(args: string[]): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");

  // Every settings call re-reports the machine's zone, so moving laptop or
  // country corrects the schedule on its own without anyone being asked.
  const patch: Record<string, unknown> = {};
  const tz = machineTimezone();
  if (tz) patch.timezone = tz;

  const at = argFlag(args, "--at");
  if (at) patch.callAt = at;
  if (args.includes("--pause")) patch.callEnabled = false;
  if (args.includes("--resume")) patch.callEnabled = true;

  const changed = Boolean(at) || args.includes("--pause") || args.includes("--resume");

  const result = Object.keys(patch).length
    ? await api<Settings>(cfg.apiUrl, "/settings", {
        method: "POST",
        body: patch,
        token: cfg.token,
      })
    : await api<Settings>(cfg.apiUrl, "/settings", { token: cfg.token });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (changed) console.log(`${c.green("✓")} saved\n`);
  showSettings(result);
}

/* -------------------------------------------------------------------- call */

interface CallStatus {
  callId: string;
  status: string;
  done: boolean;
  durationSecs?: number | null;
  transcript?: Array<{ role: string; text: string; at?: string }>;
}

async function call(args: string[]): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");
  if (cfg.expiresAt * 1000 < Date.now()) die("session expired — run `screenless setup` again");

  const prompt = args.find((a) => !a.startsWith("--"));
  if (!prompt) die('usage: screenless call "your prompt here" [--at HH:MM] [--lang en|nl|multi]');

  const language = argFlag(args, "--lang") ?? "en";
  const asJson = args.includes("--json");
  const at = argFlag(args, "--at");
  const hold = args.includes("--hold");
  // --at without a value means "my configured call time", which is the flag
  // the nightly loop actually wants: it knows when it finished, not when the
  // person it is briefing wakes up.
  const scheduled = at !== undefined || hold;

  if (scheduled) {
    const parked = await api<{ dueAt: number | null; callAt: string; inboundNumber: string }>(
      cfg.apiUrl,
      "/calls",
      { method: "POST", body: { prompt, language, at: at || undefined, hold }, token: cfg.token },
    );

    if (asJson) {
      console.log(JSON.stringify(parked, null, 2));
      return;
    }

    console.log(
      parked.dueAt
        ? `${c.green("✓")} parked — calling ${c.bold(cfg.phone)} at ${c.bold(new Date(parked.dueAt).toLocaleString())}`
        : `${c.green("✓")} parked — held until you ring in`,
    );
    console.log(
      c.dim(`  decline it and ring ${parked.inboundNumber} whenever suits — same brief, same call.`),
    );
    return;
  }

  const { callId } = await api<{ callId: string }>(cfg.apiUrl, "/calls", {
    method: "POST",
    body: { prompt, language },
    token: cfg.token,
  });

  if (!asJson) {
    console.log(`${c.green("→")} calling ${c.bold(cfg.phone)} ${c.dim(`(${callId})`)}`);
    console.log(c.dim("  pick up — the agent opens by disclosing it is an AI\n"));
  }

  // Poll rather than hold a socket open: the Worker learns the call ended from
  // Telnyx's status webhook, so all we do here is wait for it to say so.
  const deadline = Date.now() + 15 * 60 * 1000;
  let last = "";
  let result: CallStatus | undefined;

  while (Date.now() < deadline) {
    const status = await api<CallStatus>(cfg.apiUrl, `/calls/${callId}`, { token: cfg.token });
    if (!asJson && status.status !== last) {
      last = status.status;
      console.log(c.dim(`  ${status.status}...`));
    }
    if (status.done) {
      result = status;
      break;
    }
    await sleep(2000);
  }

  if (!result) die("timed out after 15 minutes waiting for the call to finish");

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "failed") {
    console.log(`\n${c.red("✗")} call did not connect (no answer, busy, or failed)`);
    exit(1);
  }

  const transcript = result.transcript ?? [];
  console.log(
    `\n${c.green("✓")} call completed${result.durationSecs ? c.dim(` · ${result.durationSecs}s`) : ""}\n`,
  );

  printTranscript(transcript);
}

function printTranscript(transcript: Array<{ role: string; text: string }>): void {
  if (!transcript.length) {
    console.log(c.dim("  (no transcript — the call may have ended before anyone spoke)"));
    return;
  }

  for (const line of transcript) {
    const who = line.role === "assistant" ? c.cyan("agent") : c.bold("you  ");
    console.log(`${who}  ${line.text}`);
  }
}

/**
 * The transcript of the most recent call, however it happened.
 *
 * This is the handoff. The call itself changes nothing: the loop reads what
 * was decided here and is the thing that merges, comments and closes, with the
 * user's own credentials on the user's own machine. `--json` exists because
 * the usual reader is that loop, not a person.
 */
async function transcript(args: string[]): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");

  const asJson = args.includes("--json");
  // The loop typically wakes while the call is still in progress, so waiting
  // is the common case rather than the exception.
  const wait = args.includes("--wait");
  const deadline = Date.now() + 30 * 60 * 1000;

  for (;;) {
    const result = await api<CallStatus>(cfg.apiUrl, "/calls/latest", { token: cfg.token });
    if (result.done || !wait) {
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.done) {
        console.log(c.dim(`call ${result.status}... (use --wait to block until it ends)`));
        return;
      }
      if (result.status === "failed") {
        console.log(`${c.red("✗")} the last call did not connect`);
        console.log(c.dim(`  the brief is still parked — ring in when it suits`));
        exit(1);
      }
      printTranscript(result.transcript ?? []);
      return;
    }
    if (Date.now() > deadline) die("gave up waiting for the call to finish");
    await sleep(5000);
  }
}

/* ------------------------------------------------------------------- misc */

async function whoami(): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");
  const expired = cfg.expiresAt * 1000 < Date.now();
  console.log(`${c.bold(cfg.phone)} ${c.dim(`via ${cfg.apiUrl}`)}`);
  console.log(
    expired
      ? c.red("session expired — run `screenless setup`")
      : c.dim(`session valid until ${new Date(cfg.expiresAt * 1000).toLocaleString()}`),
  );
}

/**
 * Hands a built edition to the Worker to be sent at wake-up.
 *
 * The Worker holds it rather than the laptop, because the machine that builds
 * the paper at 03:00 is usually asleep by the time it should send.
 */
async function mail(args: string[]): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");
  if (cfg.expiresAt * 1000 < Date.now()) die("session expired — run `screenless setup` again");

  const file = args.find((a) => !a.startsWith("--"));
  if (!file) die("usage: screenless mail <file.pdf> [--at HH:MM] [--to you@example.com]");

  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");

  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    die(`cannot read ${file}`);
  }

  const at = argFlag(args, "--at") || "";
  const to = argFlag(args, "--to") || "";
  const subject = argFlag(args, "--subject") || `screenless · ${basename(file, ".pdf")}`;

  // The Worker has no idea what timezone the reader wakes up in, so "07:00"
  // is meaningless without this. Node's offset is minutes *behind* UTC, which
  // is the opposite sign of what everyone expects — negate it here, once.
  const offsetMinutes = -new Date().getTimezoneOffset();

  const res = await api<{ id: string; sendAt: string }>(cfg.apiUrl, "/mail", {
    method: "POST",
    token: cfg.token,
    body: {
      filename: basename(file),
      contentBase64: content.toString("base64"),
      subject,
      at,
      offsetMinutes,
      ...(to ? { to } : {}),
    },
  });

  const when = new Date(res.sendAt);
  const size = (content.length / 1024).toFixed(0);
  console.log(
    `${c.green("✓")} queued ${c.bold(basename(file))} ${c.dim(`(${size} KB)`)} → ` +
      `${when.toLocaleString()} ${c.dim(`· ${res.id.slice(0, 8)}`)}`,
  );
}

/**
 * Registers the current repo with the nightly loop.
 *
 * Two files, because they have different lifetimes. `.screenless.json` sits in
 * the repo and describes it — it is committed, reviewed, and travels with the
 * code it configures. `~/.screenless/projects.json` is a list of the repos this
 * *machine* runs at 03:00, which is a property of the laptop and not of any
 * checkout.
 */
async function init(args: string[]): Promise<void> {
  const { writeFile, readFile, mkdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { resolve, basename, join } = await import("node:path");
  const { homedir } = await import("node:os");

  const repo = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  if (!existsSync(join(repo, ".git"))) die(`${repo} is not a git repository`);

  const configPath = join(repo, ".screenless.json");
  if (existsSync(configPath) && !args.includes("--force")) {
    console.log(`${c.dim("already configured:")} ${configPath}`);
  } else {
    const config = {
      repo: ".",
      tracker: "linear",
      trackerTeam: "",
      ticketPrefix: "",
      appUrl: "",
      outDir: "~/screenless/press",
      deliverTo: "",
      windowDays: 7,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`${c.green("✓")} wrote ${configPath}`);
    console.log(c.dim("  fill in trackerTeam, ticketPrefix and deliverTo before the first run"));
  }

  // The registry is append-only and deduped: registering twice is a no-op
  // rather than a second nightly run against the same repo.
  const dir = join(homedir(), ".screenless");
  const registry = join(dir, "projects.json");
  await mkdir(dir, { recursive: true, mode: 0o700 });

  let projects: string[] = [];
  try {
    projects = JSON.parse(await readFile(registry, "utf8")) as string[];
  } catch {
    /* first project on this machine */
  }
  if (!projects.includes(repo)) {
    projects.push(repo);
    await writeFile(registry, `${JSON.stringify(projects, null, 2)}\n`);
    console.log(`${c.green("✓")} registered ${c.bold(basename(repo))} for the nightly run`);
  } else {
    console.log(c.dim(`  already registered for the nightly run`));
  }

  console.log(`\n  ${projects.length} project${projects.length === 1 ? "" : "s"} in ${c.dim(registry)}`);
}

async function logout(): Promise<void> {
  const cfg = await config.load();

  // Revoke first: deleting the local file only hides the token, it does not
  // withdraw it, and these sessions last a year.
  if (cfg) {
    await api(cfg.apiUrl, "/auth/logout", { method: "POST", token: cfg.token }).catch(() => {});
  }
  await config.clear();
  console.log(`${c.green("✓")} signed out — token revoked, ${c.dim(config.configPath)} removed`);
}

function usage(): void {
  console.log(`${c.bold("screenless")} — take the decisions your agents are blocked on by phone

${c.bold("Usage")}
  screenless setup [--api <url>] [--voice]   verify your phone number by OTP
  screenless call "<prompt>" [options]       call now, or park it for later
  screenless test                            ring me now with a demo call
  screenless transcript [--wait] [--json]    what was decided on the last call
  screenless settings [--at HH:MM]           when the morning call goes out
  screenless init [path]                     configure a repo for the nightly loop
  screenless mail <file.pdf> [--at HH:MM]    schedule an edition for wake-up
  screenless email                           confirm where the paper is sent
  screenless whoami                          show the verified number
  screenless billing [--manage]              trial status, or Stripe's portal
  screenless logout                          discard the local session

${c.bold("Call options")}
  --at [HH:MM]         park the brief instead of dialling now. Bare --at uses
                       your configured call time
  --hold               park it with no time at all — it waits until you ring in
  --lang <code>        override the account language for this call. One of
                       en nl fr de hi it ja pt ru es, or "multi" to follow
                       code-switching mid-sentence
  --json               emit the raw result instead of a formatted transcript

${c.bold("Settings options")}
  --at HH:MM           local time of the morning call, 24-hour (default 08:00)
  --pause / --resume   stop or restart the scheduled call
  --json               machine-readable, for the loop

  Your timezone is not a setting — it is read from this machine every time,
  so moving country fixes the schedule by itself.

${c.bold("Taking the call on your terms")}
  Decline the morning call and ring the number back whenever suits — same
  brief, same conversation. ${c.dim("screenless settings")} prints the number.

${c.bold("What the call does not do")}
  The assistant on the phone has no tools and takes no action. It collects
  your decisions; your own loop reads ${c.dim("screenless transcript --json")} afterwards
  and is what actually merges, comments and closes.

${c.bold("Mail options")}
  --at HH:MM           next occurrence of that local time (default: now)
  --subject <text>     override the subject line

${c.bold("Setup options")}
  --api <url>          your own Worker, skipping the self-hosted prompt
                       (default: ${HOSTED_API})
  --voice              receive the OTP as a phone call instead of an SMS
`);
}

const argFlag = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : "";
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- entry */

const [command, ...rest] = argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void> | void> = {
  setup,
  call,
  test,
  transcript,
  settings,
  init,
  mail,
  whoami,
  billing,
  email,
  logout,
  help: usage,
};

const handler = commands[command ?? "help"];
if (!handler) {
  console.error(`${c.red("error")} unknown command: ${command}\n`);
  usage();
  exit(1);
}

await Promise.resolve(handler(rest)).catch((err: Error) => die(err.message));
