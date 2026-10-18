# Screenless beyond Claude Code: hosts and landscape

Research of 18 October 2026, for Jan's question: could screenless be a good
add-on to T3 Code, "grokbot" or Codex instead of only Claude? Four research
agents read the products' docs, source code and press. Nothing below was
installed or run here. Items marked **[unverified]** come from secondary
sources or could not be confirmed.

## Bottom line

- **Every host that matters can be driven the way screenless drives Claude
  Code.** You run a request headlessly in a fork of the live session, gate its
  tools, and read the session's log for the brief. Codex and Grok Build have
  all three. T3 Code offers an API instead of a fork.
- **Recommended order:**
  1. **An adapter layer in the CLI.**
  2. **Codex**, the largest audience after Claude Code; about 2–4 days.
  3. **T3 Code** over its MCP API: one adapter reaches everyone who runs
     Claude, Codex, Grok and others through it.
  4. **Grok Build**, the cheapest port, with the smallest and least trusting
     audience.
- **"grokbot" is probably Grok Bot**, xAI's cloud team bot in Slack and on
  mobile. It is a competitor, not a host.
- **The market has moved on solo remote access.** Anthropic's Remote Control
  and Channels, Codex's mobile remote, T3 Code's apps, Omnara and Happy all
  let *the developer* reach *their own* local session, mostly for free.
- **Nobody funded offers other people a phone number or WhatsApp line into a
  developer's live local session, with per-person permissions.** That is
  screenless's white space. The logged-in browser sets it apart from cloud
  team bots (Claude Tag, Codex in Slack, Cursor, Grok Bot, Devin), but not
  from Remote Control, which can drive the local Chrome.

## Hosts

| | Codex CLI | Grok Build | T3 Code |
|---|---|---|---|
| What | OpenAI's local coding agent, open source | xAI's terminal agent, Apache-2.0, Rust | Ping.gg's (Theo) app that runs Claude Code, Codex, Cursor, Grok, OpenCode and others locally; MIT |
| Adoption | About 129.7k GitHub stars; 4–5M weekly users (spring/summer 2026) **[secondary]** | 27.4k stars; launched May 2026 | 28.3k stars; claims 500k users **[unverified]** |
| Price | Included in ChatGPT plans (Free to Pro) | Included in SuperGrok (~$30/month) | Free; bring your own subscriptions |
| Run in a fork | `codex exec fork <id> - --json` | `grok -p --resume <id> --fork-session`, Claude-style flags | No fork over the API: send into the live thread, or start a new one with context |
| Output | JSONL events (`thread.started`, `item.*`) | `streaming-json`, not documented | MCP tool results |
| Gate | `PreToolUse` hooks plus sandbox modes (`-s read-only`); hooks must be trusted by hash | `PreToolUse` hooks; reads Claude's `.claude/settings.json` hooks; **fails open** on hook error | The MCP grant caps an outside agent's permissions (read-only by default) |
| Brief | `rollout-*.jsonl` under `$CODEX_HOME/sessions` | `~/.grok/sessions/` per directory, undocumented format | `t3_thread_read` |
| Browser | Chrome extension in the signed-in browser; from `exec` **[unverified]** | Only via MCP | Whatever the hosted agent has |
| Own remote access | Slack (cloud tasks, not local); ChatGPT mobile reaches your local threads, same account only | None official; third-party remotes | Desktop, web and mobile apps; T3 Connect relay; push for approvals |
| Adapter effort | 2–4 days | 1–3 days | 2–3 days |
| Main risks | Hooks don't cover every tool, so the sandbox must be the real limit; hook-trust friction; weekly releases change internals | Fail-open hooks (deny explicitly); undocumented formats; xAI's cloud-upload incident hurts trust | Young project that changes fast; its own mobile app could grow team or voice access; Full access is the default for new threads |

## The landscape, by where the agent runs

**Reaches the local session (and so the logged-in browser):**
- **Anthropic:** Claude Code Remote Control (your Chrome via `--chrome`) and
  Channels (Telegram, Discord, your own server). Both are single-user, and
  Team and Enterprise plans need an admin to turn them on.
- **Others:** Codex mobile remote, T3 Code, Omnara, Happy, Conductor,
  OpenCode web.
- **Phone:** hobby projects only (CallMe on Telnyx/Twilio, claude-phone over
  SIP, a Vapi skill). WhatsApp bridges are single-user hacks.

**Runs in a cloud sandbox:** Claude Tag (Slack; Team/Enterprise), Codex in
Slack, Cursor background agents, Grok Bot, Devin, Factory, the Copilot
coding agent, Jules, and Warp Oz by default.

## Market signals

- **Claude Code:** run-rate revenue passed $2.5B in February 2026
  **[secondary]**. 66% of developers who use coding agents use it (Stack
  Overflow 2026); Copilot 59%.
- **Codex:** 5M weekly users in June 2026 **[secondary]**.
- **Paid add-ons exist:** CodeRabbit at about $40M a year and $24–48 a seat
  (Sacra estimate). Conductor reportedly raised a $22M Series A
  **[unverified]**.
- **"Control my agent from my phone" is a free category.** People pay for
  team value, not for remote access to their own session.

## What this means for screenless

1. **Lead with the team, not remote access.** Anthropic, OpenAI and T3 Code
   give developers their own sessions on the phone for free. Screenless sells
   the part none of them do: teammates and clients reaching the developer's
   session, by phone and WhatsApp, under per-person levels.
2. **Being host-agnostic is a real advantage.** Claude Tag, Codex in Slack and
   Grok Bot each serve one vendor's agent in the cloud. "Your team reaches
   your session, whichever agent you run" is something no vendor will build.
3. **Watch Anthropic's Channels.** A WhatsApp or phone channel plugin is a
   small step for them. The defensible part is the team layer: one shared
   number, invites, levels, a call routed to whoever serves the caller, and
   billing.
4. **Price for the team.** Remote access sells for $0; seats and minutes for
   the team and its outside callers are where willingness to pay is.

## Suggested next steps

1. **Factor the adapter.** Three pieces per host: run a request in a fork,
   gate tools, read the session for a brief. Today all three are written for
   Claude in `cli/src/live.ts`, `cli/src/chat.ts` and `cli/src/brief.ts`.
2. **Codex.** Fork via `codex exec fork`, gate with `-s read-only` plus a
   trusted `PreToolUse` hook, and build the brief from the rollout file. Then
   test it on a real call.
3. **T3 Code, over MCP.** One adapter for every agent T3 Code runs, with the
   gate taken from the MCP grant.
4. **Grok Build last,** with explicit denies to work around its fail-open
   hooks.
5. **The landing page:** "Works with Claude Code and Codex" only once each has
   handled a real call.

## Sources

- T3 Code: https://github.com/pingdotgg/t3code (docs/internals/providers.md,
  docs/user/outside-agents.md, docs/orchestration-v2/orchestrator-mcp-server.md,
  docs/user/project-settings.md); https://betterstack.com/community/guides/ai/t3-code/
- Grok: https://docs.x.ai/build/features/sessions, /build/cli/headless-scripting,
  /build/features/hooks, /build/features/mcp-servers;
  https://github.com/xai-org/grok-build;
  https://docs.x.ai/grok-bot/computer-and-apps;
  https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/;
  https://devops.com/xai-open-sources-grok-build-coding-agent-after-cloud-upload-exposes-ssh-keys-repos/;
  https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip
- Codex: https://learn.chatgpt.com/docs/developer-commands?surface=cli;
  https://learn.chatgpt.com/docs/hooks.md; https://learn.chatgpt.com/docs/remote-connections;
  https://developers.openai.com/codex/integrations/slack; https://learn.chatgpt.com/docs/pricing;
  https://github.com/openai/codex (codex-rs/exec/src/cli.rs, exec_events.rs, codex-rs/rollout)
- Landscape: https://www.anthropic.com/news/introducing-claude-tag;
  https://code.claude.com/docs/en/remote-control.md;
  https://claudefa.st/blog/guide/development/claude-code-channels;
  https://docs.cursor.com/background-agent/web-and-mobile; https://ycombinator.com/companies/omnara;
  https://github.com/slopus/happy; https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/;
  https://sacra.com/c/coderabbit/; https://gradually.ai/en/codex-statistics/
