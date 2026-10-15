# Session 15 — barge-in on live calls

author: Jan Wilmake (asked for it, and said a clear yes, on a phone call),
via the hyre loop session (Claude Code, unattended agent)

What landed:

- **The caller can talk over the voice.** The voice's audio reaches Telnyx
  faster than real time (the "speed" field of the `live turn` log), so
  Telnyx holds a queue, and GPT-Live over a primary WebSocket sends no
  interruption event: only WebRTC and SIP cut the audio by themselves, and
  OpenAI's docs leave dropping queued audio to the client. The call's
  Durable Object now sends Telnyx `{"event":"clear"}` on the media stream
  when the caller starts talking while voice audio is still queued.
- **Two triggers.** Six loud caller frames in a row (120 ms, the same
  loudness test as `callerSpeechAt`), so a click or line noise does not
  count; or the first `session.input_transcript.delta` of a caller line
  that holds real words. Each fires once per run or line.
- **Only while audio is queued.** `toPhone` keeps a rough end time of the
  queue (audio ms sent against wall clock); a clear goes out only before it.
- **Not during the PIN phase**, while the caller is keying.
- One `live barge-in` log line per clear: call, voice gen, trigger, queued ms.

Checked: worker typecheck and tests; the object bundled with esbuild and
driven with a fake phone socket — no clear with nothing queued, none at 5
loud frames, one at 6, none while a PIN is awaited, one on first words.

Still open:

- Not heard on a call yet. If GPT-Live keeps generating after the caller
  barges in, the rest of that answer still plays; the queue is what the
  clear removes.

## Prompt

> In ~/work/screenless (Cloudflare worker, worker/src/live.ts), add barge-in to live phone calls. The caller asked for this and gave a clear yes on a phone call. Today, when the caller talks over the voice, the audio we already sent to Telnyx keeps playing, so the caller hears the voice keep talking.
>
> Facts: GPT-Live (gpt-live-1) over a primary WebSocket sends NO interruption or speech-started event. Only WebRTC/SIP truncate audio on their own. The OpenAI docs say the client must drop the queued audio itself. We send the voice audio faster than real time (see measureOut, the "speed" field), so Telnyx holds a queue.
>
> Do this: when the caller starts talking while the voice audio is still playing (the first `session.input_transcript.delta` with real text, and/or caller loudness above a threshold via the existing loudness() in onPhone media handling, for a few frames in a row so line noise does not trigger it), send Telnyx `{"event":"clear"}` on the media stream WebSocket (this.phone). Track roughly when queued audio ends (audio ms sent vs wall clock) so you only clear while audio is still queued. Do not clear during the PIN/keypad phase. Add a log line for each clear. Keep it small and match the file's style and comments.
