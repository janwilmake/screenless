# Session 16 — call back instead of a PIN, and WhatsApp on the same number

author: Jan Wilmake, via Claude Code

What landed:

- **Ring-back instead of answering.** A member's phone call to the line is
  answered with `<Reject reason="busy"/>` (free for the caller) and, two
  seconds later, the line dials their *verified* number from the user row —
  never the caller id. What they hear on pickup (GPT-Live with their watcher,
  a shared brief, or the quiet ear) is decided at answer time in
  `/texml/ring-back/:id`. At most six ring-backs per member an hour, so a
  spoofer cannot make the owner's phone ring all night.
- **WhatsApp on the same number.** Telnyx routes WhatsApp calls into TeXML
  (launched April 2026). They get their own route, `/texml/whatsapp?t=…`,
  signed, meant for a second TeXML application chosen on the number's
  WhatsApp Calling tab. Trust comes from that URL, not from anything in the
  call a caller could set: Telnyx documents no field that marks a call as
  WhatsApp. Answered at once, full rights. `normalizeCallerId` now strips
  `whatsapp:` / `sip:` forms. A WhatsApp call that lands on the phone URL
  instead just gets rung back over the phone, which is the safe miss.
- **The PIN architecture is gone**: `pin.ts`, `keypad.ts`, their tests, the
  PIN and attestation in settings and `screenless settings --pin`, the voice's
  PIN note, the held-back caller audio, and per-request modes. The gate and
  its two modes stay: `full` for the owner's call, `restricted` for test rings
  and the brief fork.
- Test rings are answered directly (there is nobody to ring back), restricted.

- **WhatsApp, as it turned out.** Jan did Meta's signup (code by voice,
  forwarded to his mobile). Telnyx's calling tab offers no route for
  WhatsApp: calls go to the number's own TeXML application, so the signed
  `/texml/whatsapp` URL and its token were removed again. A real WhatsApp
  call showed `FromSipUri …@wa.meta.vc` and Meta's `SipHeader_x-wa-meta-*`
  headers; `viaWhatsApp` requires the domain and the number's WhatsApp id
  (`WHATSAPP_PHONE_NUMBER_ID`) together. A phone call has neither.

- **People on the team page, levels in the file.** Jan: emails in the repo
  file are awkward in open source, and settings split between the page and
  the file. Agreed after three questions (custom levels must stay; how is a
  level assigned; how does the page know a repo's levels): the file defines
  levels and rules with no people; the team page assigns each member a level
  by name (`line_level`, a team default, a change log); watchers report
  their file's level names on every poll, kept a month per repo, which is
  how the page offers them. A name a repo does not define gets its default.
  `callers:` still decides for an unassigned caller and only narrows an
  assigned one. `screenless team level` and `GET /org/level` (for watchloop)
  read and set the same.

Still open:

- WhatsApp needs Meta embedded signup on the number in Mission Control (a
  consent screen for Jan, not an agent), then a TeXML application with the
  WhatsApp URL from `GET /admin/inbound-url`. Whether Telnyx lets the WhatsApp
  connection point at a different TeXML app than the phone number is not
  confirmed from the docs.
- ~~The PIN columns still in production~~ — dropped on Jan's yes.
- The WhatsApp URL's `t` is its own secret, `WHATSAPP_VOICE_TOKEN`, so it
  could be set up without the session secret. The TeXML application
  `screenless-whatsapp` was prepared in the portal; Jan pastes the two URLs
  (tokens are his to enter) and does Meta's signup himself. 085 numbers take
  no SMS, so Meta's code comes by voice: `/admin/forward-strangers` puts
  non-member calls through to a member's phone for up to half an hour.
- The quiet ear says nothing on pickup, so a ring-back with no watcher is
  silent when answered, as a ring-in was.

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
