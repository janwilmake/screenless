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
