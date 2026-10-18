# Session 16 — call back instead of a PIN, and WhatsApp on the same number

author: Jan Wilmake, via Claude Code

What landed (deployed, and pushed to main):

- **Ring-back instead of answering, no PIN.** A member's phone call is
  rejected as busy and the line dials their *verified* number two seconds
  later, never the caller id; at most six ring-backs an hour per member.
  `pin.ts`, `keypad.ts`, the PIN and attestation settings and columns are
  gone. Full rights on the owner's call; only test rings are restricted.
- **WhatsApp calls on the same number.** Jan did Meta's signup (the code came
  by voice, forwarded to his mobile by a temporary `/admin/forward-strangers`
  window). Telnyx gives WhatsApp calls no route of their own, so they are
  told apart by Meta's SIP domain (`wa.meta.vc`) plus the number's WhatsApp
  id in Meta's headers, and answered at once. Needed OPUS on the TeXML app.
- **Wideband audio**: L16 at 16 kHz from Telnyx, PCM at GPT-Live's 24 kHz,
  a windowed-sinc resampler between, instead of 8 kHz mu-law both ways.
- **Line levels on the team page** (people there, levels and rules in a
  people-free `.agents/permissions.md`, watchers reporting their level
  names), `screenless team level`, `GET /org/level` for watchloop.
- **Install by prompt**: "Install https://screenless.sh/llms.txt into this
  repo and invite my team." `llms.txt` is the agent's script; setup and email
  take their steps as flags; `screenless team invite` invites the company
  (Jan chose inviting everyone found over joining by domain).
- **WhatsApp chats**: one fork of the session per conversation, carried on
  with `--resume`, fresh after 30 minutes of quiet; screenshots and files
  read from disk, voice notes transcribed; 👀 when a live session has the
  message; queued with an instant reply when none is live. The webhook only
  takes Telnyx-signed messages, in Meta's shape. Sends name a messaging
  profile, because an 085 number cannot be put on one.
- **The landing page**, rebuilt around "Your team's questions, answered
  without you.", with a demo call (a teammate calling a developer's session,
  voiced with ElevenLabs, muted autoplay with a waveform, one subtitle at a
  time), what teammates ask, three steps, plain-words rules, an FAQ, and a
  hero that fits a 13-inch screen. README, `llms.txt`, GitHub description
  and the social card say the same. The greeting no longer calls Jan "Cody".

Still open:

- The WhatsApp business profile (photo, about, description) is filled in on
  Telnyx but not saved: waiting for Jan's yes.
- The unused `screenless-whatsapp` TeXML application and the
  `WHATSAPP_VOICE_TOKEN` secret: delete on Jan's yes.
- Not yet tried for real: the install prompt end to end, and a teammate
  calling or messaging through a level. Chats are free; whether to charge
  per message is undecided. Other coding agents (Codex first) are proposed.
- Watchers on other machines need the new CLI for chats and levels.
- If Telnyx stops honouring `messaging_profile_id` on WhatsApp sends, replies
  fail with 40305 again: the 085 number cannot carry a profile itself.
- The quiet ear says nothing when a ring-back with no watcher is answered.

## Prompt

Pasted first: an answer about an iPhone Action Button Shortcut that places a
WhatsApp call, ending

> On spoofing, you're right that a WhatsApp call is tied to the account, not
> to caller ID, so the number can't be faked the way a regular call can. The
> remaining risk is the account itself being taken over. It's worth having
> two-step verification enabled in WhatsApp on both ends.

then:

> check screenless. i wanna add whatsapp to telnyx on the same numbers, and i wanna still support regular calls but when they're inbound, apply a call-back strategy where it hangs up and calls you back immediately such that we dont have the risk of spoofing, and we can ciompltely remove the pin architecture.

> yes drop the columns. for whatsapp, pls use the browser to make it ready so i can accept terms etc. and i dont have a whatsapp business , do i need to make somethign for that? prepare it all for me so i can just hit the things you cant do

> ok saved . what now?

> i filled in +31850835195 but nobody called my number

> the thing is 850835195 is not my number, this is screenless i guesss? but i am not receiving screenless calls. so how am i supposed to verify then?

> nope look, they say they called

> ok the call came through i was just in silent mode. i fully went through the meta onboarding and telnyx said it connected succesfully. can you verify if its there now?

> i cannt find screenless in whatsapp

> ok i called it on whatsapp but it used the same callback pattern. that shouldnt be needed for whatsapp, just regular calls

> nice how can we set up a pfp for screenless in whatsapp? and maybe description?

> great.... called again, but no pickup

> cool it works now. but the audio quality isnt as crisp as i would expect for whatsapp calls. bit noisy. is it possible something makes the quality worse than it could be?

> yes build it pls , get the quality as high as possible everywhere

> nice nice. just 1 thing... for whatever reason, it thinks my name is cody. even though his name is cody. why?

> aight cool... so now wdyt of the screenless.sh landing? maybe its too complex. the main benefit is just making your claude code session accessible by your entire team over the phone, right?

> yes rewrite it, and deploy. also, let's put a demo phonecall instead of the terminal thingy can you make it using elevenlabs? api key should be in simstreet env

> cool open the 42-sec call in finder so i can hear it

> i can imagine the demo show as a visualization of the audio and it autoplays, and it  enables audio when clicking it. wdyt?

> also the readme and repo desc is outdated

> maybe one more change to the landingpage. i think itd be great to make clear it works from a phone line as well as whatsapp call (higher quality) and it works in claude code. btw, can we support other coding agents too? does this make sense?

> btw did we have 2 numbers for the phoneline? in that case , should we also have 2 whatsapp reigstrations? if so, tell me what to do

> the demo part of the landing takes a lot of space, maybe subtitles (one line at a time) makes more sense? also, i dont like the 3 tiles, maybe icons is better?

> you know... i think most devs will think 'my claude code app, or, my codex app already does that!' so why pay for a separate service? but the painpoint this is solving is different. don't let your team call you for every little question or thing, let them call your agent! then you remove yourself as the bottleneck and you get less interruptions as a dev, because claude code can handle a lot of questions. so it removes a painpoint for devs because they get less calls/huddles with ideas and small questions etc etc, and the rest of the team is empowered to get instant answers and actually get stuff done in the dev's claude. maybe we should lead with that

> hmmmmm, for open source repos, putting the emails in the file there is kinda annoying. is there another way? also i dont like how we have some settings in the screenless.sh/team page while others live in the file...

> yes build it. also, we should simplify installation: a prompt given to an agent like 'install screenless.sh/llms.txt into this repo and invite my team' which can be copied from the website, where this llms.txt explains to run the installer command as well as look into connected communication channels to find your teams' email adresses, and use the cli to invite them. the main option should be to invite the whole company, and this must also be easy over cli. the invited person fills in their phonenumber themselves, right? the communication mcp can also probably show who YOU are, so that can also be set up, but the only missing info is YOUR number and its verification, so that must be asked in the session. wdyt???

> B

> great! let's reaaaaaaaly think about nailing the landingpage now. suggest improvements

> 1 not yet 2 yes, and deploy without preview, i trust its gonna be better

> 'why not slack' is a great objection btw... and the truth is: slack IS very useful. and screenless just offers calls. adding slack is a bigger work and kinda hard, and i dont think its worth it now. but maybe its kinda low-hanging fruit though, to also add whatsapp chats. these could be routed to a claude code fork too, and answered, right? ideally also allowing screenshots and audio... the main question is though: does every msg become a new fork? or can we append to an existing fork? wdyt?

> yes build it like that, and deploy

> "Your team's questions, answered without you." is much more clear and powerful than "Let your team call your Claude Code, not you." which is ambiguous. so lets improve the headline. dont u think?

> hmmm i got no reply

> btw, when a msg is received by a live session, itd be great to put the eyes emoji for a new session, so its clear there's live... can this be done?

> ok ok!!!
>
> also:[screenshot of the hero on a 13" screen] this is good now but it doesnt fit in 1 view in a 13" screen. maybe give the headline more width so it fits in 2 lines , put the installer below the demo, ? idk.

> all works! cool! now... i think its done. wdyt?

> wdyt of screenless as a product. do you think it could grow to 10k mrr?

> closed laptop problem is already solved for me because my session runs on a server in finland... another solution is ensuring the laptop doesnt sleep. but maybe we should make a guide for this? yeah... definitely good to test in hyre now but im sure they'll gravitate more to slack as i also made my session available there (using watchloop https://github.com/janwilmake/watchloop)

> we dont have tag because tag doesnt have my logged in browser, which is a very big deal for us

> also interesting to see if we could be a good add on to things like t3code or grokbot or codex instead of claude... each has different specs. so pls launch some market research and report your findings in a md file and get back to me

> nope. i wanna know how we can market this and test if people would pay for it and use it. and i want you to drive it the coming weeks and get back to me with proof or disproof

> before starting. what would be your strategy to gather proof?

> i guess 50/m is an interesting pricing but how many minutes does it buy us (cost)?

> yes check the openai dashboard

> go with option 2 with 2 weeks free trial and $0.40 per minute after (up to 30 minutes in the free trial). implement that and deploy. and the landingpage shoul mention unlimited whatsapp too

> can u make a subagent that drives my browser to try and find buying signal on x? gimme a rundown of what you find.

> yes i think this makes a ton of sense. i dont wanna do this now but keep it in mind as a new product (give your session a seat on the team). the crazy thing is a lot of it is basically free, and the phone + whatsapp are nice add-ons. so lets write it up as claude-team-seat.md with how to proof and comparison to kylon. it could basically be watchloop and screenless combined into some new name.

> hyre already loves cody, and they've both been using it and see the advantage a lot , mostly in slack for.
>
> what would be logical pricing for a team? the stack is basically a server of $150/month, $200/month for claude code, and us. how much should we charge?

> $299 a month is big money, wow.

> add the pricing to claude-team-seat.md. I like $299.

> no managed seat, toorisky

> also interesting how this seat product could use hyre and be used in recruitment teams

> yes add it .
>
> cody is a coder, mark is marketeer.... what should we name the 'recruiter'? we can test it internally first :)

> cant it be Rec? or thats not a name? Rex?

> ok Rex it is, add it to the doc

> its interesting hyre charges per user, but with 'seat' we could charge per identity. maybe a per user business model works better

> yes replace it with per active user pricing
