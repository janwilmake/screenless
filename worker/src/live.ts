/**
 * One Durable Object per phone call: every call on the line is GPT-Live,
 * relayed here. Most are the line to the caller's own Claude Code session;
 * some have no terminal behind them at all (`unwatched`): an outbound brief,
 * and a ring-in nobody's terminal is watching. Those collect and hang up, as
 * every call did before live handoffs.
 *
 * Telnyx streams the call's audio here over a WebSocket (L16 at 16 kHz, both
 * ways), and this object relays it to a GPT-Live session over OpenAI's own
 * WebSocket at its native 24 kHz, resampled in between (audio.ts). (GPT-Live over SIP
 * would skip the relay, but inbound SIP for Live is gated per project.) The
 * voice's output is passed straight through, but it arrives faster than real
 * time, so Telnyx holds a queue of it. Over a WebSocket GPT-Live does not cut
 * that queue when the caller talks over it (only WebRTC and SIP do), so we
 * clear it ourselves: see `bargeIn`.
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
 * The transcript is persisted on every finished line, so the finished call
 * still reaches the watcher queue with everything said.
 *
 * Either socket can drop while the phone call goes on: Telnyx reconnects its
 * stream, and GPT-Live's session can close under us. Neither ends the call.
 * A dropped voice is restarted with the call so far, a dropped phone stream
 * is waited for, and only the call itself ending sets `ended`. In Jan's call
 * of 15 October one of them dropped mid-answer: the call went on with a fresh
 * voice that greeted him again, while `ended` was already set — so the
 * watcher had stopped, requests went nowhere, and the hang-up after goodbye
 * was a no-op.
 */

import type { Env } from "./index";
import * as db from "./db";
import * as telnyx from "./telnyx";
import * as sip from "./sip";
import { afterCallEnded } from "./index";
import { ByteOrder, Resampler, decodePcm, encodePcm, meanAbs, PHONE_RATE, VOICE_RATE } from "./audio";
import { callerSaysBye, callerAsksHangup, voiceSaysBye, HANGUP_AFTER_MS, HANGUP_ON_REQUEST_MS } from "./farewell";

/** What the call's requests may do on the owner's machine. */
export type CallMode = "full" | "restricted";

/** What a ring-in parks for its live leg, read when the audio arrives. */
export interface LiveConfig {
  engine: "live";
  userId: string;
  /** `full` on the owner's own call, whose number is proven: the line rang
   *  them back, or they called over WhatsApp. `restricted` for a test ring:
   *  talk and read, the rest after the call. */
  mode: CallMode;
  instructions: string;
  greeting: string;
  voice: string;
  /** The TeXML call, to hang up when the voice ends first. */
  accountSid: string;
  callSid: string;
  /** Test rings only: the one watcher repo allowed to serve this call. */
  onlyRepo?: string;
  /** No terminal serves this call: an outbound brief, or a ring-in with no
   *  watcher. Nothing is handed off; the transcript goes to the queue. */
  unwatched?: boolean;
  /** How to open, as an instruction rather than exact words: a brief opens
   *  the way its prompt says. Used instead of `greeting`; with neither, the
   *  voice waits for the caller (a ring-in leaving a request). */
  opening?: string;
  /** The member whose session serves the call: the caller, or a teammate
   *  who shares their session's brief with the caller. */
  servedBy?: string;
  /** Set when the caller is not the session's owner: they hear its brief,
   *  and nothing they ask is run during the call, unless `run`: the owner's
   *  permissions file names them, and the watcher gates each request by it. */
  teammate?: { name: string; owner: string; email?: string | null; phone?: string; level?: string; run?: boolean };
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
  /** The voice session it was delegated in; its id means nothing to a later one. */
  voice: number;
}

/** A request nobody claims in this long gets a spoken "cannot reach your
 *  terminal". The watcher polls every few seconds, and long-polls once a call
 *  is live, so a connected terminal claims well inside it. */
const CLAIM_TIMEOUT_MS = 15_000;
/** How long one long-poll from the watcher is held open. */
const POLL_HOLD_MS = 20_000;
/** How long a dropped phone stream may take to reconnect before the call is
 *  taken as over. Telnyx's own status callback closes the record either way. */
const PHONE_GRACE_MS = 6_000;
/** Voice sessions restarted per call before giving up and hanging up. */
const MAX_VOICE_RESTARTS = 3;
/** The greeting and a progress update wait for this much quiet from the
 *  caller... */
const CALLER_PAUSE_MS = 700;
/** ...but the greeting no longer than this: a line that stays silent reads
 *  as dead. */
const GREET_WAIT_MAX_MS = 6_000;
/** A progress update is dropped rather than said once this stale. */
const UPDATE_WAIT_MAX_MS = 10_000;
/** Spoken progress updates per call at most this often; one sent sooner is
 *  passed on silently, so the voice can still use it when asked. A call that
 *  is all "still working" is worse than one that waits. */
const UPDATE_GAP_MS = 15_000;

/** Loud caller frames in a row (20 ms each) that count as talking over the
 *  voice. A click or a burst of line noise is shorter. */
const BARGE_FRAMES = 6;

/** Told to the voice of a call whose requests run restricted: a test ring. */
const RESTRICTED_NOTE =
  "This call is restricted. Their session can look things up and answer questions during the call, but anything that sends, changes, pushes or deploys waits for the session after the call. When a result says so, tell the caller it is queued for after the call.";

export class LiveCall {
  /** GPT-Live's WebSocket. */
  private ws: WebSocket | null = null;
  /** Telnyx's media stream: the caller's audio in, the voice's audio out. */
  private phone: WebSocket | null = null;
  /** Caller audio that arrived before GPT-Live was ready. */
  private early: string[] = [];
  /** Background notes that arrived before GPT-Live was ready. */
  private earlyNotes: unknown[] = [];
  private live = false;
  /** Which voice session is current; events of an older one are ignored. */
  private voiceGen = 0;
  private voiceRestarts = 0;
  /** The GPT-Live model this call runs on; falls back once if it never starts. */
  private liveModel?: string;
  private everStarted = false;
  /** The greeting is said once per call, never again after a reconnect. */
  private greeted = false;
  /** Every background note so far, replayed into a restarted voice. */
  private notes: string[] = [];
  private phoneGoneTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the caller's audio last carried speech, by its loudness. */
  private callerSpeechAt = 0;
  /** The caller's line noise, so a street does not count as talking. */
  private noiseFloor = 200;
  /** The voice has said something, so a late greeting would be odd. */
  private voiceSpoke = false;
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
  /** The caller's last line was a goodbye. */
  private callerBye = false;
  /** The caller asked to be hung up on. */
  private hangupAsked = false;
  /** When the voice last said goodbye: the caller's own goodbye may come
   *  just after it, transcribed a moment late. */
  private voiceByeAt = 0;
  /** Set after both said goodbye; the caller speaking again cancels it. */
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  /** When a progress update was last spoken. */
  private updateAt = 0;
  /** When the current voice session was asked for, and when its socket
   *  opened: its start-up cost, logged once it has started. */
  private voiceAskedAt = 0;
  private voiceOpenAt = 0;
  /** The voice's current turn, measured for the "live turn" log. */
  private turn: Turn | null = null;
  /** When the voice's output last carried speech. */
  private voiceVoicedAt = 0;
  /** When the last output chunk arrived. */
  private outAt = 0;
  /** When the voice audio sent to Telnyx so far ends playing, about. */
  private playsUntil = 0;
  /** Loud caller frames in a row (BARGE_FRAMES). */
  private loudRun = 0;
  /** The phone's L16 byte order, read off the caller's audio (audio.ts). */
  private order = new ByteOrder("be");
  /** The rate GPT-Live hears and speaks on this call: its native 24 kHz, or
   *  the phone's own 16 kHz, which it also takes, with nothing resampled. */
  private rate = VOICE_RATE;
  /** Caller audio up to the voice's rate, the voice's down to the phone's. */
  private up: { push(s: Int16Array): Int16Array } = new Resampler(PHONE_RATE, VOICE_RATE);
  private down: { push(s: Int16Array): Int16Array } = new Resampler(VOICE_RATE, PHONE_RATE);
  /** Audio sent to the current voice, in ms, and when: to map the voice's
   *  own `end_ms` of the caller's speech back to a wall-clock time. */
  private sentMs = 0;
  private sent: Array<[number, number]> = [];
  /** The end of the caller's last speech, in the voice's audio time, and
   *  when its transcript arrived. */
  private heardEndMs = -1;
  private heardAt = 0;
  /** The voice's recent output loudness. */
  private voiceLevel = 0;
  /** An outbound call GPT-Live dialled over SIP (sip.ts): its session id.
   *  The audio is not ours; only the sideband is. */
  private sipSession = "";
  private sipAnswered = false;
  /** Event ids already handled: an attach replays the last 3 seconds. */
  private seen = new Set<string>();
  /** Voice audio short of a whole 20 ms frame, sent with the next chunk. */
  private outRest = new Int16Array(0);

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/stream") return this.stream(req, url.searchParams.get("call") ?? "");
    if (req.method === "POST" && url.pathname === "/sip") return this.startSip(await req.json());
    if (req.method === "GET" && url.pathname === "/next") return this.next();
    if (req.method === "POST" && url.pathname === "/result") return this.result(await req.json());
    if (req.method === "POST" && url.pathname === "/context") return this.context(await req.json());
    if (req.method === "POST" && url.pathname === "/update") return this.update(await req.json());
    return new Response("not found", { status: 404 });
  }

  /* ------------------------------------------------------------ the audio */

  /** An outbound call over SIP: attach to its sideband, which carries the
   *  transcript, handoffs and call progress, while SIP carries the audio. */
  private async startSip(body: unknown): Promise<Response> {
    const { callId, sessionId } = (body ?? {}) as { callId?: string; sessionId?: string };
    if (!callId || !sessionId) return new Response("bad sip start", { status: 400 });
    const raw = await db.stashGet(this.env, `voice:${callId}`);
    if (!raw) return new Response("unknown call", { status: 404 });
    this.cfg = JSON.parse(raw) as LiveConfig;
    this.ourCallId = callId;
    this.userId = this.cfg.userId;
    this.sipSession = sessionId;
    this.liveModel = this.env.OPENAI_LIVE_MODEL || "gpt-live-1";
    return (await this.attachSideband()) ? new Response("ok") : new Response("no sideband", { status: 502 });
  }

  private async attachSideband(): Promise<boolean> {
    const gen = ++this.voiceGen;
    const res = await fetch(sip.sidebandUrl(this.sipSession), {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${this.env.OPENAI_LIVE_API_KEY}` },
    });
    const ws = res.webSocket;
    if (!ws) {
      console.error("sip sideband failed", this.ourCallId, res.status, await res.text().catch(() => ""));
      return false;
    }
    ws.accept();
    this.ws = ws;
    // Commands may go out at once: the session exists before the call is up.
    this.live = true;
    ws.addEventListener("message", (ev) => {
      if (gen === this.voiceGen) void this.onMessage(ev, this.cfg?.greeting ?? "");
    });
    ws.addEventListener("close", (ev) => {
      console.log("sip sideband closed", this.ourCallId, ev.code, ev.reason);
      if (gen !== this.voiceGen || this.ended) return;
      // The call may still be up: attach again once, else it is over.
      void this.attachSideband().then((ok) => (ok ? undefined : this.finish("phone")));
    });
    return true;
  }

  /** Telnyx connects its media stream; the GPT-Live session starts with it.
   *  A second connect for the same call is Telnyx reconnecting: the new
   *  stream replaces the old one and the conversation carries on. */
  private async stream(req: Request, callId: string): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const raw = await db.stashGet(this.env, `voice:${callId}`);
    if (!raw) return new Response("unknown call", { status: 404 });
    const cfg = JSON.parse(raw) as LiveConfig;
    this.ourCallId = callId;
    this.userId = cfg.userId;
    this.cfg = cfg;
    // Back after the grace ran out: the call was still going after all.
    this.ended = false;
    if (this.phoneGoneTimer) clearTimeout(this.phoneGoneTimer);
    this.phoneGoneTimer = null;
    // An evicted object starts empty; the stored transcript must not be
    // overwritten by a shorter one.
    if (!this.lines.length) {
      const rec = await db.getCall(this.env, callId);
      if (rec?.transcript?.length) {
        this.lines = rec.transcript.map((l) => ({ role: l.role, text: l.text, at: l.at ?? new Date().toISOString() })) as Line[];
        this.handedOffUpTo = this.lines.length;
        this.greeted = true;
      }
    }

    // Chosen once per call: a reconnected stream keeps its resamplers.
    if (!this.ws && !this.everStarted) {
      this.rate = Number(this.env.LIVE_AUDIO_RATE) === PHONE_RATE ? PHONE_RATE : VOICE_RATE;
      const same = { push: (x: Int16Array) => x };
      this.up = this.rate === PHONE_RATE ? same : new Resampler(PHONE_RATE, VOICE_RATE);
      this.down = this.rate === PHONE_RATE ? same : new Resampler(VOICE_RATE, PHONE_RATE);
    }

    const pair = new WebSocketPair();
    const phone = pair[1];
    phone.accept();
    const old = this.phone;
    this.phone = phone;
    try {
      old?.close(1000, "replaced");
    } catch {
      /* already closed */
    }
    phone.addEventListener("message", (ev) => this.fromPhone(ev));
    phone.addEventListener("close", (ev) => {
      console.log("phone stream closed", callId, ev.code, ev.reason);
      if (this.phone === phone) this.phoneLost();
    });
    phone.addEventListener("error", () => {
      if (this.phone === phone) this.phoneLost();
    });

    // Where this object runs decides the distance to Telnyx and to OpenAI.
    void fetch("https://cloudflare.com/cdn-cgi/trace")
      .then((r) => r.text())
      .then((t) => log({ ev: "live colo", call: callId, colo: /colo=(\w+)/.exec(t)?.[1] ?? "" }))
      .catch(() => undefined);
    // The round trip to OpenAI's US and EU hosts from here, the second of
    // two requests so the connection is warm: what the EU region would save.
    void Promise.all([rtt("https://api.openai.com/v1/models"), rtt("https://eu.api.openai.com/v1/models")])
      .then(([us, eu]) => log({ ev: "live rtt", call: callId, usMs: us, euMs: eu }))
      .catch(() => undefined);
    if (!this.ws && !(await this.connectVoice())) {
      phone.close(1011, "voice unavailable");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // A call no terminal serves is not offered to one.
    if (!cfg.unwatched) await this.announce();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Opens a GPT-Live session for this call: the first, or a replacement for
   *  one that closed while the caller was still on the line. */
  private async connectVoice(): Promise<boolean> {
    const cfg = this.cfg!;
    const gen = ++this.voiceGen;
    this.live = false;
    this.voiceAskedAt = Date.now();
    const res = await fetch("https://api.openai.com/v1/live/sessions", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${this.env.OPENAI_LIVE_API_KEY}` },
    });
    this.voiceOpenAt = Date.now();
    const ws = res.webSocket;
    if (!ws) {
      console.error("live connect failed", this.ourCallId, res.status, await res.text().catch(() => ""));
      return false;
    }
    ws.accept();
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      if (gen === this.voiceGen) void this.onMessage(ev, cfg.greeting);
    });
    ws.addEventListener("close", (ev) => {
      console.log("live socket closed", this.ourCallId, gen, ev.code, ev.reason);
      if (gen === this.voiceGen) void this.voiceLost();
    });
    ws.addEventListener("error", () => {
      console.error("live socket error", this.ourCallId, gen);
      if (gen === this.voiceGen) void this.voiceLost();
    });
    this.send({
      type: "session.start",
      session: {
        model: (this.liveModel ??= this.env.OPENAI_LIVE_MODEL || "gpt-live-1"),
        instructions: [cfg.instructions, cfg.mode === "full" || cfg.unwatched || (cfg.teammate && !cfg.teammate.run) ? "" : RESTRICTED_NOTE].filter(Boolean).join("\n\n"),
        audio: { format: { type: "audio/pcm", rate: this.rate }, output: { voice: cfg.voice } },
        delegation: { type: "client" },
      },
    });
    return true;
  }

  /** GPT-Live went away. With the caller still on the line that is a dropped
   *  session, not a goodbye: start another that knows the call so far. */
  private async voiceLost(): Promise<void> {
    this.ws = null;
    this.live = false;
    if (this.ended) return;
    // A session that never started on the newer model is most likely the
    // model refused; the caller is on the line, so the restart takes the old.
    if (!this.everStarted && this.liveModel !== "gpt-live-1") {
      console.error("live model never started, falling back", this.ourCallId, this.liveModel);
      this.liveModel = "gpt-live-1";
    }
    if (this.phone && this.voiceRestarts < MAX_VOICE_RESTARTS) {
      this.voiceRestarts++;
      console.log("live voice restarted", this.ourCallId, this.voiceRestarts);
      if (await this.connectVoice()) return;
    }
    await this.finish("voice");
  }

  /** The phone stream dropped. Telnyx reconnects a stream on a call that is
   *  still up, so wait for that before treating the call as over. */
  private phoneLost(): void {
    this.phone = null;
    if (this.ended || this.phoneGoneTimer) return;
    this.phoneGoneTimer = setTimeout(() => {
      this.phoneGoneTimer = null;
      if (!this.phone) void this.finish("phone");
    }, PHONE_GRACE_MS);
  }

  private fromPhone(ev: MessageEvent): void {
    let msg: { event?: string; media?: { track?: string; payload?: string }; start?: { media_format?: unknown } };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (msg.event === "media" && msg.media?.payload && msg.media.track !== "outbound") {
      if (!this.order.decided && this.order.observe(msg.media.payload))
        log({ ev: "live byte order", call: this.ourCallId, order: this.order.decided });
      const samples = decodePcm(msg.media.payload, this.order.current);
      const level = meanAbs(samples);
      this.noiseFloor = level < this.noiseFloor ? level : this.noiseFloor + (level - this.noiseFloor) * 0.01;
      if (level > Math.max(500, this.noiseFloor * 3)) {
        this.callerSpeechAt = Date.now();
        if (++this.loudRun === BARGE_FRAMES) this.bargeIn("loud", level);
      } else this.loudRun = 0;
      const up = this.up.push(samples);
      if (this.live) {
        this.sentMs += (up.length / this.rate) * 1000;
        this.sent.push([this.sentMs, Date.now()]);
        if (this.sent.length > 4000) this.sent.splice(0, 1000);
      }
      this.toVoice(encodePcm(up, "le"));
    } else if (msg.event === "start") {
      log({ ev: "live media format", call: this.ourCallId, format: msg.start?.media_format ?? null });
    } else if (msg.event === "stop") {
      this.phoneLost();
    }
  }

  /** Caller audio on its way to the voice. */
  private toVoice(payload: string): void {
    if (this.live) this.send({ type: "session.input_audio.append", audio: payload });
    else if (this.early.length < 250) this.early.push(payload);
  }

  /** Where the watcher finds this call, with the mode it runs in. */
  private async announce(): Promise<void> {
    const cfg = this.cfg!;
    await db.stashPut(
      this.env,
      `livecall:${cfg.servedBy ?? cfg.userId}`,
      JSON.stringify({
        callId: this.ourCallId,
        onlyRepo: cfg.onlyRepo,
        teammate: cfg.teammate?.name,
        // The watcher resolves the teammate's permissions by who they are.
        teammateEmail: cfg.teammate?.email ?? undefined,
        teammatePhone: cfg.teammate?.phone,
        // Their level on the team page, which the watcher reads against its
        // own permissions file.
        teammateLevel: cfg.teammate?.level ?? "",
        mode: cfg.mode,
      }),
      7200,
    );
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
      start_ms?: number;
      end_ms?: number;
      event_id?: string;
    };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }

    if (this.sipSession && msg.event_id) {
      if (this.seen.has(msg.event_id)) return;
      this.seen.add(msg.event_id);
      if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-500));
    }

    switch (msg.type) {
      case "transport.ringing":
        await this.setStatus("ringing");
        log({ ev: "sip ringing", call: this.ourCallId });
        break;
      case "transport.answered":
        this.sipAnswered = true;
        await this.setStatus("answered");
        log({ ev: "sip answered", call: this.ourCallId });
        if (!this.greeted) {
          this.greeted = true;
          this.greetWhenQuiet(greeting);
        }
        break;
      case "transport.failed":
        console.error("sip call failed", this.ourCallId, JSON.stringify(msg).slice(0, 300));
        await this.finish("phone");
        break;
      case "session.output_audio.delta":
        if (msg.delta) {
          this.voiceSpoke = true;
          const pcm = decodePcm(msg.delta, "le");
          this.measureOut(pcm);
          this.toPhone(this.down.push(pcm));
        }
        break;
      case "session.started":
        // Over SIP the session starts before anyone answers; the greeting
        // waits for `transport.answered`.
        if (this.sipSession) break;
        this.live = true;
        this.everStarted = true;
        log({
          ev: "live voice ready",
          call: this.ourCallId,
          gen: this.voiceGen,
          connectMs: this.voiceOpenAt - this.voiceAskedAt,
          startMs: Date.now() - this.voiceOpenAt,
          // Caller audio sent in one burst now, ahead of real time.
          earlyFrames: this.early.length,
        });
        // A new voice session counts its audio from zero; the early burst is
        // sent now, 20 ms a frame.
        this.sentMs = this.early.length * 20;
        this.sent = [[this.sentMs, Date.now()]];
        this.heardEndMs = -1;
        for (const audio of this.early.splice(0)) this.send({ type: "session.input_audio.append", audio });
        if (this.greeted) {
          this.resumeVoice();
          break;
        }
        for (const note of this.earlyNotes.splice(0)) this.send(note);
        this.greeted = true;
        this.greetWhenQuiet(greeting);
        break;
      case "session.input_transcript.delta":
        if (typeof msg.end_ms === "number" && msg.end_ms > this.heardEndMs) {
          this.heardEndMs = msg.end_ms;
          this.heardAt = Date.now();
        }
        // The first words of a caller line: they may be talking over the
        // voice. Not when they were said before it began: the end of a
        // question is transcribed half a second late, after the answer has
        // started, and taking it for an interruption cut every answer short.
        if (this.buf?.role !== "user" && msg.delta && !isNoise(msg.delta) && !this.saidBeforeVoice(msg.start_ms))
          this.bargeIn("words");
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
        // Over SIP the session is the call: it closing is the call ending.
        if (this.sipSession) await this.finish("phone");
        else await this.voiceLost();
        break;
      case "error":
        console.error("live error", this.ourCallId, JSON.stringify(msg.error));
        break;
      default:
        if (msg.type && !msg.type.endsWith(".delta")) console.log("live event", msg.type);
    }
  }

  /**
   * A phone that answers in silence reads as a dead line, so the voice is
   * told to greet. Exact words, as an instruction: GPT-Live has no "speak
   * now" in client mode. But not over the caller: on Jan's first call he was
   * still talking to someone in the room, and the greeting came out between
   * his words. So it waits for a pause, and is dropped if the voice has
   * already answered him by itself.
   */
  private greetWhenQuiet(greeting: string): void {
    const opening = this.cfg?.opening;
    if (!greeting && !opening) return;
    const gen = this.voiceGen;
    this.afterCallerPause(GREET_WAIT_MAX_MS, () => {
      if (gen !== this.voiceGen || this.voiceSpoke) return;
      this.send({
        type: "session.instructions.append",
        delegation_id: null,
        content: opening
          ? `Open the call now. ${opening} If the caller starts speaking, stop at once and listen.`
          : `Now say the following, exactly, then wait for the caller: "${greeting}" If the caller starts speaking, stop at once and listen.`,
      });
    });
  }

  /** Runs `fn` once the caller has paused, or after `maxMs` regardless. */
  private afterCallerPause(maxMs: number, fn: () => void, onTimeout?: () => void): void {
    const start = Date.now();
    const tick = () => {
      if (this.ended) return;
      if (Date.now() - this.callerSpeechAt >= CALLER_PAUSE_MS) return fn();
      if (Date.now() - start >= maxMs) return (onTimeout ?? fn)();
      setTimeout(tick, 100);
    };
    tick();
  }

  /** A replacement voice joins a call already under way: it gets the notes
   *  and the call so far, and picks up without greeting again. */
  private resumeVoice(): void {
    this.earlyNotes = [];
    for (const m of this.noteMessages(this.notes.join("\n\n"))) this.send(m);
    if (this.buf) void this.flush();
    const sofar = this.lines
      .slice(-30)
      .map((l) => `${l.role === "user" ? "Caller" : "You"}: ${l.text}`)
      .join("\n")
      .slice(-6000);
    for (let i = 0; i < sofar.length; i += 1600)
      this.send({
        type: "session.thinking.append",
        delegation_id: null,
        content: `${i ? "(continued) " : "The call so far, before your connection dropped:\n"}${sofar.slice(i, i + 1600)}`,
      });
    this.send({
      type: "session.instructions.append",
      delegation_id: null,
      content:
        "You are already in this call: your connection dropped for a moment and you are back. Do not greet the caller again. Say briefly that you dropped out for a second, then carry on where the call left off. Requests delegated before the drop are still running; their results will arrive as notes.",
    });
  }

  /** Transcript deltas carry no turn boundary; a change of speaker, or a
   *  pause, is what ends a line. */
  private delta(role: "user" | "assistant", text: string): void {
    if (!text) return;
    if (this.buf && this.buf.role !== role) void this.flush();
    if (!this.buf) this.buf = { role, text: "" };
    this.buf.text += text;
    // The caller speaking again cancels a pending hang-up, unless it is more
    // goodbye or a breath the transcriber wrote down ("[inhale]").
    if (role === "user" && this.hangupTimer && !closingWords(this.buf.text)) this.cancelHangup();
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
    // Both said goodbye, in either order; or the caller asked to be hung up
    // on, which needs no goodbye back. Noise lines change nothing.
    if (b.role === "user") {
      if (!isNoise(text)) {
        this.callerBye = callerSaysBye(text);
        this.hangupAsked = callerAsksHangup(text);
      }
      if (this.callerBye && Date.now() - this.voiceByeAt < 15_000) this.scheduleHangup(HANGUP_AFTER_MS);
      else if (this.hangupAsked) this.scheduleHangup(HANGUP_ON_REQUEST_MS);
    } else if (voiceSaysBye(text)) {
      this.voiceByeAt = Date.now();
      if (this.callerBye || this.hangupAsked) this.scheduleHangup(HANGUP_AFTER_MS);
    }
    await this.persist();
  }

  /** Both said goodbye: hang up once the caller has stayed quiet a moment.
   *  Checked again when it fires: words still being transcribed that are not
   *  goodbye mean the caller is talking. */
  private scheduleHangup(ms: number): void {
    this.cancelHangup();
    this.hangupTimer = setTimeout(() => {
      this.hangupTimer = null;
      if (this.buf?.role === "user" && !closingWords(this.buf.text)) return;
      console.log("live call hung up after goodbye", this.ourCallId);
      void this.finish("voice");
    }, ms);
  }

  private cancelHangup(): void {
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    this.hangupTimer = null;
  }

  /** A SIP call's status, which nothing else reports. Ending it bills it and
   *  hands it on, as the status webhook does for a relayed call. */
  private async setStatus(status: "ringing" | "answered" | "completed" | "failed"): Promise<void> {
    const rec = await db.getCall(this.env, this.ourCallId);
    if (!rec || rec.status === "completed" || rec.status === "failed") return;
    rec.status = status;
    if (status === "completed" || status === "failed") rec.endedAt = Date.now();
    if (this.lines.length) rec.transcript = this.lines.slice();
    await db.putCall(this.env, this.ourCallId, rec);
    if (status === "completed" || status === "failed") await afterCallEnded(this.env, this.ourCallId, rec);
  }

  /** Only the transcript: a whole-row write from here could undo the
   *  `completed` the end-of-call webhook wrote a moment before. */
  private async persist(): Promise<void> {
    await db.setCallTranscript(this.env, this.ourCallId, this.lines.slice());
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
    // Nobody to hand it to: say so at once rather than after the claim wait.
    if (this.cfg?.unwatched) {
      this.handedOffUpTo = this.lines.length;
      this.send({
        type: "session.commentary.append",
        delegation_id: id,
        // Said only when it fits: on 21 Nov the voice handed off an idea Jan
        // was describing, and announcing "nothing can be done during this
        // call" in the middle of it sounded hesitant and odd.
        content:
          "Nothing can be looked up or done during this call. Only if the caller asked for something to be done or looked up now, say in a few words that their agent picks it up from the transcript after the call. If they were describing an idea or answering you, say nothing about this and carry on the conversation. Never say anything was done.",
      });
      return;
    }
    // A teammate hears the brief; their requests are not run on the owner's
    // machine during the call. They reach the session afterwards, marked as
    // a teammate's, like any ring-in.
    if (this.cfg?.teammate && !this.cfg.teammate.run) {
      this.handedOffUpTo = this.lines.length;
      this.send({
        type: "session.commentary.append",
        delegation_id: id,
        content: `This is ${this.cfg.teammate.owner}'s session, and requests from teammates are not run during a call. Tell the caller it is noted: the session gets it after the call, from this call's transcript.`,
      });
      return;
    }
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
      voice: this.voiceGen,
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
      mode: this.cfg?.mode === "full" ? "full" : "restricted",
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
    if (final !== false) h.answered = true;
    if (h.voice !== this.voiceGen) {
      // Delegated to a voice that has since been replaced; the new one knows
      // no such delegation, so it is told in plain words.
      if (final !== false)
        this.send({
          type: "session.instructions.append",
          delegation_id: null,
          content: `The answer to the caller's earlier request ("${h.request.slice(0, 200)}") has arrived from their session. Tell them briefly, at the next natural pause: ${content}`,
        });
    } else if (final !== false) {
      this.send({ type: "session.commentary.append", delegation_id: h.id, content });
    } else {
      this.send({ type: "session.thinking.append", delegation_id: h.id, content });
    }
    return Response.json({ ok: true });
  }

  /**
   * A progress note the caller's session chose to say mid-request
   * (`screenless update`): "still working, I found X". Commentary, which the
   * voice paraphrases aloud, on the request's own delegation; OpenAI's
   * client-delegation guide allows several per delegation, and none of them
   * closes it, so the final answer still arrives and is said as usual. Not an
   * instruction: an instruction can cut the voice off mid-sentence. And not
   * over the caller: it waits for a pause, and is dropped if none comes soon.
   * Without an id it is about the latest request still running.
   */
  private async update(body: unknown): Promise<Response> {
    const { id, text } = (body ?? {}) as { id?: string; text?: string };
    if (typeof text !== "string" || !text.trim()) return new Response("bad update", { status: 400 });
    if (this.ended) return Response.json({ ok: false, ended: true });
    // A teammate hears the brief, not the owner's work in progress.
    if (this.cfg?.teammate && !this.cfg.teammate.run)
      return Response.json({ ok: false, error: "a teammate's call takes no updates" }, { status: 403 });
    const h = id ? this.handoffs.find((x) => x.id === id) : [...this.handoffs].reverse().find((x) => !x.answered);
    if (id && !h) return Response.json({ ok: false, error: "unknown request" }, { status: 404 });
    if (h?.answered) return Response.json({ ok: false, answered: true });
    const said = text.trim().replace(/\s+/g, " ").slice(0, 400);
    const content = `Still working on it; the full answer comes later. So far: ${said}`;
    // The voice that took the request is the only one that knows its id.
    const delegation_id = h && h.voice === this.voiceGen ? h.id : null;
    if (Date.now() - this.updateAt < UPDATE_GAP_MS) {
      this.send({ type: "session.thinking.append", delegation_id, content });
      return Response.json({ ok: true, spoken: false, reason: "an update was just said" });
    }
    this.updateAt = Date.now();
    this.afterCallerPause(
      UPDATE_WAIT_MAX_MS,
      () => {
        if (h?.answered) return;
        this.send({ type: "session.commentary.append", delegation_id: h && h.voice === this.voiceGen ? h.id : null, content });
      },
      () => this.send({ type: "session.thinking.append", delegation_id: h && h.voice === this.voiceGen ? h.id : null, content }),
    );
    return Response.json({ ok: true, spoken: true });
  }

  /**
   * Times one chunk of the voice's output, for the "live turn" log: how long
   * after the caller stopped talking the voice started, and whether its audio
   * arrives paced, in bursts, or with gaps that the phone hears as stutter.
   * A turn starts at the first chunk carrying speech after TURN_GAP_MS
   * without any, and ends once the speech has stopped that long.
   */
  private measureOut(pcm: Int16Array): void {
    const now = Date.now();
    const bytes = pcm.length * 2;
    const level = meanAbs(pcm);
    const voiced = level > 200;
    if (voiced) this.voiceLevel = this.voiceLevel ? this.voiceLevel * 0.8 + level * 0.2 : level;
    if (voiced && now - this.voiceVoicedAt > TURN_GAP_MS) {
      this.endTurn();
      // The caller's last loud frame came after the voice's last speech: this
      // turn answers the caller. Otherwise the voice spoke up on its own.
      const answers = this.callerSpeechAt > this.voiceVoicedAt && now - this.callerSpeechAt < 15_000;
      // Where the reply time goes, by the voice's own clock: when the speech
      // it transcribed ended (sent from here at `endAt`), when that
      // transcript arrived, and now, its first audio back.
      const endAt = answers ? this.wallFor(this.heardEndMs) : 0;
      this.turn = {
        startAt: now,
        replyMs: answers ? now - this.callerSpeechAt : null,
        fromHeardEndMs: endAt ? now - endAt : null,
        transcriptMs: endAt ? this.heardAt - endAt : null,
        chunks: 0,
        bytes: 0,
        minBytes: Infinity,
        maxBytes: 0,
        offFrame: 0,
        maxGapMs: 0,
        lastAt: now,
      };
    } else if (!voiced && this.turn && now - this.voiceVoicedAt > TURN_GAP_MS) {
      this.endTurn();
    }
    if (voiced) this.voiceVoicedAt = now;
    const t = this.turn;
    if (t) {
      if (t.chunks) t.maxGapMs = Math.max(t.maxGapMs, now - this.outAt);
      t.chunks++;
      t.bytes += bytes;
      t.minBytes = Math.min(t.minBytes, bytes);
      t.maxBytes = Math.max(t.maxBytes, bytes);
      // Whole 20 ms frames of 16-bit audio at the call's rate.
      if (bytes % ((this.rate / 50) * 2)) t.offFrame++;
      t.lastAt = now;
    }
    this.outAt = now;
  }

  /** When the voice's audio time `ms` was sent from here, or 0. */
  private wallFor(ms: number): number {
    if (ms < 0) return 0;
    const hit = this.sent.find(([a]) => a >= ms);
    return hit && Date.now() - hit[1] < 15_000 ? hit[1] : 0;
  }

  /** Logs the turn measured so far. Ids, counts and times only. */
  private endTurn(): void {
    const t = this.turn;
    this.turn = null;
    if (!t || !t.chunks) return;
    const wallMs = t.lastAt - t.startAt;
    // 16-bit samples at the call's rate.
    const audioMs = Math.round(t.bytes / ((this.rate * 2) / 1000));
    log({
      ev: "live turn",
      call: this.ourCallId,
      gen: this.voiceGen,
      rate: this.rate,
      replyMs: t.replyMs,
      // From the end of the speech the voice heard to its first audio here:
      // the way up, the voice's turn-taking and reply, the way down.
      fromHeardEndMs: t.fromHeardEndMs,
      // How long its transcript of that speech took to arrive.
      transcriptMs: t.transcriptMs,
      chunks: t.chunks,
      minBytes: t.minBytes,
      maxBytes: t.maxBytes,
      // Chunks that are not whole 20 ms frames.
      offFrame: t.offFrame,
      maxGapMs: t.maxGapMs,
      audioMs,
      wallMs,
      // Above 1: the audio came faster than it plays, and Telnyx queues it.
      // Near 1: paced in real time, so every late chunk is a gap on the line.
      speed: wallMs ? Math.round((audioMs / wallMs) * 100) / 100 : null,
    });
  }

  /** Voice audio to the phone, in whole 20 ms frames: Telnyx plays any
   *  chunk from 20 ms up, and a shorter tail waits for the next one. */
  private toPhone(samples: Int16Array): void {
    const all = new Int16Array(this.outRest.length + samples.length);
    all.set(this.outRest);
    all.set(samples, this.outRest.length);
    const frame = PHONE_RATE / 50;
    const whole = all.length - (all.length % frame);
    this.outRest = all.slice(whole);
    if (!whole) return;
    try {
      this.phone?.send(JSON.stringify({ event: "media", media: { payload: encodePcm(all.subarray(0, whole), this.order.current) } }));
    } catch {
      /* the caller hung up */
    }
    this.playsUntil = Math.max(Date.now(), this.playsUntil) + (whole / PHONE_RATE) * 1000;
  }

  /**
   * The caller talks while voice audio is still queued at Telnyx: drop the
   * queue, or they hear the voice talk on over them. GPT-Live over a
   * WebSocket sends no interruption event, and OpenAI's docs leave dropping
   * queued audio to the client.
   */
  private bargeIn(by: "loud" | "words", level?: number): void {
    const queuedMs = Math.round(this.playsUntil - Date.now());
    if (queuedMs <= 0 || !this.phone) return;
    try {
      this.phone.send(JSON.stringify({ event: "clear" }));
    } catch {
      return;
    }
    this.playsUntil = 0;
    this.outRest = new Int16Array(0);
    log({
      ev: "live barge-in",
      call: this.ourCallId,
      gen: this.voiceGen,
      by,
      queuedMs,
      // The caller's loudness against their noise floor and the voice's own
      // output level: what separates an interruption from the voice's echo.
      level: level === undefined ? null : Math.round(level),
      floor: Math.round(this.noiseFloor),
      voiceLevel: Math.round(this.voiceLevel),
    });
  }

  /** Whether caller speech starting at `startMs` (the voice's audio time)
   *  was sent before the voice's current turn began. */
  private saidBeforeVoice(startMs?: number): boolean {
    if (typeof startMs !== "number" || !this.turn) return false;
    const at = this.wallFor(startMs);
    return at > 0 && at < this.turn.startAt;
  }

  /** The call is over, from either end. When the voice ended first, the
   *  phone call is hung up too, or the caller sits in silence. */
  /**
   * Background from the caller's terminal: the brief at pickup, and the
   * session's own words a little later. Thinking, not commentary: the voice
   * knows it, but does not say it unless asked. Split under the ~500-token
   * cap of one append.
   */
  private async context(body: unknown): Promise<Response> {
    const { text } = (body ?? {}) as { text?: string };
    if (typeof text !== "string" || !text.trim()) return new Response("bad context", { status: 400 });
    if (this.ended) return Response.json({ ok: false, ended: true });
    const all = text.trim().slice(0, 12_000);
    this.notes.push(all);
    for (const m of this.noteMessages(all)) (this.live ? (x: unknown) => this.send(x) : (x: unknown) => this.earlyNotes.push(x))(m);
    return Response.json({ ok: true });
  }

  private noteMessages(all: string): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < all.length; i += 1600)
      out.push({
        type: "session.thinking.append",
        delegation_id: null,
        content: `${i ? "(continued) " : "Background on the session, from its terminal: "}${all.slice(i, i + 1600)}`,
      });
    return out;
  }

  private async finish(by: "phone" | "voice"): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.endTurn();
    this.cancelHangup();
    if (this.phoneGoneTimer) clearTimeout(this.phoneGoneTimer);
    this.phoneGoneTimer = null;
    this.voiceGen++;
    this.send({ type: "session.close" });
    if (by === "voice" && this.sipSession) await sip.hangup(this.env, this.sipSession);
    if (by === "voice" && this.cfg?.callSid && this.cfg.accountSid)
      await telnyx
        .hangupTexmlCall(this.env.TELNYX_API_KEY, this.cfg.accountSid, this.cfg.callSid)
        .catch((err) => console.error("live hangup failed", this.ourCallId, (err as Error).message));
    try {
      this.phone?.close(1000, "done");
    } catch {
      /* already closed */
    }
    await this.flush();
    if (this.lines.length) await this.persist();
    // No Telnyx status callback reports a SIP call's end: close it here.
    if (this.sipSession) await this.setStatus(this.sipAnswered ? "completed" : "failed");
    await db.stashDelete(this.env, `livecall:${this.cfg?.servedBy ?? this.userId}`).catch(() => {});
    this.wake();
    this.ws = null;
  }
}

/** One voice turn as measured by `measureOut`. */
interface Turn {
  startAt: number;
  replyMs: number | null;
  fromHeardEndMs: number | null;
  transcriptMs: number | null;
  chunks: number;
  bytes: number;
  minBytes: number;
  maxBytes: number;
  offFrame: number;
  maxGapMs: number;
  lastAt: number;
}

/** One warm request's round trip to `url`, in ms; null if it failed. */
async function rtt(url: string): Promise<number | null> {
  try {
    await (await fetch(url, { method: "HEAD" })).arrayBuffer();
    const t = Date.now();
    await (await fetch(url, { method: "HEAD" })).arrayBuffer();
    return Date.now() - t;
  } catch {
    return null;
  }
}

/** Output without speech for this long ends a voice turn. */
const TURN_GAP_MS = 600;

/** One structured log line: an event and ids, counts and times, never what
 *  was said, a digit or a phone number. */
const log = (fields: Record<string, unknown>): void => console.log(JSON.stringify(fields));

/** Caller words that do not count as talking on: more goodbye, or a noise
 *  the transcriber wrote down in brackets. */
const closingWords = (text: string): boolean => isNoise(text) || callerSaysBye(text);

const isNoise = (text: string): boolean => !text.replace(/\[[^\]]*\]?/g, "").replace(/[^\p{L}\p{N}]/gu, "");
