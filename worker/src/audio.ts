/**
 * The audio of a live call, kept linear end to end.
 *
 * The phone leg streams L16 at 16 kHz (wideband: what a WhatsApp call or an
 * HD-voice phone carries), and GPT-Live speaks 16-bit PCM at 24 kHz, its
 * native rate. Before this the call ran on 8 kHz mu-law both ways: two lossy
 * conversions and a narrowband line, which a WhatsApp call heard as hiss.
 * Between the two rates sits a windowed-sinc resampler, the same for both
 * directions, so nothing is aliased on the way down or imaged on the way up.
 *
 * Telnyx's stream payload is a raw RTP payload, and RTP's L16 is big-endian
 * (RFC 3551), but Telnyx does not document it, so `ByteOrder` checks it
 * against the caller's own audio. GPT-Live takes little-endian.
 *
 * No imports, so the tests can load it in plain Node.
 */

export const PHONE_RATE = 16_000;
export const VOICE_RATE = 24_000;

export type Endian = "be" | "le";

export function decodePcm(b64: string, endian: Endian): Int16Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return new Int16Array(0);
  }
  const out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const a = bin.charCodeAt(2 * i);
    const b = bin.charCodeAt(2 * i + 1);
    const u = endian === "be" ? (a << 8) | b : (b << 8) | a;
    out[i] = u > 0x7fff ? u - 0x10000 : u;
  }
  return out;
}

export function encodePcm(samples: Int16Array, endian: Endian): string {
  let bin = "";
  for (let i = 0; i < samples.length; i++) {
    const u = samples[i] & 0xffff;
    bin += endian === "be"
      ? String.fromCharCode(u >> 8, u & 0xff)
      : String.fromCharCode(u & 0xff, u >> 8);
  }
  return btoa(bin);
}

/** Mean absolute amplitude. Speech on a phone line runs to the thousands; a
 *  quiet line stays in the low hundreds. */
export function meanAbs(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += Math.abs(samples[i]);
  return samples.length ? sum / samples.length : 0;
}

/**
 * Which byte order the phone's audio is in. Read the wrong way round, a
 * sample's low byte becomes its high byte and neighbouring samples jump by
 * thousands; read the right way, audio moves smoothly. A frame votes only
 * when one reading is clearly smoother, so digital silence never decides it.
 */
export class ByteOrder {
  private votes = { be: 0, le: 0 };
  decided: Endian | null = null;

  readonly fallback: Endian;

  constructor(fallback: Endian) {
    this.fallback = fallback;
  }

  get current(): Endian {
    return this.decided ?? this.fallback;
  }

  /** One frame of phone audio, base64. Returns the order once it is settled. */
  observe(b64: string): Endian | null {
    if (this.decided) return this.decided;
    const be = roughness(decodePcm(b64, "be"));
    const le = roughness(decodePcm(b64, "le"));
    if (be * 4 < le) this.votes.be++;
    else if (le * 4 < be) this.votes.le++;
    if (this.votes.be >= 5 || this.votes.le >= 5) this.decided = this.votes.be >= 5 ? "be" : "le";
    return this.decided;
  }
}

function roughness(s: Int16Array): number {
  let sum = 0;
  for (let i = 1; i < s.length; i++) sum += Math.abs(s[i] - s[i - 1]);
  return sum;
}

/** Taps either side of each output sample. 16 keeps the passband flat to
 *  within a few percent of the new Nyquist, for 1 ms of delay. */
const HALF = 16;

/**
 * Streaming windowed-sinc resampler between two integer rates. Chunks may be
 * any size; the history it needs is carried from one to the next. Positions
 * are kept as exact fractions (units of 1/`to` input samples), so it never
 * drifts, and for 16↔24 kHz there are only two or three distinct kernels,
 * computed once.
 */
export class Resampler {
  private buf = new Float32Array(0);
  /** Input index of buf[0]. */
  private base = -HALF;
  /** Next output position, in 1/`to` input samples. */
  private pos = 0;
  private kernels = new Map<number, Float32Array>();
  private readonly cutoff: number;
  private readonly from: number;
  private readonly to: number;

  constructor(from: number, to: number) {
    this.from = from;
    this.to = to;
    // Below the lower of the two Nyquists, with a little room for the
    // window's transition band.
    this.cutoff = Math.min(1, to / from) * 0.95;
    // Silence before the first sample, so the start has its history.
    this.buf = new Float32Array(HALF);
  }

  push(input: Int16Array): Int16Array {
    const next = new Float32Array(this.buf.length + input.length);
    next.set(this.buf);
    next.set(input, this.buf.length);
    this.buf = next;
    const end = this.base + this.buf.length;
    const out: number[] = [];
    for (;;) {
      const center = Math.floor(this.pos / this.to);
      if (center + HALF >= end) break;
      const phase = this.pos % this.to;
      const k = this.kernel(phase);
      let acc = 0;
      const start = center - HALF + 1 - this.base;
      for (let j = 0; j < k.length; j++) acc += this.buf[start + j] * k[j];
      out.push(acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc));
      this.pos += this.from;
    }
    const keep = Math.floor(this.pos / this.to) - HALF + 1 - this.base;
    if (keep > 0) {
      this.buf = this.buf.slice(keep);
      this.base += keep;
    }
    return Int16Array.from(out);
  }

  /** Taps for an output that falls `phase`/`to` of the way past an input. */
  private kernel(phase: number): Float32Array {
    let k = this.kernels.get(phase);
    if (k) return k;
    const frac = phase / this.to;
    k = new Float32Array(2 * HALF);
    for (let j = 0; j < k.length; j++) {
      const d = j - HALF + 1 - frac;
      const x = Math.PI * this.cutoff * d;
      const sinc = d === 0 ? 1 : Math.sin(x) / x;
      const u = d / HALF;
      // Blackman window.
      const w = Math.abs(u) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      k[j] = this.cutoff * sinc * w;
    }
    this.kernels.set(phase, k);
    return k;
  }
}
