import { test } from "node:test";
import assert from "node:assert/strict";
import { Resampler, ByteOrder, decodePcm, encodePcm, meanAbs } from "../src/audio.ts";

const tone = (hz: number, rate: number, n: number, amp = 8000) =>
  Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)));

/** Amplitude of `hz` in `s`, by correlation, skipping the start-up. */
function level(s: Int16Array, hz: number, rate: number): number {
  let re = 0, im = 0, n = 0;
  for (let i = 200; i < s.length - 200; i++, n++) {
    re += s[i] * Math.cos((2 * Math.PI * hz * i) / rate);
    im += s[i] * Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return (2 * Math.hypot(re, im)) / n;
}

test("16 kHz up to 24 kHz and back keeps a voice-band tone", () => {
  const input = tone(1000, 16000, 16000);
  const up = new Resampler(16000, 24000).push(input);
  assert.ok(Math.abs(up.length - 24000) < 40, `up length ${up.length}`);
  assert.ok(Math.abs(level(up, 1000, 24000) - 8000) < 200);
  const down = new Resampler(24000, 16000).push(up);
  assert.ok(Math.abs(level(down, 1000, 16000) - 8000) < 300);
});

test("going down to 16 kHz removes what it cannot carry instead of folding it back", () => {
  // 11 kHz fits at 24 kHz but not at 16: unfiltered it would alias to 5 kHz.
  const down = new Resampler(24000, 16000).push(tone(11000, 24000, 24000));
  assert.ok(level(down, 5000, 16000) < 200, `aliased ${level(down, 5000, 16000)}`);
});

test("chunked input gives the same output as one block", () => {
  const input = tone(700, 16000, 4000);
  const whole = new Resampler(16000, 24000).push(input);
  const r = new Resampler(16000, 24000);
  const parts: number[] = [];
  for (let i = 0; i < input.length; i += 333) parts.push(...r.push(input.subarray(i, i + 333)));
  assert.deepEqual(Int16Array.from(parts), whole);
});

test("PCM round-trips in both byte orders", () => {
  const s = Int16Array.from([0, 1, -1, 32767, -32768, 1234, -4321]);
  for (const e of ["be", "le"] as const) assert.deepEqual(decodePcm(encodePcm(s, e), e), s);
  assert.equal(meanAbs(Int16Array.from([100, -100])), 100);
});

test("the byte order is read off the audio, and silence does not decide it", () => {
  const o = new ByteOrder("be");
  for (let i = 0; i < 10; i++) o.observe(encodePcm(new Int16Array(320), "le"));
  assert.equal(o.decided, null);
  for (let i = 0; i < 5; i++) o.observe(encodePcm(tone(300, 16000, 320, 300), "le"));
  assert.equal(o.decided, "le");
});
