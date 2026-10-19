# Session 18 — meetings join the line: chimein moves into screenless

author: Wijnand (wijnand@hyre.io), via Claude Code in the Hyre session

chimein moved into the line: `screenless meet <link> [--at <time>]` sends a
Recall.ai bot into a meeting under the session's name, and its requests reach
the owner's watcher like a live call's, each gated by who asked.

What landed:

- **Meetings on the line.** `worker/src/meeting.ts` (the MeetingCall Durable
  Object), `recall.ts`, `room.ts` (who is in the meeting and who asked, with
  unit tests), the bot's page `site/src/meet-bot.html`/`.js`, `POST /meet`,
  `/meet/:id/{session,ws,recall,leave}`, and the same `/live/:id` interface
  calls use. chimein's tunnel is gone: the page and Recall's feed connect to
  screenless.sh with the meeting's own token.
- **Per-asker gating.** The watcher resolves each request's asker with the
  owner's permissions file: the owner, a member the meeting proved (the
  platform's email, or signed in with a member's name), or a guest, who gets
  the file's default. A display name alone proves nothing.
- **Only meeting-aware watchers get a meeting** (`meet=1` on the poll). Found
  live: Jan's own watcher on the old CLI claimed the first request and would
  have run a guest's words in the meeting's base mode, full.
- **A meeting survives a deploy.** Found live: a redeploy restarted the object
  and left the voice deaf and muted, the transcript cut short and the minutes
  restarted. The voice session id is kept in DO storage and re-attached.
- **Proven live** on 19 Oct in a real Meet, with chimein's rig as a guest
  ("Ada Lovelace"): a README question answered aloud in about 25 s (fork 14 s),
  a second after a mid-meeting redeploy (fork 9 s), transcript intact with
  speaker names, the record completed, queued and debited.
- The skill: accepting an invite is the decision to join; ad hoc from someone
  who may ask. The privacy page: meeting transcripts, OpenAI and Recall.ai.

Still open: signed-in Google bots (the Remo's meeting account in a Recall
login group); screen sharing, frames and scouts from chimein; languages
other than English; a phone call and a meeting at the same time share one
`livecall:` slot; Recall's key is Hyre's; meeting minutes not yet measured
against the price. chimein is archived, its README pointing here.

The prompts, verbatim:

> btw: i think chimein can be merged into screenless since it has very similar cost structure and technology. wdyt? the only difference is meetings get invited by email but maybe we can do it such that the llmclient sees the email via whatever connector and then decides to register screenless to the call such that it connects to the watching session when the meeting starts..? wdyt?

> ok but will it stay possible for the llm client to just join a meeting adhoc too?

> ok then, do the migration from chimein to screenless. but first , plan it

> oh btw, is the chimein ai able to join the meeting under the google account of the llm client connected????

Answers to the plan's four questions:

> 1 keep hyres key for now. 2. no, also allow changing. follows same permission file as screenless ... 3. retire, 4. yes.. GO!

So: the Recall.ai key stays Hyre's for now (us-west-2). A meeting request may
change things, by the same `.agents/permissions.md` levels as a call: the
asker's level decides, not a meeting-wide read-only rule. chimein's local
mode (own keys, a tunnel) is retired, not kept beside it. Meeting minutes come
out of the same pool, at the same price, until real meetings are measured.

Agreed before the build (from the conversation):

- Accepting a calendar invite is the decision to join: the session RSVPs by
  its permissions file, then schedules the bot with `screenless meet <link>
  --at <start>`. Ad hoc stays `screenless meet <link>`, from Slack, WhatsApp
  or a call.
- A signed-in Google bot (the Remo's own meeting account in a Recall login
  group, never its main account) is a later phase.
- Who asked is resolved from the meeting platform's own transcript, which
  names each speaker; a display name proves nothing, so it only counts as a
  teammate when the participant is signed in.

During the build, while the first test question had gone quiet:

> status?
