# CLAUDE.md

Instructions for any agent working in this repo.

## Always record intent

This repo follows the [intent convention](https://github.com/janwilmake/intent)
— it was extracted from this very folder. The `/intent` skill is the law:
every session gets a file in [`intent/`](intent/README.md) with the prompts
verbatim and the author, topped up early, on every correction, and at the end;
reversals resolve into [`intent/SUMMARY.md`](intent/SUMMARY.md) immediately;
the pre-push gate refuses code with no intent beside it. Run `/intent` before
pushing, `/intent resolve` when the summary lags.

Repo-specific: the early history predates the rename — sessions before
15 August live under the *parent* directory and the old name, `voxcall`, in
`~/.claude/history.jsonl` and `~/.claude/projects/`. Pass
`--also <flattened-old-path>` to the seed scanner if you ever re-mine.

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

A phone line for a team and its coding agents: a shared number an agent calls
when it hits a decision only a person can make, wired to the terminals the team
runs. The morning call and the nightly paper are now just two of the branded
skills built on top. Five parts:

- `worker/` — Cloudflare Worker: telephony, phone verification, teams and
  invites, per-org pay-as-you-go billing, the routing that lands a call in a
  watching terminal, and the parked briefs the morning skill is placed from.
- `cli/` — the `screenless` CLI, published as a tarball the installer fetches.
- `site/` — `src/` is hand-written (pages, installer); `public/` is generated
  in full by `build.sh` and gitignored. Ship with `npm run deploy` in `site/`.
- `skills/` — the branded skills, one directory each so `npx skills add
  janwilmake/screenless` (skills.sh) installs them into every coding agent:
  - `screenless/` — the **watcher**, the core skill: `/screenless` arms
    `screenless watch` so the team's incoming calls land in this terminal and
    the agent acts on them (`APPLY.md` is the return leg for a call's decisions).
  - `call-when-afk/` — turns blocking questions into phone calls while the user
    is away.
  - `morning-pr-review/` — the **optional** nightly loop: `screenless wait` is
    its gate (not a scheduler, see its README), it builds the call brief and the
    weekly paper, and its `press/` subdir is the PDF toolkit (`collect.mjs`, the
    chart library, the renderer) shipped inside the skill so `npx skills add`
    installs it whole.

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
- Never edit `site/public/`. It is assembled from `site/src/`, `skills/` and
  `cli/dist/`, and rebuilt from empty on every deploy, so an edit there is
  work you will lose. This is why it is gitignored rather than merely
  documented — a rule with an exception is a rule nobody checks.
- The CLI has no dependencies, and should stay that way — it is distributed as
  two plain `.js` files in a tarball, and every dependency added is a thing the
  installer has to fetch.
