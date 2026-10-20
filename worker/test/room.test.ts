import { test } from "node:test";
import assert from "node:assert/strict";
import { Room, memberOf, wakeName, wakeRegex, type Member } from "../src/room.ts";

const event = (ev: string, p: Record<string, unknown>, words?: string[]) =>
  JSON.stringify({ event: ev, data: { data: { participant: p, ...(words ? { words: words.map((text) => ({ text })) } : {}) } } });

test("the bot is addressed by its first name, as speech-to-text writes it", () => {
  assert.equal(wakeName("Rex Hunter (AI)"), "Rex");
  assert.equal(wakeName("Claude Code (AI)"), "Claude");
  assert.ok(wakeRegex("Rex (AI)").test("ok rex, what failed last night"));
  assert.ok(!wakeRegex("Rex (AI)").test("the vortex failed"));
  assert.ok(wakeRegex("Claude Code (AI)").test("Cloud, can you check"));
});

test("the asker is the speaker whose words match the request, and the bot is never one", () => {
  const room = new Room("Rex (AI)");
  const t = 1_000_000;
  room.handle(event("transcript.data", { id: 1, name: "Ada" }, ["shall", "we", "ship", "it", "today"]), t);
  room.handle(event("transcript.data", { id: 2, name: "Grace" }, ["Rex", "why", "did", "the", "nightly", "run", "fail"]), t + 1000);
  room.handle(event("transcript.data", { id: 9, name: "Rex (AI)" }, ["On", "it"]), t + 1500);
  const who = room.askerOf("rex why did the nightly run fail", wakeRegex("Rex (AI)"), t - 30_000);
  assert.equal(who?.name, "Grace");
  assert.equal(room.participants.has(9), false);
});

test("a request nobody in the transcript said has no asker", () => {
  const room = new Room("Rex (AI)");
  room.handle(event("transcript.data", { id: 1, name: "Ada" }, ["lunch", "at", "one"]), 1000);
  assert.equal(room.askerOf("rex deploy production now", wakeRegex("Rex (AI)"), 0), undefined);
});

test("a display name proves nothing: only a signed-in participant, or an email, is a member", () => {
  const team: Member[] = [
    { id: "u1", name: "Jan Wilmake", email: "jan@example.com", phone: "+31600000001", level: "team" },
    { id: "u2", name: "Ada Lovelace", email: null, phone: "+31600000002", level: "" },
  ];
  const guestTyped = { id: 1, name: "Jan Wilmake", email: null, signedIn: false, present: true };
  assert.equal(memberOf(guestTyped, team), null);
  const signedIn = { ...guestTyped, signedIn: true };
  assert.equal(memberOf(signedIn, team)?.id, "u1");
  const byEmail = { id: 2, name: "whoever", email: "JAN@example.com", signedIn: false, present: true };
  assert.equal(memberOf(byEmail, team)?.id, "u1");
  // An email that belongs to nobody on the team is a guest, whatever the name.
  assert.equal(memberOf({ ...byEmail, name: "Ada Lovelace", email: "ada@elsewhere.org", signedIn: true }, team), null);
});

test("a name two members share matches neither", () => {
  const team: Member[] = [
    { id: "u1", name: "Sam", email: null, phone: null, level: "" },
    { id: "u2", name: "sam", email: null, phone: null, level: "" },
  ];
  assert.equal(memberOf({ id: 1, name: "Sam", email: null, signedIn: true, present: true }, team), null);
});

test("Meet's static participant id marks a participant as signed in, and stays", () => {
  const room = new Room("Rex (AI)");
  room.handle(event("participant_events.join", { id: 3, name: "Ada", extra_data: { google_meet: { static_participant_id: "abc" } } }));
  room.handle(event("participant_events.update", { id: 3, name: "Ada" }));
  assert.equal(room.participants.get(3)?.signedIn, true);
  room.handle(event("participant_events.leave", { id: 3, name: "Ada" }));
  assert.equal(room.present().length, 0);
});

test("arrivals and departures are reported, and decide how the voice speaks", async () => {
  const { speakingFor } = await import("../src/conversation.ts");
  const room = new Room("Claude (AI)");
  let changes = 0;
  room.onPresence = () => changes++;
  room.handle(event("participant_events.join", { id: 1, name: "Wijnand" }));
  assert.equal(speakingFor(room.present().length), "direct");
  room.handle(event("participant_events.join", { id: 2, name: "Bruna" }));
  assert.equal(speakingFor(room.present().length), "addressed");
  // Speaking again is no arrival; the bot itself never counts.
  room.handle(event("transcript.data", { id: 2, name: "Bruna" }, ["hi"]));
  room.handle(event("participant_events.join", { id: 9, name: "Claude (AI)" }));
  room.handle(event("participant_events.leave", { id: 2, name: "Bruna" }));
  assert.equal(changes, 3);
  assert.equal(speakingFor(room.present().length), "direct");
  // Nobody known yet: wait for the name, never answer a room's chatter.
  assert.equal(speakingFor(0), "addressed");
});
