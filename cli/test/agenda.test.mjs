// Which agenda meetings the bot joins: decided in code from the owner's rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRules, decide, linkOf } from "../dist/agenda.js";

const rules = parseRules(`---
join: invited   # only what the bot is invited to
bot: cody@hyre.io
team: hyre.io
trust-team: read
trust-outside: listen
skip: Lunch, *1:1*
name: Cody
---
Customer meetings: say what is open for that customer.`);
const now = Date.parse("2026-11-25T08:00:00Z");
const ev = (o) => ({
  summary: "Dev standup",
  start: { dateTime: "2026-11-25T09:15:00Z" },
  conferenceUrl: "https://meet.google.com/abc-defg-hij",
  attendees: [{ email: "wijnand@hyre.io", self: true, responseStatus: "accepted" }, { email: "cody@hyre.io" }],
  ...o,
});

test("rules: parsed, with the free text kept for the prep", () => {
  assert.equal(rules.join, "invited");
  assert.deepEqual(rules.bots, ["cody@hyre.io"]);
  assert.equal(rules.name, "Cody");
  assert.match(rules.notes, /Customer meetings/);
});

test("joins a team meeting the bot is invited to, at the team's level", () => {
  const d = decide(ev({}), rules, now, 3 * 3600_000);
  assert.equal(d.join, true);
  assert.equal(d.trust, "read");
  assert.equal(d.purpose, "Dev standup");
});

test("someone from outside makes the room listen-only", () => {
  const d = decide(ev({ attendees: [...ev({}).attendees, { email: "jaron@skillscout.nl" }] }), rules, now, 3 * 3600_000);
  assert.equal(d.join, true);
  assert.equal(d.trust, "listen");
});

test("not invited, declined, skipped, no link, too far ahead: not joined", () => {
  assert.equal(decide(ev({ attendees: [{ email: "wijnand@hyre.io", self: true }] }), rules, now, 3 * 3600_000).join, false);
  assert.equal(decide(ev({ attendees: [{ email: "wijnand@hyre.io", self: true, responseStatus: "declined" }, { email: "cody@hyre.io" }] }), rules, now, 3 * 3600_000).join, false);
  assert.equal(decide(ev({ summary: "Robin 1:1 Wijnand" }), rules, now, 3 * 3600_000).join, false);
  assert.equal(decide(ev({ conferenceUrl: undefined }), rules, now, 3 * 3600_000).join, false);
  assert.equal(decide(ev({}), rules, now, 3600_000).join, false);
});

test("no file content means off; full is never given by rule", () => {
  assert.equal(parseRules("").join, "off");
  assert.equal(parseRules("---\njoin: all\ntrust-team: full\n---").trustTeam, "read");
});

test("the link is found wherever the calendar put it", () => {
  assert.equal(linkOf({ description: "join: https://us02web.zoom.us/j/123?pwd=x thanks" }), "https://us02web.zoom.us/j/123?pwd=x");
  assert.equal(linkOf({ location: "Riverside studio https://riverside.com/x" }), "");
});
