# CLAUDE.md

Instructions for any agent working in this repo.

## Always record intent

Every session gets a file in [`intent/`](intent/README.md) holding the user's
prompts verbatim. This is not optional and not an end-of-session chore.

**When to write:**

1. **Early.** Once the session has a shape — usually after the second or third
   prompt — create `intent/YYYY-MM-DD-session-N-short-slug.md` and write what
   has been said so far.
2. **Intermittently.** Top it up as the session goes. A good trigger: if you
   notice several prompts have landed since the last update, or the user
   changes direction, append before continuing. Do not wait to be asked, and do
   not wait for the end — sessions end by running out of context or by the user
   closing the terminal, and neither gives you a chance to catch up.
3. **On any correction.** If the user tells you something you built is wrong,
   that prompt is the most valuable line in the file. Record it with the
   correction intact.
4. **Resolve it into [`intent/SUMMARY.md`](intent/SUMMARY.md)** at the end of
   the session — and immediately whenever an instruction *reverses* an earlier
   one, rather than waiting. Sessions end by running out of context or by the
   terminal closing, so "at the end" is a thing you often do not get to do; a
   reversal recorded late is a summary that quietly disagrees with the code.

   SUMMARY.md keeps the winning version of each instruction, notes what it
   replaced, and marks every line **built**, **built but never run**, or **not
   built**. Keep the middle value honest — most of a young product is written
   and unexercised, and a summary that flattens that distinction is worse than
   none. Update its "Last updated" line to name the newest prompt it covers,
   and keep the two standing sections current: *Missing intent* for what was
   asked and is not there, *Assumptions* for what you decided without being
   asked.

**How to write it:**

- Prompts verbatim, typos and all. Prefix each with its `HH:MM` in UTC.
- A short header written after the fact: what landed in the code, what is still
  open, and where the session drifted. Keep it honest — a session that spent an
  hour on a dead end should say so.
- Record answers to your own questions inline, marked as answers.
- Redact secrets from anything pasted: API keys, tokens, phone numbers.
- Add the session to the table in `intent/README.md`.

**Where prompts come from if you lose them:** `~/.claude/history.jsonl`, one
JSON object per line with `display`, `timestamp`, `project` and `sessionId`.
Filter by `sessionId`. Note that `project` is the directory Claude was started
in, which for this repo's early history is the *parent* directory and the old
name, `voxcall`.

## Ops tasks are your job too

Jan is logged into Telnyx, Cloudflare, Stripe and the rest in his own Chrome.
When a step needs a dashboard — assigning a number to a TeXML application,
flipping a setting no API covers, reading a rejection reason off an order — do
it with the Chrome tools rather than handing back instructions. Deploys, portal
clicks, DNS, account settings: assist, don't delegate back.

The rule is not "click anything". It is:

- **Do it** when the action is reversible, scoped to this project, and the
  intent is already clear from the conversation.
- **Confirm first** when it spends money, touches production billing in live
  mode, deletes something, or affects a surface outside this project.
- **Say what you did**, with the values you set, so it can be checked or undone.

Do not trigger `alert()`/`confirm()` dialogs — they freeze the extension. Screenshot
before and after anything non-obvious.

**Signing in.** `wijnand@hyre.io` via Google SSO is the identity for **Resend
and Telnyx**. It is *not* a Cloudflare account — Cloudflare is a separate login
under `jan@wilmake.com`, and the authenticated `wrangler` CLI is the way in
there, not the dashboard. If a dashboard shows a login wall, click through
"Continue with Google" and pick that account; the Chrome profile usually has a
live Google session, so this is a click, not a credential.

Stop and hand back the moment it asks for anything more: a typed password, a
2FA code, a recovery prompt, or a new OAuth consent screen granting a
third-party app access. Those are the user's to complete, never yours.

**Values you must not transcribe.** DKIM keys, API keys, signing secrets — long
opaque strings that fail silently when one character is wrong. Move them with
the page's own copy button and paste into the destination field. Reading one
off a screenshot and retyping it is how a DNS record ends up almost right.

## Committing

Push to `main` directly. This is a solo project and that is the established
history; no branch, no PR, unless the change is genuinely risky enough to want
review.

Commits should match the *intent* they came from, not the order the files
happened to change. One commit per decision the user made — if a session
covered the paywall, the installer and a copy fix, that is three commits, and
each message should explain why the change was wanted, not just what moved.

## What this repo is

A morning phone call and a nightly printed paper for engineers whose coding
agents open pull requests overnight. Five parts:

- `worker/` — Cloudflare Worker: telephony, phone verification, Stripe billing,
  and the parked briefs the morning call is placed from.
- `cli/` — the `screenless` CLI, published as a tarball the installer fetches.
- `site/` — the landing page and `install`, served as static assets.
- `press/` — the PDF toolkit: `collect.mjs` for deterministic facts, the chart
  library, the print stylesheet, the renderer.
- `loop/` — the single nightly skill that builds the paper *and* the call brief
  from one reading, plus the launchd job that runs it at 03:00 or on wake.

## The one architectural rule

**The assistant on the phone takes no action.** It has no tools and no
credentials. It collects decisions and hangs up. The loop on the user's own
machine reads `screenless transcript --json` afterwards and is what merges,
comments, closes and deploys.

This is a product decision, not an implementation detail: the loop already has
the user's MCPs, their logged-in browser and their Claude subscription, and a
hosted service cannot have any of those without asking for credentials nobody
should hand over. If you find yourself adding a tool to the assistant, or writing
copy that implies the call changed something, you have broken the model.

## Conventions

- Comments explain *why*, at the altitude of the decision. The existing code is
  the reference for density — match it rather than adding narration.
- Secrets never go in `wrangler.jsonc`. `wrangler secret put NAME`, and list the
  name in the comment block at the bottom of that file.
- Billing is off when `STRIPE_SECRET_KEY` is unset, so `wrangler dev` and any
  pre-Stripe deploy stay usable. Keep it that way.
- The CLI has no dependencies, and should stay that way — it is distributed as
  two plain `.js` files in a tarball, and every dependency added is a thing the
  installer has to fetch.
