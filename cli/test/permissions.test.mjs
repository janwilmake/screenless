// `.agents/permissions.md`: the parser, who gets which mode, and that the
// personal file and a broken file can only ever lower what a caller may do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicy, resolve, combine, baseline, loadPolicies, permissionsFor, permissionsText, levelsOf, inRoom } from "../dist/permissions.js";

const FILE = `---
default: team
modes:
  team: { gate: read }   # everyone at the company
  data:
    gate: read
  lead: { gate: full }
callers:
  wijnand@hyre.io: lead
  "tamas@hyre.io": lead
  luc@hyre.io: data
  "+31 6 1234 5678": data
  "*@hyre.io": team
  "*@outside.example": listen
---

People read this part; it is not a rule.

## team
Explain how the product works. No customer data.

## lead
Everything \`team\` may do, and also:
- order merges into dev by PR number.

## Never
- Secrets go to nobody.
- No production write without an explicit order.
`;

test("parses modes, callers, rules and Never", () => {
  const p = parsePolicy(FILE);
  assert.equal(p.default, "team");
  assert.deepEqual(p.modes, { team: { gate: "read" }, data: { gate: "read" }, lead: { gate: "full" } });
  assert.equal(p.callers["tamas@hyre.io"], "lead");
  assert.equal(p.callers["*@outside.example"], "listen");
  assert.match(p.rules.lead, /order merges into dev/);
  assert.equal(p.rules.data, undefined);
  assert.deepEqual(p.never, ["Secrets go to nobody.", "No production write without an explicit order."]);
});

test("the most specific line wins: email, then phone, then *@domain, then default", () => {
  const p = parsePolicy(FILE);
  const mode = (c) => resolve(p, { owner: false, ...c }).mode;
  assert.equal(mode({ email: "Wijnand@Hyre.io" }), "lead");
  assert.equal(mode({ email: "luc@hyre.io" }), "data");
  assert.equal(mode({ email: "someone@else.com", phone: "+31612345678" }), "data");
  assert.equal(mode({ email: "robin@hyre.io" }), "team");
  assert.equal(mode({ email: "x@outside.example" }), "listen");
  assert.equal(resolve(p, { owner: false, email: "x@outside.example" }).gate, "listen");
  assert.equal(mode({ email: "stranger@gmail.com" }), "team");
});

test("the owner keeps full unless a line names them exactly", () => {
  const p = parsePolicy(FILE);
  // Matched only by *@hyre.io: wildcards describe teammates, not the owner.
  assert.deepEqual(
    [resolve(p, { owner: true, email: "jan@hyre.io", phone: "+31600000000" }).gate, resolve(p, { owner: true, email: "jan@hyre.io" }).mode],
    ["full", "owner"],
  );
  // Named by email or phone: narrowed.
  assert.equal(resolve(p, { owner: true, email: "luc@hyre.io" }).gate, "read");
  assert.equal(resolve(p, { owner: true, phone: "+31612345678" }).gate, "read");
});

test("a bare gate word works for default and callers", () => {
  const p = parsePolicy("---\ndefault: listen\ncallers:\n  a@b.c: full\n---\n");
  assert.equal(resolve(p, { owner: false, email: "a@b.c" }).gate, "full");
  assert.equal(resolve(p, { owner: false, email: "z@b.c" }).gate, "listen");
});

test("the personal file narrows and never widens", () => {
  const repo = resolve(parsePolicy(FILE), { owner: false, email: "wijnand@hyre.io" });
  const tighter = resolve(parsePolicy("---\ndefault: read\n---\n## Never\nNo deploys from this laptop.\n"), { owner: false, email: "wijnand@hyre.io" });
  const looser = resolve(parsePolicy("---\ndefault: full\n---\n"), { owner: false, email: "robin@hyre.io" });
  assert.equal(combine(repo, tighter).gate, "read");
  assert.ok(combine(repo, tighter).never.includes("No deploys from this laptop."));
  assert.ok(combine(repo, tighter).never.includes("Secrets go to nobody."));
  assert.equal(combine(resolve(parsePolicy(FILE), { owner: false, email: "robin@hyre.io" }), looser).gate, "read");
});

test("malformed files are refused with a reason", () => {
  for (const [text, why] of [
    ["no front matter", /front matter/],
    ["---\nmodes:\n  a: { gate: read }\n---\n", /default/],
    ["---\ndefault: boss\n---\n", /neither a mode/],
    ["---\ndefault: listen\nmodes:\n  a: { gate: admin }\n---\n", /not listen, read or full/],
    ["---\ndefault: listen\ncallers:\n  a@b.c: boss\n---\n", /neither a mode/],
    ["---\ndefault: listen\nwho: x\n---\n", /unknown key/],
  ])
    assert.throws(() => parsePolicy(text), why);
});

test("no file, or a broken one, is exactly today's behaviour", () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const none = loadPolicies(dir, home);
  assert.equal(none.repo, null);
  assert.deepEqual(permissionsFor(none, { owner: true }), baseline({ owner: true }));
  assert.equal(permissionsFor(none, { owner: false, email: "a@b.c" }).gate, "listen");

  mkdirSync(join(dir, ".agents"));
  writeFileSync(join(dir, ".agents", "permissions.md"), "---\ndefault: full\nbogus\n---\n");
  const broken = loadPolicies(dir, home);
  assert.equal(broken.repo, null);
  assert.equal(broken.warnings.length, 1);
  assert.equal(permissionsFor(broken, { owner: false, email: "a@b.c" }).gate, "listen");

  writeFileSync(join(dir, ".agents", "permissions.md"), FILE + "\n");
  const ok = loadPolicies(dir, home);
  assert.equal(permissionsFor(ok, { owner: false, email: "luc@hyre.io" }).mode, "data");
  assert.match(permissionsText("Luc", permissionsFor(ok, { owner: false, email: "luc@hyre.io" })), /mode "data", gate read/);
});

// Session 16: people move to the team page; the file only defines levels.
const OPEN = `---
default: listen
modes:
  reviewer: { gate: read }
  lead: { gate: full }
---
## lead
May merge into dev by PR number.
`;

test("a file with no people works: the team page's level picks the mode", () => {
  const p = parsePolicy(OPEN);
  assert.equal(resolve(p, { owner: false, email: "x@y.dev", level: "lead" }).gate, "full");
  assert.equal(resolve(p, { owner: false, email: "x@y.dev", level: "reviewer" }).mode, "reviewer");
  assert.equal(resolve(p, { owner: false, email: "x@y.dev" }).gate, "listen");
});

test("a level a repo does not define gets that repo's default, never more", () => {
  const p = parsePolicy(OPEN);
  for (const level of ["boss", "full", "read"])
    assert.equal(resolve(p, { owner: false, email: "x@y.dev", level }).gate, "listen", level);
});

test("a caller line decides for an unassigned caller, and only narrows an assigned one", () => {
  const p = parsePolicy(FILE);
  // Unassigned: session 17's behaviour, unchanged.
  assert.equal(resolve(p, { owner: false, email: "tamas@hyre.io" }).mode, "lead");
  // Assigned lower than the line: the level wins.
  assert.equal(resolve(p, { owner: false, email: "tamas@hyre.io", level: "team" }).mode, "team");
  // Assigned higher than the line: the line narrows it.
  assert.equal(resolve(p, { owner: false, email: "someone@outside.example", level: "lead" }).gate, "listen");
});

test("without a file, only the built-in levels mean anything", () => {
  assert.equal(baseline({ owner: false, level: "read" }).gate, "read");
  assert.equal(baseline({ owner: false, level: "lead" }).gate, "listen");
  assert.equal(baseline({ owner: false }).gate, "listen");
  assert.equal(baseline({ owner: true, level: "listen" }).gate, "full");
});

test("the watcher reports the file's levels, and a bare default with them", () => {
  assert.deepEqual(levelsOf(parsePolicy(OPEN)), { levels: "reviewer:read,lead:full,listen:listen", default: "listen" });
  assert.deepEqual(levelsOf(parsePolicy(FILE)), { levels: "team:read,data:read,lead:full", default: "team" });
});

test("a meeting room's level: guests get it, the team gets no more than it", () => {
  const l = { repo: parsePolicy(FILE), personal: null, warnings: [], paths: { repo: "", personal: "" } };
  const guest = { owner: false, email: null };
  // Without a room level a guest only gets the file's default; in a room, the room's.
  assert.equal(inRoom(l, guest, false, "read").gate, "read");
  assert.equal(inRoom(l, guest, false, "full").gate, "full");
  assert.deepEqual(inRoom(l, guest, false, "full").never, l.repo.never);
  // A member the meeting proved keeps their own level, capped by the room.
  assert.equal(inRoom(l, { owner: false, email: "wijnand@hyre.io" }, true, "read").gate, "read");
  assert.equal(inRoom(l, { owner: false, email: "luc@hyre.io" }, true, "full").gate, "read");
  assert.equal(inRoom(l, { owner: true }, true, "listen").gate, "listen");
  // No file at all: a room level still means what it says.
  assert.equal(inRoom({ repo: null, personal: null, warnings: [], paths: { repo: "", personal: "" } }, guest, false, "read").gate, "read");
});
