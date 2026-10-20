# Session 19 — meeting manners: arrive quietly, answer from the meeting, trust the room

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
  and only when no answer has come in 4 s does the object ask the voice to
  say, in its own words, what is being done for it (first a fixed "On it."). The
  watcher flags a refusal (`refused` on `/live/:id/result`), the voice
  answers what the meeting holds or says it is noted, and later requests by
  the same asker are settled in the object without the round trip. The
  refusal stays the watcher's call: only it reads the permissions file.

- **The room, not the name.** Recall gives no participant emails to bots
  made through the Create Bot API (checked on this meeting's own data:
  `email: null` for both, both signed in), and the owner was a guest
  because their account is named differently from their Google name.
  Rather than match names harder, the meeting is the unit:
  `screenless meet --purpose "<what for>" --trust listen|read|full`
  (default `read`). Anyone the meeting cannot tie to the team gets the
  room's level; a member it can keeps their own, never above the room's;
  Never lines and the personal file still narrow (`inRoom`,
  `cli/src/permissions.ts`). The purpose goes into the voice's rules, and
  at pickup a fork of the session writes a **room brief**: answer yourself,
  hand off (capabilities, never tool names), not here. It replaces the
  fork brief meetings used before, which was the owner's phone-call prompt
  and so asked for context the whole room would hear.

- **A call belongs to a session.** `calls.home` holds a hash of the Claude
  Code session that sent the bot (`meet` sends it) or that first picked up a
  live call; watchers report theirs (`watchers.session`). That session's
  watcher serves the call and is handed it when it ends, as long as one
  runs; otherwise routing is as before. The session id, not the watcher id
  or repo: a watcher gets a new id each time it re-arms, and an agent's
  working directory drifts.

Still open: the room brief and `--trust` are deployed but not yet tried in
a meeting; invites do not yet fill `--purpose` by themselves. The finished meeting
went to the owner's earliest-started watcher; fixed above, not yet seen in
a real meeting.

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

> btw it shouldnt only say 'on it' it should be more dynamic in what itll say when handing smth off

The session found Recall gives Google Meet bots no emails, and proposed
renaming the account, or linking the Google participant id, or Recall's
calendar integration.

> mmmmmm can you test if the model can ever see emails in a g'meet?

> i dont know, i dont quite like your proposals. i am looking for a very simple solution because most of the time the ppl in the meetings are trusted, but yea, as you said, we can't just rely on name, however, maybe we kinda can?

> oh wut? the bot doesnt get the exact name for every sentence said????

> what if the gpt live gets context about the purpose of the meeting and knows also the harness of the connected claude a bit such as connected mcps/clis and the context of the loop? based on the purpose of the meeting and harness info, we could also provide what to delegate and what not to delegate... not per speaker per se, but per room..? wdyt?

The session agreed, with one split: the voice's context decides what it
attempts, the room level enforced by the watcher decides what may run.

> yes build it, steps 1-3 plus --trust

> i think an important thing any remote worker should grasp after they get onboarded onto tools, is learning the way people communicate, the team and the relationships between ppl,  the context of the company, the meetings. 
>
> also, i think it should always prepare meetings beforehand instead of only at the start of the meeting; this could make a big difference in context given to gpt live. also after meetings, the meeting should be fed back into its skills / harness. right?
>
> i feel like any remote worker should do this after onboarding and maybe reflect on it every now and then too. also any remote worker would prep meetings and have post meeting reflection.
>
> makes sense right?
> ps. close screenless watcher here, cody is already watching

> 1. yes. and its ok to be crrepy and personal. and it shouldnt be readable by the ppl described as its basically the remote workers mind.
> 2. 100% we should give it the maximally useful context within the bounds of what gpt live can handle. how do we ensure the llm prepares meetings on time?
> 3. 100%. ok do the routing fix. 
> 4. how would this work in claude code? how do we architect this?
>
> i like your recommendations btw, some already answered some q's. we didnt productize remo really yet; where would we put the remo's files? would it be files on the server of the remo's watchloop and screenless watcher? or would we have a repo per remo? or maybe a drive or other type of knowledgebase? wdyt?
