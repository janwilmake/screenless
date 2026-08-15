# rounds — the morning call

Clinical rounds for your pull requests. A scheduled call that walks the queue
case by case, takes your decision on each, and writes it back — then hangs up
as soon as the queue is drained.

## Status

**Not built.** This folder is currently a placeholder with a plan in it. Be
clear about what does and does not exist:

**Exists**, in `../cli` and `../worker`: outbound calling, phone verification by
OTP, per-call assistant creation, an interruptible two-way conversation, call
records, transcript retrieval. That is the telephony half, and it is the hard
half.

**Does not exist**, and belongs here: pull-request ingestion, cross-repo triage,
agenda building, speech-shaped summarisation of a diff, the "this needs your
eyes" router, and writeback to the PR. There is no `screenless brief` command
yet — only `screenless call "<prompt>"`, the primitive it will sit on.

**Blocked.** Telnyx AI Assistants currently produce no audio on telephony calls.
Until that clears, none of this can be demonstrated end to end. See the root
README's *Blocked on Telnyx* section. This is why `press` is being finished
first.

## The shape it should take

Same substrate as `press`: a skill Claude Code runs locally, so it inherits your
MCP servers and your repo access rather than needing integrations of its own.

1. **Build the agenda.** Reuse `press/bin/collect.mjs` for PR facts, and Linear
   over MCP for intent. Rank by what needs a *decision*, not by what changed.
2. **Compress each item for the ear.** A diff is not speakable. Each agenda item
   needs a question answerable without a screen, or it does not belong on the
   call.
3. **Route what cannot be answered by voice.** "Separate table or JSONB?" is a
   call question. "Does this migration look right?" is not. Saying so is a
   feature, not a failure — it is what makes the rest of the call trustworthy.
4. **Write back.** "Do the second one" has to become a real PR comment, label,
   merge, split, or follow-up ticket. Without this the call is just a podcast.

## The two design rules worth keeping

**Hang up early.** Thirty minutes is a ceiling, not a target. Most mornings
should be ten. The product is a drained queue, not a filled slot — and
telephony is metered, so a call padded to length costs real money.

**Only taste and scope questions.** Correctness questions belong to the
reviewer; they are also the ones models keep getting better at. Taste, scope,
and priority questions have no right answer for a model to converge on, which
is what makes this durable rather than a stopgap.

## Related

- `../press` — the one-way half, and the place the agenda-building code will
  probably be shared from.
- `../cli` — where `screenless brief` will live.
- `../worker` — telephony and scheduled mail.
