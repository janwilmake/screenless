---
name: screenless-apply
description: Applies the decisions taken on a screenless call. Reads the call transcript and the decisions manifest written when the brief was built, then carries out what was decided — comments, labels, merges, splits, follow-up tickets — using the repo and tracker MCPs on this machine. Use when a call has just finished, when the user says "apply the decisions", "action my call", or after `screenless collect` reports a call.
---

# screenless — applying what was decided

This is the return leg. The call collected decisions and changed nothing; this
is where they take effect, on the user's own machine, with the access the user
already granted.

Run it after a call. The armed loop gets here by itself — `screenless wait`
prints `APPLY <callId>` within a minute of the call ending — but it is equally
valid to run by hand.

## What you are working from

```bash
screenless transcript --json      # what was actually said
```

That returns `{callId, status, done, transcript: [{role, text}]}`.

Then find the **decisions manifest** the brief was written with, in the output
directory of the project that produced it (`~/screenless/press/` by default),
named `<date>.decisions.json`:

```json
[
  {
    "id": 1,
    "prs": [412, 418],
    "tickets": ["PLAT-501"],
    "repo": "/Users/you/code/yourrepo",
    "question": "land together today, or take their turn?",
    "options": ["expedite both", "normal queue"]
  }
]
```

**Match by the call, not by today's date.** A brief parked at 03:00 on Friday
can be answered by a call rung in on Saturday afternoon. Pick the manifest
whose brief the call was actually placed from — the most recent one at or
before the call's start — rather than assuming it is today's.

If there is no manifest, say so and stop. Acting on a transcript alone means
guessing which pull request "the second one" meant, and a wrong guess here
merges the wrong code.

## Matching what was said to what was asked

The brief is spoken, so it deliberately carries no numbers — "the outreach
proxy fix", never "PR 418". The manifest is what puts the identifiers back.

Work through the manifest in order. For each entry, read the part of the
transcript that answers it and decide which of three states it is in:

- **Answered.** The caller chose, clearly. Act.
- **Refused.** The caller said it needs their eyes, or deferred. Do not act;
  record it.
- **Unclear.** They changed the subject, or the answer could be read two ways.
  Do not act; record it.

Bias towards *unclear*. A decision you did not apply costs the user thirty
seconds tomorrow. A decision you applied from a misreading costs them a
revert, and their trust in the whole arrangement.

The caller will also have said things the manifest never asked about — the call
is interruptible, that is the point. Collect those as findings. They are output,
not errors.

## Acting

Use the MCPs on this machine — the repo host, the tracker. Everything here is
done as the user, with the access they already have.

**Reversible actions: just do them.**

- Comment on the pull request, quoting what the caller decided and why. Their
  own words, not a paraphrase — a reviewer reading it in a week should see the
  reasoning, and a paraphrase loses exactly the part worth keeping.
- Apply and remove labels.
- Move a ticket, or open a follow-up one.
- Request a review, assign, set a milestone.

**Merging is different, and gets a second gate.**

Merge only when the transcript is unambiguous about *that specific pull
request*. If it is not, post the intended action as a comment and flag it in
the report instead.

The asymmetry is deliberate. A misheard "yeah, land it" that merges a
cross-tenant permissions fix into main is the one outcome that turns this
product into a liability. Erring towards a comment costs a few seconds; erring
towards a merge can cost a weekend.

Never force-push, never merge with failing checks, never close a pull request
that has commits the caller did not discuss.

## Reporting

Finish with a short report — this is what the user reads, and often the only
part they see:

- what was applied, one line each, with a link
- what was left alone, and whether it was refused or unclear
- anything said on the call that the manifest never asked about
- anything that failed, with the error

**Mail it.** Write that report to a file and send it through the Worker, the
same way the paper goes:

```bash
screenless mail --body <outDir>/<date>.report.md \
  --subject "screenless · what you decided · <date>"
```

This is the one email a call produces. The Worker deliberately does not mail
the transcript — the first person to receive one said a transcript in the
inbox is the screen the product exists to remove. What they want is what was
*done* with what they said: decided → applied → here is the link. Keep it to
the four lists above, quote their words where a decision was theirs, and say
plainly what needs their eyes.

Then `screenless applied <callId>`, so the next probe does not hand you the
same call again — and only then, so an apply that failed is retried rather
than written off.

Then stop. Do not open new work off the back of what you found; that belongs to
tonight's run.
