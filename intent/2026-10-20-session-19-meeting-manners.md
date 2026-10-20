# Session 19 — meeting manners: arrive quietly, answer from the meeting, "On it." only when slow

author: Wijnand (wijnand@hyre.io), via Claude Code in the work session

The first real meeting after session 18 was a practice interview: the owner
asking a colleague the questions they expected the next day, with the bot
along to give feedback afterwards. What it showed, and what landed:

- **Leaving.** Recall already left 30 s after everyone else (it did, at
  20:57:58; the session first said otherwise). Added: a meeting nobody joins
  is left after 5 minutes (`noone_joined_timeout`, Recall's default is 20).
  A late `screenless meet --leave` on a meeting that had already ended woke a
  fresh Durable Object that did not know it had joined, and overwrote the
  delivered record as `failed`; a finished record now marks the object ended.
- **Arriving.** The bot no longer speaks its notice on joining; the chat
  message Recall posts is the notice. The skill and the privacy page say so.
- **Answering from the meeting.** Questions about the meeting's own
  conversation (what was said, a recap, feedback on an answer) are the
  voice's to answer from what it heard; it was told to delegate them, and a
  delegation carried only the last 40 lines. It now carries the whole
  transcript with speaker names, capped at 60k characters.
- **"On it."** The voice said it on every delegation, including "are you
  there?" and requests the watcher then refused. Now: greetings, small talk
  and questions about the bot are never delegated; a delegation is silent,
  and the object asks for "On it." only when no answer has come in 4 s. The
  watcher flags a refusal (`refused` on `/live/:id/result`), the voice
  answers what the meeting holds or says it is noted, and later requests by
  the same asker are settled in the object without the round trip. The
  refusal stays the watcher's call: only it reads the permissions file.

Still open: the owner was a **guest** in their own meeting (Meet gave a
display name only; a name counts only for a signed-in participant matching
exactly one member), so nothing could run for them. The finished meeting
went to the owner's **earliest-started watcher**, not the one that served it
live, and another terminal marked it done; the session recommends routing a
live call back to its serving watcher, not yet decided.

The prompts, verbatim (the colleague's name and the meeting link redacted;
this repo is public):

> get the latest version of screenless

> /screenless

> pls go into https://meet.google.com/[redacted]

> it is a call to prepare an interview [a colleague] has tomorrow, so im asking her questions that are likely gonna be asked to prepare. after the call i'd like your fedback

> i left the call. do you have the transcript/

> yes sent it away . it should auto leave if theres no other ppl for over 5 minutes or if everyone else lesaves

> btw also  i dont want the ai to say anything in a forced way when it arrives in the call, just a msg is sufficient.

> also it should always be able to answer things from the transcript right? doestnt that stay in context of gpt-live /???

> it says 'on it' a lot, is that hardcoded or smth?

The session proposed: (1) the call's rule against delegating greetings and
questions about the bot, in meetings too; (2) "On it." only when the work
takes a while.

> 1 yes 2 yes and 3: it shoudlnt say on it if it could know that a person would be refused, cant we put that into the context better somehow?

> pwd

> commit and push screnelss
