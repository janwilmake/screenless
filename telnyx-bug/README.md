# Telnyx AI Assistant: no audio on PSTN calls

An AI Assistant connected to an outbound PSTN call never speaks. The call
connects, media flows, speech-to-text transcribes the caller — and the
assistant produces zero turns, not even its greeting.

The same assistant works over WebRTC in the Telnyx portal.

**Status:** with Telnyx support, confirmed platform-side.

---

## Minimal reproduction

One call proves it. The TeXML document plays a plain `<Say>` and *then* connects
the assistant. The `<Say>` is audible; the assistant that follows it on the same
leg is silent.

That single call rules out the media path, the codec, TTS, and the connection —
all of them demonstrably work seconds before the assistant fails on the same
audio channel.

### 1. Create an assistant

```bash
curl -s -X POST https://api.telnyx.com/v2/ai/assistants \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "silent-repro",
    "model": "anthropic/claude-haiku-4-5",
    "instructions": "You are testing a phone system. Greet the person and ask how they are.",
    "greeting": "Hi, you are speaking with an AI assistant. Can you hear me?",
    "voice_settings": { "voice": "Telnyx.Ultra.00967b2f-88a6-4a31-8153-110a92134b9f" },
    "transcription": { "model": "deepgram/flux", "language": "en" },
    "privacy_settings": { "data_retention": true }
  }'
```

Keep two values from the response:

- `id` — the assistant id
- `telephony_settings.default_texml_app_id` — the TeXML app Telnyx auto-creates

### 2. Serve this TeXML

Any public URL returning:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="female" language="en-US">Test line. If you can hear this, audio works. Connecting the assistant now.</Say>
  <Connect><AIAssistant id="ASSISTANT_ID"></AIAssistant></Connect>
</Response>
```

### 3. Place the call

```bash
curl -s -X POST https://api.telnyx.com/v2/texml/calls/$TEXML_APP_ID \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "From": "+1XXXXXXXXXX",
    "To":   "+3XXXXXXXXXX",
    "Url":  "https://your-host/texml?id=ASSISTANT_ID"
  }'
```

Answer, wait for the `<Say>` to finish, then say "hello" a few times.

### 4. Observe

```bash
curl -s -H "Authorization: Bearer $TELNYX_API_KEY" \
  "https://api.telnyx.com/v2/ai/conversations?metadata->assistant_id=eq.ASSISTANT_ID&limit=1"

curl -s -H "Authorization: Bearer $TELNYX_API_KEY" \
  "https://api.telnyx.com/v2/ai/conversations/CONVERSATION_ID/messages"
```

**Expected:** an `assistant` turn carrying the greeting, then replies.

**Actual:** the caller hears the `<Say>` and nothing after it. The conversation
contains only `user` turns.

---

## Observed run

Call session `b4a58762-98d5-11f1-975f-02420a1f0b69`, 2026-08-15 18:18:32–18:18:52 UTC.

| | |
|---|---|
| `<Say>` | heard by the caller |
| `<Connect><AIAssistant>` | silent |
| STT | transcribed `"Hello. Hello."` |
| assistant turns | **0** |

The `<Say>` and the assistant share one leg, one connection and one media
session, seconds apart. Text-to-speech reached the caller's ear inside the very
call where the assistant could not.

Full API dump in [`evidence.json`](./evidence.json) — assistant config, TeXML
application, conversation, messages, insights and call record.

---

## Ruled out

Each changed in isolation; every one still silent.

| Variable | Tried |
|---|---|
| Model | `anthropic/claude-haiku-4-5`, `moonshotai/Kimi-K2.6` |
| Inference path | Telnyx-hosted **and** `external_llm` against our own Anthropic key |
| Voice | `Telnyx.Ultra.*` (Dutch), `Telnyx.Natural.astra` (English) |
| Language | `nl`, `en` |
| Endpoint | `/v2/texml/ai_calls/{id}`, `/v2/texml/calls/{id}` |
| TeXML document | Telnyx's own `/ai/assistants/{id}/texml`, and ours |
| Anchorsite | `Latency`, `Amsterdam, Netherlands` |
| Number assignment | assigned to the connection, and not |
| Callbacks | with and without `StatusCallback` / `ConversationCallback` |
| Assistant | ours, and `Blank` created by the Telnyx portal quickstart, unmodified |
| Caller | our code, bare `curl`, and the portal's own "Receive a call from your assistant" button |

Verified working alongside the failure:

- plain TeXML `<Say>` — same From/To/connection
- the assistant over WebRTC, in the portal
- the assistant over text — `POST /v2/ai/assistants/{id}/chat` returns a correct reply
- standalone TTS — `POST /v2/text-to-speech/speech`, same voice, valid MP3
- direct model invocation — `POST /v2/ai/chat/completions`
- `GET /v2/ai/assistants/{id}/texml` returns the expected `<Connect><AIAssistant>`
- assistant version is `main`; `enabled_features: ["telephony"]`
- account balance positive, destination country whitelisted on the outbound voice profile

## Notes

There is no error anywhere. The API returns `200 queued`, the call connects,
media streams bidirectionally at 24 kHz (confirmed by Telnyx support from the
call session events), STT runs — and no object in the system represents "the
assistant did not speak".

Telnyx's own insight engine describes the failure in prose after the fact —
one run produced *"the user's greeting was met with a long silence from the
system"*, another *"No messages found in conversation"* — but that never
surfaces as an error code, a webhook, or a field. Support's guidance was that
the absence itself is the diagnostic: *"the conversation logs showing only
[user] messages with no [assistant] messages is the key diagnostic indicator."*
