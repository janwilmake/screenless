import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCallerId } from "../src/util.ts";

test("a caller id is reduced to its number, whatever form it arrives in", () => {
  assert.equal(normalizeCallerId("+31612345678"), "+31612345678");
  assert.equal(normalizeCallerId(" 31612345678"), "+31612345678");
  assert.equal(normalizeCallerId("whatsapp:+31612345678"), "+31612345678");
  assert.equal(normalizeCallerId("sip:+31612345678@sip.telnyx.com"), "+31612345678");
  assert.equal(normalizeCallerId("31612345678@whatsapp.net"), "+31612345678");
});
