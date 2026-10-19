# Session 18 — meetings join the line: chimein moves into screenless

author: Jan Wilmake, via Claude Code (the Hyre session)

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
