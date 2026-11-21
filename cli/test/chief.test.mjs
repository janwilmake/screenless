// The chief's reading of Roost notes and of a team's repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNotes, repoOf } from "../dist/chief.js";

test("a plain note: about and what waits on the owner", () => {
  const n = parseNotes(`About: improving screenless.
Waiting for you:
- try a real outbound call
- say what easy means
Waiting for others:
- OpenAI sales`);
  assert.equal(n.about, "improving screenless.");
  assert.deepEqual(n.forYou, ["try a real outbound call", "say what easy means"]);
  assert.equal(n.header, "");
});

test("a customer header is kept whole", () => {
  const n = parseNotes("Farrow — Late: 5 · Waiting for us: 4 · Waiting for them: 2\nLast meeting: Tue");
  assert.equal(n.header, "Farrow — Late: 5 · Waiting for us: 4 · Waiting for them: 2");
});

test("a repository is matched by owner/name, whatever the remote form", () => {
  assert.equal(repoOf("git@github.com:Hyre-AI/hyre.git\n"), "hyre-ai/hyre");
  assert.equal(repoOf("https://github.com/Hyre-AI/hyre"), "hyre-ai/hyre");
  assert.equal(repoOf(""), "");
});

test("the voice's brief carries no addresses or numbers", async () => {
  const { redact } = await import("../dist/chief.js");
  assert.equal(redact("invite tom@farrow.nl, call +31 6 1234 5678 at 17:00"), "invite [email], call [number] at 17:00");
});
