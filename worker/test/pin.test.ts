// The PIN hash and compare, and reading the carrier's attestation.
// Node runs this TypeScript as is: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attestationOf, attested, hashPin, pinFromGather, verifyPin } from "../src/pin.ts";

test("a PIN verifies against its own hash, and nothing else does", async () => {
  const stored = await hashPin("4821");
  assert.match(stored.hash, /^[0-9a-f]{64}$/);
  assert.match(stored.salt, /^[0-9a-f]{32}$/);
  assert.equal(await verifyPin("4821", stored), true);
  assert.equal(await verifyPin("4822", stored), false);
  assert.equal(await verifyPin("48210", stored), false);
  assert.equal(await verifyPin("", stored), false);
  assert.equal(await verifyPin("4821", { hash: "", salt: "" }), false);
});

test("the hash is salted: one PIN, two hashes", async () => {
  const a = await hashPin("123456");
  const b = await hashPin("123456");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPin("123456", b), true);
});

test("the hash does not contain the PIN", async () => {
  const s = await hashPin("98765432");
  assert.ok(!s.hash.includes("98765432") && !s.salt.includes("98765432"));
});

test("keyed and spoken PINs read as digits", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ Digits: "4821" }, "4821"],
    [{ Digits: "4821#" }, "4821"],
    [{ SpeechResult: "4 8 2 1." }, "4821"],
    [{ SpeechResult: "4821" }, "4821"],
    [{ SpeechResult: "Four eight two one" }, "4821"],
    [{ SpeechResult: "vier acht twee een" }, "4821"],
    [{ SpeechResult: "my pin is one two three four" }, "1234"],
    [{ Digits: "77", SpeechResult: "one" }, "77"],
    [{}, ""],
    [{ SpeechResult: "hello" }, ""],
  ];
  for (const [params, want] of cases) assert.equal(pinFromGather(params), want, JSON.stringify(params));
});

test("only a validated A attestation proves the number", () => {
  const cases: Array<[Record<string, string>, boolean]> = [
    [{ ShakenStirAttestation: "A", ShakenStirValidated: "true" }, true],
    [{ ShakenStirAttestation: "a", ShakenStirValidated: "True" }, true],
    [{ shaken_stir_attestation: "A", shaken_stir_validated: "true" }, true],
    [{ ShakenStirAttestation: "A", ShakenStirValidated: "false" }, false],
    [{ ShakenStirAttestation: "A" }, false],
    [{ ShakenStirAttestation: "B", ShakenStirValidated: "true" }, false],
    [{ ShakenStirAttestation: "C", ShakenStirValidated: "true" }, false],
    [{ ShakenStirAttestation: "Unavailable", ShakenStirValidated: "true" }, false],
    [{}, false],
  ];
  for (const [params, want] of cases) assert.equal(attested(attestationOf(params)), want, JSON.stringify(params));
});
