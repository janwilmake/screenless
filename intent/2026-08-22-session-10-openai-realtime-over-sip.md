# Session 10 — the voice moves to OpenAI Realtime over SIP

author: Jan Wilmake <jan@wilmake.com>

Wijnand tried OpenAI's new Realtime voice (the "advancing voice intelligence"
post — GPT-Realtime-2 / 2.1, voices Cedar and Marin) and found it ~3x better
than our current Telnyx AI Assistant voice (Deepgram STT → Claude Haiku → AWS
Polly / Azure Neural TTS). Decision: replace the conversational brain+voice with
OpenAI Realtime, cost no object. Telnyx stays for everything telephony — numbers,
PSTN dialing, verify/OTP, SMS, answering-machine detection, and per-minute call
duration for billing. Only the assistant leg changes.

Chosen shape (via the decision prompts): **SIP bridge** — Telnyx dials the user
and bridges the leg over SIP to `sip:<project>@sip-eu.api.openai.com;transport=tls`;
OpenAI terminates the media (that is where the quality and low latency come from);
our Worker stays a control plane. Voice **Marin**, model **gpt-realtime-2.1**.
Both **outbound and inbound** move to Realtime.

The one architectural rule survives: the phone assistant still has no tools, no
credentials, takes no action — we simply register no tools. It collects decisions
and hangs up; the loop on the user's machine still applies them.

Transcript capture changes: today we read the transcript from Telnyx's
conversation store after the call. With Realtime we capture it live over a
control WebSocket (`wss://api.openai.com/v1/realtime?call_id=...`) held in a
per-call Durable Object, then store it into the same D1 call record so
`screenless transcript --json`, billing and the watcher are unchanged.

## Prompts

- HH:MM — `wow i just tried https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/ and its like 3x better than our ccurrent one. curious: - which languages it supports - if we can use this instead in telnyx?`
  *(research: the post is OpenAI's Realtime (speech-to-speech) API — GPT-Realtime-2/2.1, GPT-Realtime-Translate (70+ in → 13 out languages), GPT-Realtime-Whisper; voices Cedar/Marin. Telnyx's own TTS list does NOT include OpenAI, so no drop-in voice swap; to use OpenAI you bridge Telnyx telephony to OpenAI Realtime, either media-stream WebSocket or SIP.)*

- HH:MM — `i 100% want this, no matter howw much it costs. so what do you need? i want to go for path b now`
  *(go: replace the Telnyx assistant with OpenAI Realtime. Answered with the two blockers — an OpenAI key/project with Realtime+SIP enabled, set as a Worker secret; and a webhook secret from registering our endpoint — plus three design choices.)*

- Decisions (via question prompts): voice **Marin**; scope **outbound + inbound both live**; approach **SIP bridge** (over the media-stream relay).

- HH:MM — `also when a user calls to screenless, the realtime api should pick up, not just a blank recording. the default preprompt should be that 'the user is likely sending a feature request and doesnt need a conversation, so please stay quiet unless the user specifically asks you a question'`
  *(inbound is no longer a blind recording: OpenAI Realtime answers the ring-in, but with a quiet default prompt — assume the caller is dropping a feature request, stay silent unless they ask a direct question. So a ring-in still feels like leaving a request, but can become a real conversation if the caller engages.)*

- HH:MM — `i submitted the openai key but pls tell me what to do for the webhooik secret`
  *(OPENAI_API_KEY set as a Worker secret. The webhook signing secret comes from registering our endpoint URL in OpenAI's dashboard — so the endpoint is deployed first, the URL handed over, then the `whsec_` secret set via `wrangler secret put OPENAI_WEBHOOK_SECRET`. Endpoint deployed: `https://screenless.sh/webhooks/openai/realtime`, event `realtime.call.incoming`.)*

- HH:MM — `ensure to clean up all the telnix assistant shit, that was terrible`
  *(the Telnyx AI Assistant — createAssistant/deleteAssistant/initiateAiCall, the /texml/assistant plumbing, the per-language Polly/Azure voice table, ASSISTANT_MODEL/ASSISTANT_VOICE — all to be deleted. Sequenced as the FINAL step: only after the OpenAI Realtime path is built and proven on a real call, so the line is never left without a working voice. Until cutover the Telnyx assistant stays as the fallback behind VOICE_ENGINE.)*

- HH:MM — `gimme the url i need to use and which event type sfor the webhook`
  *(answered: URL above, event `realtime.call.incoming`.)*

## Progress

Foundation deployed behind `VOICE_ENGINE` (still "telnyx", so nothing changed
for live traffic yet): `src/openai.ts` (webhook verify, accept/reject, SIP + WS
URLs), `src/realtime.ts` (the `RealtimeCall` Durable Object that holds the
control WebSocket and writes the transcript into the call's D1 row), the
`/webhooks/openai/realtime` route, the DO binding + `v1` migration, and the
OpenAI vars. Per-call session config is parked in the `stash` table keyed
`realtime:<callId>` and read back by the webhook. Still to build: the outbound
Telnyx→SIP bridge (a TeXML app + `startCall` OpenAI branch that stamps the
`X-Screenless-Call` SIP header) and the inbound branch (`/texml/inbound` returns
the SIP bridge with the quiet preprompt); then flip the flag, test, and delete
the Telnyx assistant.

Bridge built and deployed (behind the flag): `telnyx.initiateTexmlCall`,
`startCallOpenAI` (outbound, parks the brief, stamps the correlation header),
the `/texml/openai-bridge/<id>` route, the inbound branch in `answerInbound`
(OpenAI answers ring-ins quiet), the `finishInbound` fix (a ring-in is
substantial when it has a transcript), and `INBOUND_QUIET_INSTRUCTIONS`. Webhook
confirmed registered in the right project (URL + `realtime.call.incoming`).

Follow-ups: the **Telnyx TeXML app id** (`TELNYX_TEXML_APP_ID`) is still needed
for OUTBOUND (portal login would not drive from automation) — inbound needs it
not, so inbound is tested first; the **OpenAI org is unverified** (if the test
fails on model access, that is the fix); and the **language config removal**
(`languages.ts`) is agreed, to be done at cutover with the Telnyx-assistant
deletion, keeping only a small per-user language hint in the outbound prompt.

- HH:MM — `the language config can completely be removed i guess now that we have this realtime thing with multilanguage right/ ??? if u agree, do that too, put it on the todolist`
  *(agreed; on the cutover todo above.)*

## Getting the first call to work (a chain of four fixes)

Inbound was flipped to `openai` and tested with real calls. It failed several
times; each failure taught one thing (browser-driven diagnosis on the OpenAI and
Telnyx dashboards, both logged in by the user):

1. **First OpenAI account was unverified** → switched to a new account
   (`proj_5gS42My5zyUg993fkLpZK2kM`); new API key + webhook secret set by the user.
2. **Telnyx returned 480 / no OpenAI webhook** — the Telnyx SIP Call Flow tool
   showed the inbound leg getting `480 Temporarily Unavailable` in ~200ms. Root
   cause: the `screenless-inbound` TeXML app (id `3027023992306271718`, now
   `TELNYX_TEXML_APP_ID`) had **no Outbound Voice Profile** assigned, so every
   outbound call — including the `<Dial><Sip>` to OpenAI — was blocked. Assigned
   the Default (Global) OVP in the portal.
3. **`accept` 404 "No session found for the provided call_id"** — the webhook
   now fired, but I was using the **EU SIP host** (`sip-eu`) against a **US
   project**, so the session lived EU-side while `accept` hit `api.openai.com`
   (US). EU residency needs a project *created* in the Europe region; switched
   the SIP host to the US default (`sip.api.openai.com`) so SIP + API + accept
   are all US-consistent. Call connected.
4. **Marin talked during quiet mode, and the caller's words were not captured**
   — the DO's late, wrong-shaped `session.update` never took, so the model
   auto-responded; and input transcription was off. Fixed in the **accept**:
   `audio.input.turn_detection.create_response=false` for quiet mode (silent
   from the first moment), and `audio.input.transcription` always on (a ring-in
   exists to capture the *caller*).

Proven on a real call: caller's request captured, Marin silent unless asked a
direct question, transcript in the D1 call row, call billed and completed.

Still open: **EU latency upgrade** — blocked for now: OpenAI EU data residency
is gated (eligibility / enterprise, not a self-serve project option — only
"Global" appears when creating a project). Staying on US (~150-200ms slower from
NL, but the test call felt good). If eligibility is granted later: create a
Europe-region project, flip SIP host → `sip-eu.api.openai.com` and the API base
→ `eu.api.openai.com`. Also open: the **cutover** (delete the Telnyx assistant + `languages.ts`
once outbound is also proven on Realtime); minor quiet-mode question-detector
over-eagerness on whisper fragments.

## Tuning the call, on real ring-ins

With the line working, four rounds of live feedback shaped the behaviour:

- **`i still want to be able to interrupt the ai myself though`** — I had killed
  speakerphone echo by setting `interrupt_response:false`, which also killed
  barge-in. Wrong trade, reverted: interruption stays on, and echo is handled by
  `far_field` noise reduction (I had wrongly used `near_field`, which is for
  handsets) and a firmer threshold.
- **`i want it to be a conversation after the first question, until i say
  something about it ending`** — quiet mode is now only the opening posture. The
  first question latches the call into normal turn-taking; a narrow sign-off
  list ("that's all", "please just listen", "dat was het") drops it back to
  silent listening. Every reply is triggered by the Durable Object, and the
  session never auto-responds, so a server-generated reply and ours can never
  race — that race is what once left the assistant mute mid-call.
- **`after i interrupted, the ai never spoke again`** — my bug: the `speaking`
  guard was cleared only by `response.done`, but an interruption *cancels* the
  response, so the flag stuck forever. Now cleared on every ending
  (done/cancelled/incomplete/failed/error) and when the caller starts speaking.
- **`after she said 2 words she never spoke again`** — solved by instrumenting
  rather than guessing: logging the session's own events showed every reply
  ending `cancelled / turn_detected`. `server_vad` reacts to audio *energy*, so
  on speakerphone the assistant's own echo read as the caller taking the turn.
  Switched to **`semantic_vad` (eagerness: low)**, which judges intent to take
  the turn: echo does not qualify, a deliberate interruption does. Next call
  logged zero cancellations, and the transcript shows the full intended
  behaviour — answered when asked, went quiet on "please just listen", captured
  the request in silence, answered again, survived an interruption.

The **single ring after pickup** is unfixed and deliberately left alone: two
attempts made it worse (`answerOnBridge="false"` killed the media path outright;
a leading `<Pause>` changed nothing) and both are recorded in a comment so they
are not retried. It is cosmetic; the fixes cost working audio.

Cost measured on the new key: ~$0.11 over ~3.8 connected minutes ≈ **3¢/minute**
for OpenAI Realtime, against the 30¢/minute charged — margin is intact.

## The cutover

- HH:MM — `outbound works perfectly except for a single beep at pickup. now we can remove the telnyx stuff and languages`
  *(outbound proven on Realtime, so the fallback is no longer needed. Deleted:
  the whole Telnyx AI Assistant path (createAssistant/deleteAssistant/
  initiateAiCall/setAnchorsite/deleteTexmlApplication, the conversation +
  transcript endpoints, `/texml/assistant`, `captureTranscript`,
  `cleanupAssistant`), the recorded-request ring-in path (`inboundRecorded`,
  `transcribeAudio`, the `<Record>` TeXML), the `VOICE_ENGINE` flag and its
  branches, `ASSISTANT_MODEL`/`ASSISTANT_VOICE`, and `languages.ts` entire —
  with language removed from settings, briefs, the `/settings` catalogue, the
  CLI's setup picker, `screenless call --lang` and the help text. The Realtime
  voice is natively multilingual and switches mid-sentence, so a language
  setting is a thing that can only be wrong. telnyx.ts went from ~400 lines to
  204 and now does only what Telnyx is still for: verify, SMS, and dialling.)*

- HH:MM — `btw pls do a fun test wher it makes a fun convo with me (outbound call)`
  *(placed as the post-cutover regression test, so the fun call doubled as the
  proof that outbound still works with all the old code gone. First attempt was
  hung up by answering-machine detection — a false positive worth watching.
  Second connected: 74s, warm and funny, and it stayed inside the architectural
  rule while joking about it — "I'll just keep hanging out in the phone line,
  quietly not taking any actions".)*

- HH:MM — `great. just 1 more ask: is there a clearer voice with realtime 2.1 that's just as fast?`
  *(yes — Cedar. Voice does not affect latency at all: speed is the model
  generating audio tokens, not which voice renders them. Cedar and Marin are the
  two newest Realtime-exclusive voices and the only ones worth considering; the
  older eight (alloy, ash, ballad, coral, echo, sage, shimmer, verse) are a
  generation behind and several are unsupported on realtime models. Cedar reads
  crisper where Marin is warmer — usually what "clearer" means on a phone.
  Switched and A/B'd by ear on a real call reading numbers and technical words
  ("pull request 1284 was merged at 3:45"), which is where a phone line blurs.
  Jan picked Cedar; it is live.)*

- HH:MM — `interesying, even thoughwe never talk about breakfast in 'call' it says enjoy ur breakfast.`
  *(a real leak, not a quirk: the outbound instructions still carried the
  morning-briefing framing from session 1 — "a phone call at breakfast", "the
  brief above is ordered hardest first", "items", "answer from the brief" — and
  that was applied to EVERY outbound call, including call-when-afk questions and
  anything a skill places. Backwards for a product where the morning brief is
  one skill among many. Rewritten to be prompt-neutral: how to be good on a
  phone (short turns, context before the question, never invent, let them steer,
  speak their language) with an explicit "do not invent a setting or occasion
  for the call — no assuming it is morning or that they are at breakfast". The
  specifics now come only from whoever placed the call.)*

- HH:MM — `also... it seems that the AMD happens falsely a lot. mahybe its because the beep in the beginning?`
  *(two of four outbound calls were answered by a human and hung up as
  "voicemail". Fixed by scope rather than by tuning a threshold: answering-machine
  detection now runs ONLY on the cron-placed brief — the one call nobody is
  waiting on — and not on calls a person asked for. The costs are wildly
  asymmetric: a false positive hangs up on a real person mid-hello and reads as
  broken, while a miss costs a few cents of talking to an answerphone. Omitting
  the AMD callback means Telnyx runs no detection at all on those calls.)*

- (on the verification call) `You don't need to confirm it like that every time like in all my exact words`
  *(the "confirm what you heard in their words" rule was being applied to every
  turn, so it parroted. Narrowed to decisions only — play back an actual
  decision in a few words, but answer ordinary replies with a "got it" and move
  on.)*

  Both fixes confirmed on a live call: it connected despite a deliberate pause
  (AMD no longer killing it) and mentioned no breakfast or morning — "it was
  great, much better now".

- HH:MM — `ensure to clean up all the telnix assistant shit` / `the language config can completely be removed` / `does that mean it is slower... how do i get the eu one` / `how much did this cost` / `u have 4 the same shells open`
  *(cleanup + language removal are on the cutover todo; US is ~150-200ms slower from NL than EU, EU needs a Europe-region project; the test calls cost ~$3.40 internal (30¢/min from the free credit) plus a few dollars of OpenAI Realtime; stray `wrangler tail` shells killed.)*
