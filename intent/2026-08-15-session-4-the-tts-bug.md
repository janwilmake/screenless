# Session 4 — the silent call was Telnyx's own TTS

The session that ended the silent-assistant bug. It had been open since session
1 and blocked every real call the product makes.

**What landed:** the fix — all ten languages now name an AWS or Azure voice
instead of a `Telnyx.Ultra` one — plus `telnyx-bug/`, holding a minimal
reproduction and a full API dump, and the outbound voice profile opened from
two countries to twenty-eight with a rate cap.

**The finding.** Telnyx-hosted TTS renders no audio on a PSTN call. Every
Telnyx voice is silent: `Telnyx.Ultra.*`, `Telnyx.Natural.*`, and the default
Telnyx picks when `voice_settings` is omitted — which is the same voice as the
portal's `Blank` assistant that works fine over WebRTC on this account. The
model was replying the whole time and its replies were being logged as
assistant turns; nothing rendered them. The first third-party voice tried
(`AWS.Polly.Joanna-Neural`) held a full conversation on the first attempt.

Telnyx support saw the mirror image without either side spotting what it meant:
*"only 2 TTS records for today, neither associated with a call session"*
alongside *"LLM inference is working — responses are being generated."* That
line is what turned the day around; the user read it and asked "can we change
the tts?"

**Where the session drifted, and it drifted badly.** Roughly nine hours went
into ruling out the model (two vendor families), the inference path (hosted and
`external_llm` against the user's own Anthropic key), the endpoint
(`/texml/ai_calls` and `/texml/calls`), the TeXML document (Telnyx's and ours),
the anchorsite, number assignment, callbacks, the assistant object, and the
caller (our code, bare curl, the portal's own button). Every one of those was
varied. `voice_settings` was varied too — but only ever between Telnyx-hosted
voices, so the one axis that mattered was held constant while everything around
it moved. The conclusion drawn from that — "platform-side, nothing left on our
side" — was right about the cause and wrong about the remedy, and it cost most
of a day.

**Also corrected in this session:** an eleven-item list of Telnyx API friction,
written up for outreach, was checked against the docs at the user's insistence
and roughly half of it did not survive. `StatusCallbackEvent` is documented
("Multiple events are separated by a space"); the US/CA default on outbound
voice profiles is documented verbatim; two more items were guesses at endpoint
names that were simply wrong. Four survived. The user asked the right question
— "r u sure the current code does the right thing according to docs?" — before
any of it was sent.

**Still open:** `ALLOWED_DESTINATIONS` is `"*"` in the Worker while the
outbound profile lists twenty-eight countries, so a caller outside them fails at
Telnyx with `D13` rather than getting a clear message from us. The NL number
`+31850835195` is still attached to a connection belonging to a deleted probe
assistant. Both are noted in TODO.

## Prompts

**18:32** ok whwts ntxt?

**18:34** 1.open up.

**18:41** do external llms tst

**18:47** sk-ant-… for anthropic. use antropic model instead
*(Anthropic API key pasted in chat, second key of the day after the Telnyx one.
Stored as Telnyx integration secret `anthropic`; both need rotating.)*

**18:55** i picked up. can u see the transcirpit and logs of it? open it in vscode

**19:02** pls revert to the thing where at least i ended up in the transcript. and
maybe start the call with a `<say>` xml without ai? and after i answer, start the
ai. then we have all 3

*(This is the best idea in the session. One call proving the audio path works
and the assistant does not, seconds apart on the same leg, replaced two
separate tests and became the reproduction in `telnyx-bug/`.)*

**19:10** i said hello a couple times. say xml said waht it should. ai said nothing.

**19:14** can u make a md document for the simplest way to reproduce the bug with
this example we just tried? its good. and put the full resonse in the same folder
(telnyx-bug)

**19:18** open it in a way i can see the md render

**19:22** is giving the voice required? should we try other voice? default one?

*(Answered by testing: omitting `voice_settings` makes Telnyx pick
`Telnyx.Ultra.f786b574`, the `Blank` assistant's voice. Still silent. This was
one question away from the answer — the instinct was right, the substitute was
still Telnyx-hosted.)*

**19:26** still quiet after the intro

**19:31** how is this been a error the whole day and its not on status.telnyx.com?
this should be rasied as critical issue, or do they not have any real customers?

**19:36** so how can i raise this issue better cuz i havent gottan any response yet

**19:40** what to write in slack? copy to clipboard

**19:52** *(pasted Telnyx support's reply: account healthy, 16 call records, LLM
inference working, "only 2 TTS records for today, neither associated with a call
session")* so the tts isnt working, can we change the tts?

*(The question that ended the bug.)*

**20:01** omg its owrking now. so their own voices not wrking?

**20:04** so lets pick the best one now for the main languages we wanna support,
dutch and english first. low latency

*(Answered by measuring `/v2/text-to-speech/speech`, three runs per voice.
English went to AWS Polly Joanna-Neural, ~300ms against Azure Ava's ~525ms.
Dutch kept Azure Fenna — ~396ms against AWS Laura-Neural's ~418ms is inside
run-to-run noise, and Fenna held the first working call. Polly's non-neural
voices are ~100ms faster and audibly worse. The measurement is time to render a
whole clip, not time to first audio in a stream, so it is a proxy.)*
