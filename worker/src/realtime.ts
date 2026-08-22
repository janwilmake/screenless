/**
 * One Durable Object per live OpenAI Realtime call.
 *
 * Telnyx bridges the audio straight to OpenAI over SIP — we are never in the
 * media path. But the transcript is not stored anywhere we can fetch after the
 * fact the way the Telnyx conversation was, so we attach to the session's
 * *control* WebSocket (events only, not audio) for the duration of the call and
 * write each finished line into the same D1 call record the rest of the system
 * already reads. `screenless transcript --json`, billing and the watcher stay
 * unchanged.
 *
 * Two modes:
 *   - "lead"  (outbound briefs): the assistant drives. We tell it to open the
 *     conversation the moment the session is up.
 *   - "quiet" (inbound ring-ins): the caller is most likely dropping a feature
 *     request, so the model stays silent and only answers when actually asked a
 *     question. We turn off auto-responses and trigger one ourselves only when a
 *     caller turn reads as a direct question.
 *
 * Transcript is persisted incrementally, on every finished line, so a Durable
 * Object that is evicted mid-call still leaves a complete record behind.
 */

import type { Env } from "./index";
import * as db from "./db";
import { callSocketUrl } from "./openai";

interface StartBody {
  ourCallId: string;
  openaiCallId: string;
  mode: "lead" | "quiet";
  /** What the assistant says first, in lead mode. */
  greeting?: string;
}

type Line = { role: "user" | "assistant"; text: string; at: string };

export class RealtimeCall {
  private ws: WebSocket | null = null;
  private lines: Line[] = [];
  private ourCallId = "";
  private mode: "lead" | "quiet" = "quiet";

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const body = (await req.json()) as StartBody;
    this.ourCallId = body.ourCallId;
    this.mode = body.mode;

    // Outbound WebSocket from a Worker/DO: fetch with the Upgrade header, then
    // take the socket off the response.
    const res = await fetch(callSocketUrl(body.openaiCallId).replace(/^https?/, "https"), {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    const ws = res.webSocket;
    if (!ws) return new Response("no socket", { status: 502 });
    ws.accept();
    this.ws = ws;

    ws.addEventListener("message", (ev) => this.onMessage(ev, body.greeting));
    ws.addEventListener("close", () => this.finalize());
    ws.addEventListener("error", () => this.finalize());

    // In quiet mode, stop the model auto-responding to every turn; we trigger a
    // reply only when a caller asks something. In lead mode the defaults stand.
    if (this.mode === "quiet") {
      this.send({ type: "session.update", session: { turn_detection: { type: "server_vad", create_response: false } } });
    }

    return new Response("ok");
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* socket gone; the transcript is already persisted per line */
    }
  }

  private async onMessage(ev: MessageEvent, greeting?: string): Promise<void> {
    let msg: { type?: string; transcript?: string };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }

    switch (msg.type) {
      // The session is live. In lead mode, open the conversation.
      case "session.created":
      case "session.updated":
        if (this.mode === "lead" && greeting && !this.lines.length) {
          this.send({
            type: "response.create",
            response: { instructions: `Open the call now: ${greeting}` },
          });
        }
        break;

      // A caller turn was transcribed.
      case "conversation.item.input_audio_transcription.completed": {
        const text = (msg.transcript ?? "").trim();
        if (text) await this.record("user", text);
        // Quiet mode: answer only if this reads as a direct question.
        if (this.mode === "quiet" && looksLikeQuestion(text)) {
          this.send({ type: "response.create" });
        }
        break;
      }

      // An assistant turn finished speaking.
      case "response.output_audio_transcript.done": {
        const text = (msg.transcript ?? "").trim();
        if (text) await this.record("assistant", text);
        break;
      }
    }
  }

  private async record(role: "user" | "assistant", text: string): Promise<void> {
    this.lines.push({ role, text, at: new Date().toISOString() });
    // Persist on every line: an evicted DO still leaves a full transcript.
    const rec = await db.getCall(this.env, this.ourCallId);
    if (!rec) return;
    rec.transcript = this.lines.slice();
    await db.putCall(this.env, this.ourCallId, rec);
  }

  private async finalize(): Promise<void> {
    const rec = await db.getCall(this.env, this.ourCallId);
    if (rec && this.lines.length) {
      rec.transcript = this.lines.slice();
      await db.putCall(this.env, this.ourCallId, rec);
    }
    this.ws = null;
  }
}

/**
 * A cheap heuristic for "the caller asked me something". Realtime transcription
 * punctuates, so a question mark is the strong signal; a handful of leading
 * interrogatives (English and Dutch) cover the ones it drops.
 */
function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  if (text.includes("?")) return true;
  const first = text.toLowerCase().split(/\s+/)[0];
  return [
    "what", "why", "how", "when", "where", "who", "which", "can", "could",
    "should", "is", "are", "do", "does", "did", "will", "would",
    "wat", "waarom", "hoe", "wanneer", "waar", "wie", "welke", "kun", "kan",
    "moet", "zijn",
  ].includes(first);
}
