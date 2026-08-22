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
  /** A reply is in flight. Guards against the echo of that reply, on a
   *  speakerphone, triggering another one on top of it. */
  private speaking = false;
  /** The assistant's last spoken line, to recognise its own echo. */
  private lastSpoken = "";
  /** Quiet mode only: the caller has engaged, so normal turn-taking is on
   *  until they sign off. */
  private conversing = false;

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

    // Quiet mode's "never auto-respond" is set in the accept call itself (so
    // there is no window where the model talks over a caller). Here the DO only
    // watches the transcript and, in quiet mode, triggers a reply when the
    // caller actually asks a question.
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
    let msg: { type?: string; transcript?: string; error?: unknown; response?: { status?: string; status_details?: unknown } };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }

    // The session's own complaints are the only window into why a call went
    // quiet; without them this is guesswork.
    if (msg.type === "error") {
      console.error("realtime error", this.ourCallId, JSON.stringify(msg.error));
    } else if (msg.type === "response.done" && msg.response?.status && msg.response.status !== "completed") {
      console.error(
        "realtime response ended",
        this.ourCallId,
        msg.response.status,
        JSON.stringify(msg.response.status_details),
      );
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
        if (!text) break;
        // On speakerphone the assistant's own voice comes back in and is
        // transcribed as if the caller said it. Drop anything that repeats
        // what we just said, so echo is neither recorded nor answered.
        if (this.echoOfOwnSpeech(text)) break;
        await this.record("user", text);

        if (this.mode !== "quiet") break;

        // Quiet mode is a starting posture, not a life sentence. The caller
        // opens by leaving a request in silence; the moment they actually ask
        // something, they have started a conversation, and having to phrase
        // every following turn as a question would be absurd. So the first
        // question latches into normal turn-taking, and only a clear sign-off
        // puts it back to silent listening.
        //
        // Every reply is triggered from here rather than by the server (the
        // session stays create_response:false for the whole call). One place
        // decides when to speak, so a server-generated response and ours can
        // never race — that race is what left the assistant mute mid-call.
        if (this.conversing) {
          if (endsConversation(text)) {
            this.conversing = false;
            break;
          }
          this.reply();
        } else if (looksLikeQuestion(text)) {
          this.conversing = true;
          this.reply();
        }
        break;
      }

      // An assistant turn finished speaking.
      case "response.output_audio_transcript.done": {
        const text = (msg.transcript ?? "").trim();
        if (text) {
          this.lastSpoken = text.toLowerCase();
          await this.record("assistant", text);
        }
        break;
      }

      // The reply ended — completed, cancelled, or failed. It must clear on
      // *every* ending, not just the clean one: an interruption cancels the
      // response, and gating the next reply on an event that never arrives
      // left the assistant mute for the rest of the call.
      case "response.done":
      case "response.cancelled":
      case "response.incomplete":
      case "response.failed":
      case "error":
        this.speaking = false;
        break;

      // The caller started talking, which cancels any reply in flight. Same
      // reasoning as above: treat it as the end of our turn.
      case "input_audio_buffer.speech_started":
        this.speaking = false;
        break;
    }
  }

  /**
   * Asks the model to answer the caller's last turn.
   *
   * `speaking` is only a de-duplicator for the moment between asking and the
   * audio starting; it is cleared on every way a response can end, including
   * cancellation, so a cut-off reply can never leave the assistant mute.
   */
  private reply(): void {
    if (this.speaking) return;
    this.speaking = true;
    this.send({ type: "response.create" });
  }

  /**
   * True when a "caller" transcript is really the assistant's own voice coming
   * back through a speakerphone. Compared loosely: the echo is transcribed
   * imperfectly, so a substantial overlap with what we just said is enough.
   */
  private echoOfOwnSpeech(text: string): boolean {
    if (!this.lastSpoken) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
    const heard = norm(text);
    const said = norm(this.lastSpoken);
    if (heard.length < 4) return false;
    if (said.includes(heard) || heard.includes(said)) return true;
    // Or: most of the heard words appear in what we just said.
    const saidWords = new Set(said.split(/\s+/));
    const words = heard.split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    const overlap = words.filter((w) => saidWords.has(w)).length / words.length;
    return overlap > 0.7;
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
 * "I am done talking with you" — what drops the session back to silent
 * listening after a conversation. Deliberately narrow: a false positive here
 * makes the assistant go mute mid-conversation, which reads as broken.
 */
function endsConversation(text: string): boolean {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  return [
    "that's all", "thats all", "that is all", "that's it", "thats it",
    "we're done", "were done", "i'm done", "im done", "nothing else",
    "stop talking", "be quiet", "stay quiet", "just listen", "no more questions",
    "dat was het", "dat is het", "klaar", "niks meer", "stil", "luister alleen",
  ].some((p) => t.includes(p));
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
