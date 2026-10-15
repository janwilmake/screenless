/**
 * One Durable Object per live GPT-Live call: the line to the caller's own
 * Claude Code session.
 *
 * Telnyx streams the call's audio here over a WebSocket (8 kHz mu-law, both
 * ways), and this object relays it to a GPT-Live session over OpenAI's own
 * WebSocket, which takes and returns the same phone audio. (GPT-Live over SIP
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
 * The transcript is persisted on every finished line, like RealtimeCall, so
 * the finished call still reaches the watcher queue with everything said.
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
import * as pin from "./pin";
import type { CallMode } from "./pin";
import { Keypad, KEY_TIMEOUT_MS, redactSpokenNumbers, verdict } from "./keypad";
import { callerSaysBye, callerAsksHangup, voiceSaysBye, HANGUP_AFTER_MS, HANGUP_ON_REQUEST_MS } from "./farewell";

/** What answerInbound parks for a live ring-in, read when the audio arrives. */
export interface LiveConfig {
  engine: "live";
  userId: string;
  /** What the call's requests may do on the owner's machine: `full` once the
   *  caller is proven (attestation A or the PIN, see pin.ts), `restricted`
   *  otherwise: talk and read, the rest after the call. */
  mode: CallMode;
  /** The caller has a PIN and is not yet proven: the voice asks them to key
   *  it, and the keys are checked here (keypad.ts). Cleared once it is right
   *  or the tries are used up. */
  pin?: boolean;
  instructions: string;
  greeting: string;
  voice: string;
  /** The TeXML call, to hang up when the voice ends first. */
  accountSid: string;
  callSid: string;
  /** Test rings only: the one watcher repo allowed to serve this call. */
  onlyRepo?: string;
  /** The member whose session serves the call: the caller, or a teammate
   *  who shares their session's brief with the caller. */
  servedBy?: string;
  /** Set when the caller is not the session's owner: they hear its brief,
   *  and nothing they ask is run during the call. */
  teammate?: { name: string; owner: string };
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
  /** The call's mode when it was asked: a PIN keyed later does not reach
   *  back to requests made before it. */
  mode: CallMode;
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

/** Caller audio held back while a PIN is awaited, in 20 ms frames: a key's
 *  tone may reach the stream before its `dtmf` event, and must not reach the
 *  voice. Short, because it delays everything the caller says until the PIN
 *  is settled: a key event comes at the tone's start (RFC 2833). */
const KEY_AUDIO_HOLD = 10;
/** Caller audio is muted this long after the last key, for its tone's tail. */
const KEY_MUTE_MS = 700;
/** Loud caller frames in a row (20 ms each) that count as talking over the
 *  voice. A click or a burst of line noise is shorter. */
const BARGE_FRAMES = 6;

/** Told to the voice when the caller has a PIN that has not been keyed yet. */
const PIN_NOTE =
  "The caller has a PIN that gives this call full rights, and your greeting asks them to key it on the phone keypad and press hash. Never ask them to say it, and never say any digits of it. If they say a PIN or a string of digits aloud instead, do not repeat it: tell them a spoken PIN does not count, and ask them to key it in. You never learn the keyed digits: a note tells you only whether it was verified. Until then the call is restricted. Do not ask for the PIN again unless they bring it up.";

/** Told to the voice of a call whose caller was not proven. */
const RESTRICTED_NOTE =
  "This call is restricted: the caller's number was not verified by the carrier and no PIN was given. Their session can look things up and answer questions during the call, but anything that sends, changes, pushes or deploys waits for the session after the call. When a result says so, tell the caller it is queued for after the call.";

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
  /** The PIN keys of this call (only while `cfg.pin`). */
  private keypad = new Keypad();
  private keyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Caller audio held back while a PIN is awaited (KEY_AUDIO_HOLD). */
  private held: string[] = [];
  /** Caller audio is muted until then: a key was just pressed. */
  private keyMuteUntil = 0;
  /** An entry is being checked; keys meanwhile wait their turn. */
  private checking: Promise<void> = Promise.resolve();
  /** Said to the voice before it was live; sent once it is. */
  private voiceQueue: unknown[] = [];
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

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/stream") return this.stream(req, url.searchParams.get("call") ?? "");
    if (req.method === "GET" && url.pathname === "/next") return this.next();
    if (req.method === "POST" && url.pathname === "/result") return this.result(await req.json());
    if (req.method === "POST" && url.pathname === "/context") return this.context(await req.json());
    if (req.method === "POST" && url.pathname === "/update") return this.update(await req.json());
    return new Response("not found", { status: 404 });
  }

  /* ------------------------------------------------------------ the audio */

  /** Telnyx connects its media stream; the GPT-Live session starts with it.
   *  A second connect for the same call is Telnyx reconnecting: the new
   *  stream replaces the old one and the conversation carries on. */
  private async stream(req: Request, callId: string): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const raw = await db.stashGet(this.env, `realtime:${callId}`);
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
    if (!this.ws && !(await this.connectVoice())) {
      phone.close(1011, "voice unavailable");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    await this.announce();
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
        model: "gpt-live-1",
        instructions: [cfg.instructions, cfg.mode === "full" || cfg.teammate ? "" : RESTRICTED_NOTE, cfg.pin ? PIN_NOTE : ""]
          .filter(Boolean)
          .join("\n\n"),
        audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: cfg.voice } },
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
    let msg: { event?: string; media?: { track?: string; payload?: string }; dtmf?: { digit?: string } };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (msg.event === "media" && msg.media?.payload && msg.media.track !== "outbound") {
      const level = loudness(msg.media.payload);
      this.noiseFloor = level < this.noiseFloor ? level : this.noiseFloor + (level - this.noiseFloor) * 0.01;
      if (level > Math.max(500, this.noiseFloor * 3)) {
        this.callerSpeechAt = Date.now();
        if (++this.loudRun === BARGE_FRAMES) this.bargeIn("loud");
      } else this.loudRun = 0;
      this.toVoice(msg.media.payload);
    } else if (msg.event === "dtmf") {
      if (this.cfg?.pin) this.onKey(msg.dtmf?.digit ?? "");
    } else if (msg.event === "stop") {
      this.phoneLost();
    }
  }

  /**
   * Caller audio on its way to the voice. While a PIN is awaited it runs
   * KEY_AUDIO_HOLD frames behind, so that when a key's `dtmf` event arrives
   * the frames carrying its tone can be dropped, and it is muted while keys
   * are being pressed. Whether Telnyx leaves the tones in the audio at all is
   * not documented; this makes it not matter.
   */
  private toVoice(payload: string): void {
    let out = payload;
    if (this.cfg?.pin) {
      this.held.push(payload);
      if (this.held.length <= KEY_AUDIO_HOLD) return;
      out = this.held.shift()!;
      if (Date.now() < this.keyMuteUntil || this.keypad.typing) out = silence(out);
    }
    if (this.live) this.send({ type: "session.input_audio.append", audio: out });
    else if (this.early.length < 250) this.early.push(out);
  }

  /** One key press from the media stream. The digit goes no further than
   *  the keypad: it is not logged, stored or passed on. */
  private onKey(digit: string): void {
    // How far ahead of its event a key's tone shows in the audio, if at all:
    // the frames KEY_AUDIO_HOLD must cover. Loudness only, never the digit.
    const loud = this.held.map(loudness);
    const first = loud.findIndex((l) => l > 1000);
    log({ ev: "live key tone", call: this.ourCallId, held: loud.length, loudFrames: first < 0 ? 0 : loud.length - first });
    this.held = this.held.map(silence);
    this.keyMuteUntil = Date.now() + KEY_MUTE_MS;
    const entry = this.keypad.key(digit, Date.now());
    if (entry) this.checkEntry(entry);
    else if (this.keypad.typing) this.armKeyTimer();
  }

  private armKeyTimer(): void {
    if (this.keyTimer) clearTimeout(this.keyTimer);
    this.keyTimer = setTimeout(() => {
      this.keyTimer = null;
      const entry = this.keypad.idle(Date.now());
      if (entry) this.checkEntry(entry);
    }, KEY_TIMEOUT_MS + 50);
  }

  /** Entries are checked one at a time, in the order keyed. */
  private checkEntry(entry: string): void {
    if (this.keyTimer) clearTimeout(this.keyTimer);
    this.keyTimer = null;
    this.checking = this.checking.then(() => this.verifyEntry(entry)).catch((err) => {
      console.error("live pin check failed", this.ourCallId, (err as Error).message);
    });
  }

  /**
   * Checks a keyed PIN against the member's stored hash, with the same limits
   * as before: PIN_TRIES per call, PIN_FAILS_PER_HOUR wrong ones per member.
   * Right flips the call to full for every request made from now on; the
   * watcher reads the mode with each request.
   */
  private async verifyEntry(entry: string): Promise<void> {
    const cfg = this.cfg;
    if (!cfg?.pin || this.ended) return;
    const user = await db.userById(this.env, cfg.userId);
    const failKey = `pinfail:${cfg.userId}`;
    const priorFails = Number((await db.stashGet(this.env, failKey)) ?? 0);
    const ok =
      !!user && priorFails < pin.PIN_FAILS_PER_HOUR && (await pin.verifyPin(entry, { hash: user.pin_hash, salt: user.pin_salt }));
    const triesKey = `pintries:${this.ourCallId}`;
    let tries = Number((await db.stashGet(this.env, triesKey)) ?? 0);
    let fails = priorFails;
    if (ok) await db.stashDelete(this.env, failKey).catch(() => undefined);
    else {
      tries++;
      fails++;
      await db.stashPut(this.env, triesKey, String(tries), 7200);
      await db.stashPut(this.env, failKey, String(fails), 3600);
    }
    const v = verdict({ ok, tries, fails, maxTries: pin.PIN_TRIES, maxFails: pin.PIN_FAILS_PER_HOUR });
    console.log("live pin", this.ourCallId, v.event, v.event === "wrong" ? tries : "");
    if (v.done) {
      cfg.pin = false;
      // The held frames follow the last key: its tone's tail, not speech.
      this.held = [];
    }
    cfg.mode = v.mode;
    if (v.done) {
      // A stream that reconnects re-reads the config: it must not ask again,
      // or fall back to restricted after the PIN was right.
      await db.stashPut(this.env, `realtime:${this.ourCallId}`, JSON.stringify(cfg), 7200);
      await this.announce();
      // The watcher's long-poll returns at once with the new mode.
      this.wake();
    }
    this.tellVoice(v.note);
  }

  /** Where the watcher finds this call, with the mode it is in now. */
  private async announce(): Promise<void> {
    const cfg = this.cfg!;
    await db.stashPut(
      this.env,
      `livecall:${cfg.servedBy ?? cfg.userId}`,
      JSON.stringify({ callId: this.ourCallId, onlyRepo: cfg.onlyRepo, teammate: cfg.teammate?.name, mode: cfg.mode }),
      7200,
    );
  }

  /** An instruction for the voice, held until it is live. */
  private tellVoice(content: string): void {
    const m = { type: "session.instructions.append", delegation_id: null, content };
    if (this.live) this.send(m);
    else this.voiceQueue.push(m);
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
        if (msg.delta) {
          this.voiceSpoke = true;
          this.measureOut(msg.delta);
          this.toPhone(msg.delta);
        }
        break;
      case "session.started":
        this.live = true;
        log({
          ev: "live voice ready",
          call: this.ourCallId,
          gen: this.voiceGen,
          connectMs: this.voiceOpenAt - this.voiceAskedAt,
          startMs: Date.now() - this.voiceOpenAt,
          // Caller audio sent in one burst now, ahead of real time.
          earlyFrames: this.early.length,
        });
        for (const audio of this.early.splice(0)) this.send({ type: "session.input_audio.append", audio });
        for (const m of this.voiceQueue.splice(0)) this.send(m);
        if (this.greeted) {
          this.resumeVoice();
          break;
        }
        for (const note of this.earlyNotes.splice(0)) this.send(note);
        this.greeted = true;
        this.greetWhenQuiet(greeting);
        break;
      case "session.input_transcript.delta":
        // The first words of a caller line: they may be talking over the voice.
        if (this.buf?.role !== "user" && msg.delta && !isNoise(msg.delta)) this.bargeIn("words");
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
        await this.voiceLost();
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
    const gen = this.voiceGen;
    this.afterCallerPause(GREET_WAIT_MAX_MS, () => {
      if (gen !== this.voiceGen || this.voiceSpoke) return;
      this.send({
        type: "session.instructions.append",
        delegation_id: null,
        content: `Now say the following, exactly, then wait for the caller: "${greeting}" If the caller starts speaking, stop at once and listen.`,
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
    let text = b?.text.replace(/\s+/g, " ").trim();
    if (!b || !text) return;
    // A PIN said aloud instead of keyed stays out of the transcript, and so
    // out of the requests handed to the terminal and the call record.
    if (this.cfg?.pin) text = redactSpokenNumbers(text);
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
    // A teammate hears the brief; their requests are not run on the owner's
    // machine during the call. They reach the session afterwards, marked as
    // a teammate's, like any ring-in.
    if (this.cfg?.teammate) {
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
      mode: this.cfg?.mode === "full" ? "full" : "restricted",
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
      handoffs: open.map(({ id, request, context, at, mode }) => ({ id, request, context, at, mode })),
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
    if (this.cfg?.teammate) return Response.json({ ok: false, error: "a teammate's call takes no updates" }, { status: 403 });
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
  private measureOut(b64: string): void {
    const now = Date.now();
    const bytes = b64Bytes(b64);
    const voiced = loudness(b64) > 200;
    if (voiced && now - this.voiceVoicedAt > TURN_GAP_MS) {
      this.endTurn();
      // The caller's last loud frame came after the voice's last speech: this
      // turn answers the caller. Otherwise the voice spoke up on its own.
      const answers = this.callerSpeechAt > this.voiceVoicedAt && now - this.callerSpeechAt < 15_000;
      this.turn = {
        startAt: now,
        replyMs: answers ? now - this.callerSpeechAt : null,
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
      if (bytes % 160) t.offFrame++;
      t.lastAt = now;
    }
    this.outAt = now;
  }

  /** Logs the turn measured so far. Ids, counts and times only. */
  private endTurn(): void {
    const t = this.turn;
    this.turn = null;
    if (!t || !t.chunks) return;
    const wallMs = t.lastAt - t.startAt;
    const audioMs = Math.round(t.bytes / 8);
    log({
      ev: "live turn",
      call: this.ourCallId,
      gen: this.voiceGen,
      replyMs: t.replyMs,
      // Caller audio runs this far behind while a PIN is awaited.
      pinHoldMs: this.cfg?.pin ? KEY_AUDIO_HOLD * 20 : 0,
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

  private toPhone(payload: string): void {
    try {
      this.phone?.send(JSON.stringify({ event: "media", media: { payload } }));
    } catch {
      /* the caller hung up */
    }
    // 8 kHz mu-law: 8 bytes a millisecond.
    this.playsUntil = Math.max(Date.now(), this.playsUntil) + b64Bytes(payload) / 8;
  }

  /**
   * The caller talks while voice audio is still queued at Telnyx: drop the
   * queue, or they hear the voice talk on over them. GPT-Live over a
   * WebSocket sends no interruption event, and OpenAI's docs leave dropping
   * queued audio to the client. Not while a PIN is awaited: the caller is
   * keying, and the voice's prompt for it should play out.
   */
  private bargeIn(by: "loud" | "words"): void {
    const queuedMs = Math.round(this.playsUntil - Date.now());
    if (queuedMs <= 0 || this.cfg?.pin || !this.phone) return;
    try {
      this.phone.send(JSON.stringify({ event: "clear" }));
    } catch {
      return;
    }
    this.playsUntil = 0;
    log({ ev: "live barge-in", call: this.ourCallId, gen: this.voiceGen, by, queuedMs });
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
    if (this.keyTimer) clearTimeout(this.keyTimer);
    this.keyTimer = null;
    this.voiceGen++;
    this.send({ type: "session.close" });
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
    await db.stashDelete(this.env, `livecall:${this.cfg?.servedBy ?? this.userId}`).catch(() => {});
    this.wake();
    this.ws = null;
  }
}

/** One voice turn as measured by `measureOut`. */
interface Turn {
  startAt: number;
  replyMs: number | null;
  chunks: number;
  bytes: number;
  minBytes: number;
  maxBytes: number;
  offFrame: number;
  maxGapMs: number;
  lastAt: number;
}

/** Output without speech for this long ends a voice turn. */
const TURN_GAP_MS = 600;

/** One structured log line: an event and ids, counts and times, never what
 *  was said, a digit or a phone number. */
const log = (fields: Record<string, unknown>): void => console.log(JSON.stringify(fields));

/** Decoded length of a base64 string, without decoding it. */
const b64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/** Caller words that do not count as talking on: more goodbye, or a noise
 *  the transcriber wrote down in brackets. */
const closingWords = (text: string): boolean => isNoise(text) || callerSaysBye(text);

/** Mean absolute amplitude of one frame of 8-bit mu-law audio. Speech on a
 *  phone line runs to the thousands; a quiet line stays in the low hundreds. */
function loudness(b64: string): number {
  let bytes: string;
  try {
    bytes = atob(b64);
  } catch {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes.charCodeAt(i) & 0xff;
    const mag = (((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7);
    sum += mag - 0x84;
  }
  return bytes.length ? sum / bytes.length : 0;
}

/** The same frame, silent: mu-law 0xFF is zero. */
function silence(b64: string): string {
  let n = 160;
  try {
    n = atob(b64).length;
  } catch {
    /* a 20 ms frame */
  }
  return btoa(String.fromCharCode(0xff).repeat(n));
}

const isNoise = (text: string): boolean => !text.replace(/\[[^\]]*\]?/g, "").replace(/[^\p{L}\p{N}]/gu, "");
