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
