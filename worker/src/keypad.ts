/**
 * The PIN keyed on the phone during a live call, read from the media stream.
 *
 * The voice asks for the PIN; the digits never reach it. Telnyx sends each key
 * press on the call's media stream as a `dtmf` event, and the call's Durable
 * Object assembles them here, checks the entry against the stored hash, and
 * tells the voice only whether it was right. Keys are not speech: they are
 * never in the voice model's input, the transcript or a log.
 *
 * Saying the PIN does not count, because said aloud it would be in all three.
 * While a PIN is awaited, a run of four or more spoken digits is cut from the
 * transcript (`redactSpokenNumbers`), and the voice is told never to repeat
 * one and to ask for the keypad instead.
 *
 * No runtime imports, so the tests can load it in plain Node.
 */

import type { CallMode } from "./pin";

/** Keys stopped for this long end the entry, like a Gather's timeout. */
export const KEY_TIMEOUT_MS = 4_000;
/** Longer than any PIN; keys past it are dropped rather than buffered. */
const MAX_KEYS = 16;

/**
 * One call's key presses. `#` ends an entry, `*` starts it over, and keys
 * that stop for KEY_TIMEOUT_MS end it too. `key` and `idle` return the entry
 * when it is finished, or null.
 */
export class Keypad {
  private buf = "";
  private lastAt = 0;

  /** One `dtmf` event's digit. */
  key(digit: string, at: number): string | null {
    const d = String(digit ?? "").trim();
    if (d === "*") {
      this.buf = "";
      return null;
    }
    if (d === "#") return this.take();
    if (!/^\d$/.test(d)) return null;
    if (this.buf.length < MAX_KEYS) this.buf += d;
    this.lastAt = at;
    return null;
  }

  /** Polled by a timer: the entry, once keys have stopped long enough. */
  idle(at: number): string | null {
    return this.buf && at - this.lastAt >= KEY_TIMEOUT_MS ? this.take() : null;
  }

  /** Keys are being pressed: an entry is under way. */
  get typing(): boolean {
    return this.buf.length > 0;
  }

  private take(): string | null {
    const entry = this.buf;
    this.buf = "";
    return entry || null;
  }
}

/** What a checked entry does to the call, and what the voice is told. */
export interface Verdict {
  mode: CallMode;
  /** No more entries are taken on this call. */
  done: boolean;
  /** For the voice. Never the digits: it does not know them and must not. */
  note: string;
  /** For the log: an event, never the digits. */
  event: "verified" | "wrong" | "locked";
}

/**
 * The outcome of one keyed entry: right gives full rights from now on; wrong
 * leaves the call restricted and may be tried again, `tries` of `maxTries`
 * per call, and not past `maxFails` wrong entries per member per hour.
 */
export function verdict(o: { ok: boolean; tries: number; fails: number; maxTries: number; maxFails: number }): Verdict {
  if (o.ok)
    return {
      mode: "full",
      done: true,
      event: "verified",
      note:
        "PIN verified. The caller keyed the right PIN, so from now on this call is in full mode: their session may do anything it may do at the keyboard, sending, pushing and deploying included. Ignore the earlier note that the call is restricted. Tell the caller in a few words that the PIN is verified, then carry on.",
    };
  const left = Math.max(0, o.maxTries - o.tries);
  if (left > 0 && o.fails < o.maxFails)
    return {
      mode: "restricted",
      done: false,
      event: "wrong",
      note: `PIN not verified: the keyed PIN was wrong. ${left === 1 ? "One try is" : `${left} tries are`} left. Tell the caller it was not right and they can key it again, then press hash. The call stays restricted until it is right.`,
    };
  return {
    mode: "restricted",
    done: true,
    event: "locked",
    note: "PIN not verified, and no tries are left on this call. Tell the caller the PIN was not right, so the call stays restricted: their session can look things up and answer questions, and anything that sends or changes something waits for after the call. Do not ask for the PIN again.",
  };
}

const DIGIT_WORDS =
  "zero|oh|nul|one|een|two|twee|three|drie|four|vier|five|vijf|six|zes|seven|zeven|eight|acht|nine|negen";
// Four or more digits, or digit words, in a run: "4821", "4 8 2 1",
// "four eight two one", "vier-acht-twee-een". Shorter numbers stay.
const DIGIT = `(?:\\d|\\b(?:${DIGIT_WORDS})\\b)`;
const RUN = new RegExp(`${DIGIT}(?:[\\s,.\\-]*${DIGIT}){3,}`, "gi");

/** A line of the call with any spoken PIN-like number cut out. Used while a
 *  PIN is awaited, on both sides of the transcript. */
export const redactSpokenNumbers = (text: string): string => text.replace(RUN, "[number removed]");
