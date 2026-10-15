/**
 * One Durable Object per live GPT-Live call: the line to the caller's own
 * Claude Code session.
 *
 * Telnyx streams the call's audio here over a WebSocket (8 kHz mu-law, both
 * ways), and this object relays it to a GPT-Live session over OpenAI's own
 * WebSocket, which takes and returns the same phone audio. (GPT-Live over SIP
 * would skip the relay, but inbound SIP for Live is gated per project.) The
 * voice's output is a real-time stream, so it is passed straight through;
 * nothing is buffered here that could keep talking over a caller.
 *
 * What is new is client delegation: when the voice decides a request needs
 * the caller's machine, it emits `session.delegation.created`, and we park
 * that request here until the caller's `screenless watch` claims it. The
 * watcher runs it in a fork of the Claude Code session it was armed in and
 * posts the answer back, which goes to the voice as commentary to be spoken.
 *
 * The voice still has no tools and no credentials. The work happens on the
 * caller's machine, with the access they already gave it; the call only
 * stopped having to end first.
 *
 * The transcript is persisted on every finished line, like RealtimeCall, so
 * the finished call still reaches the watcher queue with everything said.
 */

import type { Env } from "./index";
import * as db from "./db";
import * as telnyx from "./telnyx";

/** What answerInbound parks for a live ring-in, read when the audio arrives. */
export interface LiveConfig {
  engine: "live";
  userId: string;
  instructions: string;
  greeting: string;
  voice: string;
  /** The TeXML call, to hang up when the voice ends first. */
  accountSid: string;
  callSid: string;
}

type Line = { role: "user" | "assistant"; text: string; at: string };

interface Handoff {
  id: string;
  /** What the caller said since the previous handoff: the request. */
  request: string;
  /** The last lines of the call, so the terminal can resolve "that" and "it". */
  context: string;
  at: number;
  claimed: boolean;
  answered: boolean;
}

/** A request nobody claims in this long gets a spoken "cannot reach your
 *  terminal". The watcher polls every few seconds, and long-polls once a call
 *  is live, so a connected terminal claims well inside it. */
const CLAIM_TIMEOUT_MS = 15_000;
/** How long one long-poll from the watcher is held open. */
const POLL_HOLD_MS = 20_000;

export class LiveCall {
  /** GPT-Live's WebSocket. */
  private ws: WebSocket | null = null;
  /** Telnyx's media stream: the caller's audio in, the voice's audio out. */
  private phone: WebSocket | null = null;
  /** Caller audio that arrived before GPT-Live was ready. */
  private early: string[] = [];
  private live = false;
  private ourCallId = "";
  private userId = "";
  private cfg: LiveConfig | null = null;
  private lines: Line[] = [];
  /** Transcript deltas of the current turn, until the speaker changes. */
  private buf: { role: "user" | "assistant"; text: string } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Index into `lines` up to which caller speech went into a handoff. */
  private handedOffUpTo = 0;
  private handoffs: Handoff[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/stream") return this.stream(req, url.searchParams.get("call") ?? "");
    if (req.method === "GET" && url.pathname === "/next") return this.next();
    if (req.method === "POST" && url.pathname === "/result") return this.result(await req.json());
    return new Response("not found", { status: 404 });
  }

  /* ------------------------------------------------------------ the audio */

  /** Telnyx connects its media stream; the GPT-Live session starts with it. */
  private async stream(req: Request, callId: string): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const raw = await db.stashGet(this.env, `realtime:${callId}`);
    if (!raw) return new Response("unknown call", { status: 404 });
    const cfg = JSON.parse(raw) as LiveConfig;
    this.ourCallId = callId;
    this.userId = cfg.userId;
    this.cfg = cfg;

    const pair = new WebSocketPair();
    const phone = pair[1];
    phone.accept();
    this.phone = phone;
    phone.addEventListener("message", (ev) => this.fromPhone(ev));
    phone.addEventListener("close", (ev) => {
      console.log("phone stream closed", callId, ev.code, ev.reason);
      void this.finish("phone");
    });
    phone.addEventListener("error", () => void this.finish("phone"));

    const res = await fetch("https://api.openai.com/v1/live/sessions", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${this.env.OPENAI_LIVE_API_KEY}` },
    });
    const ws = res.webSocket;
    if (!ws) {
      console.error("live connect failed", callId, res.status, await res.text().catch(() => ""));
      phone.close(1011, "voice unavailable");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    ws.accept();
    this.ws = ws;
    ws.addEventListener("message", (ev) => void this.onMessage(ev, cfg.greeting));
    ws.addEventListener("close", (ev) => {
      console.log("live socket closed", callId, ev.code, ev.reason);
      void this.finish("voice");
    });
    ws.addEventListener("error", () => {
      console.error("live socket error", callId);
      void this.finish("voice");
    });
    this.send({
      type: "session.start",
      session: {
        model: "gpt-live-1",
        instructions: cfg.instructions,
        audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: cfg.voice } },
        delegation: { type: "client" },
      },
    });
    await db.stashPut(this.env, `livecall:${cfg.userId}`, JSON.stringify({ callId }), 7200);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private fromPhone(ev: MessageEvent): void {
    let msg: { event?: string; media?: { track?: string; payload?: string } };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (msg.event === "media" && msg.media?.payload && msg.media.track !== "outbound") {
      if (this.live) this.send({ type: "session.input_audio.append", audio: msg.media.payload });
      else if (this.early.length < 250) this.early.push(msg.media.payload);
    } else if (msg.event === "stop") {
      void this.finish("phone");
    }
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* socket gone; the transcript is already persisted per line */
    }
  }

  private async onMessage(ev: MessageEvent, greeting: string): Promise<void> {
    let msg: {
      type?: string;
      delta?: string;
      delegation?: { id?: string; target?: string };
      error?: unknown;
      reason?: string;
    };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }

    switch (msg.type) {
      case "session.output_audio.delta":
        if (msg.delta) this.toPhone(msg.delta);
        break;
      case "session.started":
        this.live = true;
        for (const audio of this.early.splice(0)) this.send({ type: "session.input_audio.append", audio });
        // A phone that answers in silence reads as a dead line. Exact words,
        // as an instruction: GPT-Live has no "speak now" in client mode.
        this.send({
          type: "session.instructions.append",
          delegation_id: null,
          content: `Immediately say the following, exactly and in full, then wait for the caller: "${greeting}"`,
        });
        break;
      case "session.input_transcript.delta":
        this.delta("user", msg.delta ?? "");
        break;
      case "session.output_transcript.delta":
        this.delta("assistant", msg.delta ?? "");
        break;
      case "session.delegation.created":
        if (msg.delegation?.id) await this.delegate(msg.delegation.id);
        break;
      case "session.closed":
        console.log("live session closed", this.ourCallId, msg.reason ?? "");
        await this.finish("voice");
        break;
      case "error":
        console.error("live error", this.ourCallId, JSON.stringify(msg.error));
        break;
      default:
        if (msg.type && !msg.type.endsWith(".delta")) console.log("live event", msg.type);
    }
  }

  /** Transcript deltas carry no turn boundary; a change of speaker, or a
   *  pause, is what ends a line. */
  private delta(role: "user" | "assistant", text: string): void {
    if (!text) return;
    if (this.buf && this.buf.role !== role) void this.flush();
    if (!this.buf) this.buf = { role, text: "" };
    this.buf.text += text;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 2500);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const b = this.buf;
    this.buf = null;
    const text = b?.text.replace(/\s+/g, " ").trim();
    if (!b || !text) return;
    this.lines.push({ role: b.role, text, at: new Date().toISOString() });
    await this.persist();
  }

  private async persist(): Promise<void> {
    const rec = await db.getCall(this.env, this.ourCallId);
    if (!rec) return;
    rec.transcript = this.lines.slice();
    await db.putCall(this.env, this.ourCallId, rec);
  }

  /* ------------------------------------------------------------ delegation */

  /**
   * The voice decided this needs the caller's machine. The event carries no
   * text, so the request is what the caller said since the last handoff — on
   * a one-to-one phone call there is nobody else it could be from.
   */
  private async delegate(id: string): Promise<void> {
    // The caller's words may still be in the buffer when the voice decides.
    if (this.buf?.role === "user") await this.flush();
    const said = this.lines.slice(this.handedOffUpTo).filter((l) => l.role === "user").map((l) => l.text);
    const lastCaller = [...this.lines].reverse().find((l) => l.role === "user")?.text ?? "";
    this.handedOffUpTo = this.lines.length;
    const context = this.lines
      .slice(-12)
      .map((l) => `${l.role === "user" ? "Caller" : "Voice"}: ${l.text}`)
      .join("\n");

    const h: Handoff = {
      id,
      request: said.join(" ") || lastCaller,
      context,
      at: Date.now(),
      claimed: false,
      answered: false,
    };
    this.handoffs.push(h);
    this.wake();

    setTimeout(() => {
      if (h.claimed || h.answered || this.ended) return;
      h.answered = true;
      this.send({
        type: "session.commentary.append",
        delegation_id: h.id,
        content:
          "The caller's terminal is not connected right now, so this cannot be looked up during the call. It is in the transcript, and their session will pick it up after the call.",
      });
    }, CLAIM_TIMEOUT_MS);
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** The watcher's long-poll: unclaimed requests, or an empty list after a
   *  while. `ended` tells it to stop polling this call. */
  private async next(): Promise<Response> {
    const take = () => {
      const open = this.handoffs.filter((h) => !h.claimed && !h.answered);
      for (const h of open) h.claimed = true;
      return open;
    };
    let open = take();
    if (!open.length && !this.ended) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, POLL_HOLD_MS);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
      open = take();
    }
    if (open.length) {
      this.send({
        type: "session.thinking.append",
        delegation_id: null,
        content: `The caller's own Claude Code session picked up the request and is working on it. Results usually take 10 to 60 seconds; do not guess them.`,
      });
    }
    return Response.json({
      ended: this.ended,
      handoffs: open.map(({ id, request, context, at }) => ({ id, request, context, at })),
    });
  }

  /** A result, or a progress note, from the caller's terminal. */
  private async result(body: unknown): Promise<Response> {
    const { id, text, final } = (body ?? {}) as { id?: string; text?: string; final?: boolean };
    const h = this.handoffs.find((x) => x.id === id);
    if (!h || typeof text !== "string" || !text.trim()) return new Response("bad result", { status: 400 });
    if (this.ended) return Response.json({ ok: false, ended: true });
    // About 500 tokens is the cap per append; a spoken answer is far shorter.
    const content = text.trim().slice(0, 1800);
    if (final !== false) {
      h.answered = true;
      this.send({ type: "session.commentary.append", delegation_id: h.id, content });
    } else {
      this.send({ type: "session.thinking.append", delegation_id: h.id, content });
    }
    return Response.json({ ok: true });
  }

  private toPhone(payload: string): void {
    try {
      this.phone?.send(JSON.stringify({ event: "media", media: { payload } }));
    } catch {
      /* the caller hung up */
    }
  }

  /** The call is over, from either end. When the voice ended first, the
   *  phone call is hung up too, or the caller sits in silence. */
  private async finish(by: "phone" | "voice"): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.send({ type: "session.close" });
    if (by === "voice" && this.cfg?.callSid && this.cfg.accountSid)
      await telnyx.hangupTexmlCall(this.env.TELNYX_API_KEY, this.cfg.accountSid, this.cfg.callSid).catch(() => {});
    try {
      this.phone?.close(1000, "done");
    } catch {
      /* already closed */
    }
    await this.flush();
    if (this.lines.length) await this.persist();
    await db.stashDelete(this.env, `livecall:${this.userId}`).catch(() => {});
    this.wake();
    this.ws = null;
  }
}
