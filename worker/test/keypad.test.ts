// The PIN keyed during a live call: assembling it from the media stream's
// dtmf events, what a checked entry does to the call, and keeping a spoken
// PIN out of the transcript. Node runs this TypeScript as is: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypad, KEY_TIMEOUT_MS, redactSpokenNumbers, verdict } from "../src/keypad.ts";
import { hashPin, verifyPin, PIN_TRIES, PIN_FAILS_PER_HOUR } from "../src/pin.ts";

/** Feeds `keys` one second apart from t=0; returns the entries finished. */
function press(pad: Keypad, keys: string, start = 0): string[] {
  const out: string[] = [];
  [...keys].forEach((k, i) => {
    const e = pad.key(k, start + i * 1000);
    if (e) out.push(e);
  });
  return out;
}

test("'#' ends an entry", () => {
  const pad = new Keypad();
  assert.deepEqual(press(pad, "5170#"), ["5170"]);
  assert.equal(pad.typing, false);
  assert.deepEqual(press(pad, "12#45#"), ["12", "45"]);
});

test("'*' starts the entry over", () => {
  const pad = new Keypad();
  assert.deepEqual(press(pad, "12*4821#"), ["4821"]);
  assert.deepEqual(press(pad, "99*"), []);
  assert.equal(pad.typing, false);
});

test("'#' alone, and anything that is not a key, is ignored", () => {
  const pad = new Keypad();
  assert.deepEqual(press(pad, "#"), []);
  assert.equal(pad.key("A", 0), null);
  assert.equal(pad.key("", 0), null);
  assert.deepEqual(press(pad, "4x8z2y1#"), ["4821"]);
});

test("keys that stop end the entry after the timeout, not before", () => {
  const pad = new Keypad();
  assert.deepEqual(press(pad, "4821"), []);
  const last = 3000;
  assert.equal(pad.idle(last + KEY_TIMEOUT_MS - 1), null);
  assert.equal(pad.typing, true);
  assert.equal(pad.idle(last + KEY_TIMEOUT_MS), "4821");
  assert.equal(pad.idle(last + KEY_TIMEOUT_MS * 3), null);
  // An idle pad never yields an empty entry.
  assert.equal(new Keypad().idle(1e9), null);
});

test("a keyed PIN checks against the stored hash", async () => {
  const stored = await hashPin("5170");
  const pad = new Keypad();
  const [entry] = press(pad, "5170#");
  assert.equal(await verifyPin(entry, stored), true);
  const [wrong] = press(pad, "5171#");
  assert.equal(await verifyPin(wrong, stored), false);
});

const v = (ok: boolean, tries: number, fails = tries) =>
  verdict({ ok, tries, fails, maxTries: PIN_TRIES, maxFails: PIN_FAILS_PER_HOUR });

test("the right PIN switches the call to full; wrong ones keep it restricted", () => {
  assert.deepEqual([v(true, 0).mode, v(true, 0).done, v(true, 0).event], ["full", true, "verified"]);
  assert.deepEqual([v(true, 2).mode, v(true, 2).done], ["full", true]);
  assert.deepEqual([v(false, 1).mode, v(false, 1).done, v(false, 1).event], ["restricted", false, "wrong"]);
  assert.deepEqual([v(false, 2).mode, v(false, 2).done], ["restricted", false]);
  // Three wrong tries on a call, or ten in the hour, and the PIN stops being taken.
  assert.deepEqual([v(false, PIN_TRIES).mode, v(false, PIN_TRIES).done, v(false, PIN_TRIES).event], ["restricted", true, "locked"]);
  assert.deepEqual([v(false, 1, PIN_FAILS_PER_HOUR).done, v(false, 1, PIN_FAILS_PER_HOUR).event], [true, "locked"]);
  assert.match(v(false, 1).note, /2 tries are left/);
  assert.match(v(false, 2).note, /One try is left/);
});

test("what the voice is told never carries digits", () => {
  for (const x of [v(true, 0), v(false, 1), v(false, 2), v(false, 3), v(false, 1, 10)])
    assert.doesNotMatch(x.note, /\d{2,}|\b\d\b(?! tries)/, x.note);
});

test("a spoken PIN is cut from the transcript", () => {
  const cases: Array<[string, string]> = [
    ["My PIN is 6092.", "My PIN is [number removed]."],
    ["it's 4 8 2 1", "it's [number removed]"],
    ["four eight two one", "[number removed]"],
    ["Four, eight, two, one, hash", "[number removed], hash"],
    ["vier acht twee een", "[number removed]"],
    ["123456 then hash", "[number removed] then hash"],
    // Short numbers and plain speech stay.
    ["merge PR 42 please", "merge PR 42 please"],
    ["one or two things", "one or two things"],
    ["Hi, how are you?", "Hi, how are you?"],
  ];
  for (const [said, want] of cases) assert.equal(redactSpokenNumbers(said), want, said);
  // Nothing of the digits survives.
  assert.doesNotMatch(redactSpokenNumbers("the code is 9 1 7 3 4"), /\d/);
});
