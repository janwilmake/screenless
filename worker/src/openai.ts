/**
 * The one OpenAI call that is not a voice session: transcribing a WhatsApp
 * voice note. Every voice (phone calls of every kind, meetings) is GPT-Live,
 * opened by live.ts and meeting.ts. OpenAI Realtime over SIP ran outbound
 * calls and unwatched ring-ins until session 21 and is gone.
 */

/**
 * A voice note's words. WhatsApp sends them as Ogg/Opus, which the
 * transcription endpoint takes as is; the language is whatever was spoken.
 */
export async function transcribe(apiKey: string, audio: ArrayBuffer, mime: string): Promise<string> {
  const ext = mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("wav") ? "wav" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime || "audio/ogg" }), `voice.${ext}`);
  form.append("model", "gpt-4o-transcribe");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String(((await res.json()) as { text?: string }).text ?? "").trim();
}
