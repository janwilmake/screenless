---
name: call-when-afk
description: Ask blocking questions by phone while the user is away from the keyboard. Use whenever the user says they will be AFK, away, stepping out, offline, on a walk, in a meeting, "call me if you need me", or otherwise unreachable — for the rest of the session, instead of stopping the turn with a question, place a `screenless call` with the question and continue when the answer comes back.
---

# call-when-afk

The user is leaving the keyboard but wants the work to keep going. Normally,
when you hit something only they can decide, you end the turn and wait. They
cannot answer a terminal they are not looking at — but they can answer a phone.

So for the rest of this session: **never end a turn on a blocking question.
Phone it instead.** `screenless call` rings the user, holds the conversation,
and returns the transcript when they hang up — so the question becomes a call,
the answer comes back in-process, and the session continues without stopping.

This is armed the moment the user says they are away, and it stays on until
they say they are back (or the session ends).

## The rule

When you reach a point where you would otherwise stop and ask the user a
question:

1. **Decide whether it is really theirs.** Most "questions" are you being
   cautious about something reversible — a name, a file layout, which of two
   equivalent approaches. While they are away, decide those yourself the way a
   trusted colleague would, and note the choice in your report. A call is for a
   *genuine* fork: irreversible, expensive to undo, or a matter of their taste
   and priority that you cannot infer. Do not phone someone on a walk to ask
   where to put a helper function.

2. **Place the call, and block on it:**

   ```bash
   screenless call "<the question, written to be heard>" --json
   ```

   `screenless call` (with no `--to`) dials the user's own verified number and
   **returns only when the call has ended**, printing the transcript. Read the
   `transcript` array from the JSON, take the decision from what they said, and
   carry on. You are not stopping the turn — you are waiting inside it.

3. **Continue.** Apply the answer and keep working until the next genuine fork,
   then call again. One call per decision, for the rest of the session.

## Writing the question for the ear

The call is spoken, and the user is walking, driving, or half-listening. Write
what the assistant says the way the morning brief does — context, then the
question, last:

- **One or two sentences of context first.** What it is, and why it needs them.
  They have not seen their screen since they left.
- **Then the one question, with named options.** "Ship it behind a flag, or
  hold the whole PR until the migration lands?" beats "how should I handle
  this?".
- **Say what you will do with each answer**, briefly, so a one-word reply is
  enough: "if you say hold, I leave the branch and move on."
- Keep it under about a minute of talking. If you have several decisions
  waiting at once, put them in **one call** as two or three items, not three
  separate calls — it is their phone, and their credit.

The assistant on the call has no tools and takes no action; it only relays your
question and collects their answer. You are the one who acts on it, here.

## When the call does not connect

A call can go to voicemail, be declined, or time out. `screenless call` reports
this — a `voicemail` flag, a `failed` status, or an empty transcript. When it
happens:

- **Try once more** if the work genuinely cannot proceed without the answer.
- If it still does not connect, **do not guess on something irreversible.** Do
  the reversible parts you can, leave the blocked decision clearly marked, and
  stop with it written up for when they return — the normal behaviour, which is
  the safe fallback when the phone is the thing that failed.
- If `screenless call` errors because the account is not set up or out of
  credit, say so plainly and fall back to stopping with the question. Do not
  loop retrying a call that cannot be placed.

## Ending the mode

When the user says they are back — or answers a call by saying so — stop
placing calls and return to asking in the terminal. Give them a short catch-up
of what you decided while they were gone and what each call settled, so the
first thing they see is the trail of choices made in their absence.

## What this does not change

- You still exercise judgement about what is worth interrupting them for. AFK
  is not licence to phone them about everything; it is permission to phone them
  about the few things that would otherwise have stalled until they got back.
- You still never take an irreversible action they did not sanction. The call
  is how you get the sanction — it is not a substitute for it.
