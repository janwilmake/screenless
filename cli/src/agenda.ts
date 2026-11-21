/**
 * Which meetings on the owner's agenda the line's bot joins by itself
 * (session 21, the chief). The calendar is read by the session, through
 * whatever calendar tool it has (the chief's hourly tick uses the Google
 * Calendar connector); the events are handed to `screenless agenda`, and
 * the decision is made here, in code, from the owner's own rules in
 * `~/.screenless/meetings.md`, never by a model's judgement.
 *
 *   ---
 *   join: invited          # off | invited | accepted | all
 *   bot: cody@hyre.io      # the bot's address(es), for `invited`
 *   team: hyre.io          # the team's mail domains
 *   trust-team: read       # a meeting of only the team
 *   trust-outside: listen  # anyone else in it; `skip` to stay out
 *   skip: Lunch, *1:1*     # titles never joined (* is a wildcard)
 *   name: Cody             # what the bot is called in the meeting
 *   ---
 *   Free text: what the prep should know about the owner's meetings.
 *
 * Without the file nothing is joined. A bot joining is visible to everyone
 * in the meeting, so it is the owner's choice, not a default.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type JoinMode = "off" | "invited" | "accepted" | "all";
export type Trust = "listen" | "read" | "full";

export interface MeetingRules {
  join: JoinMode;
  bots: string[];
  team: string[];
  trustTeam: Trust;
  trustOutside: Trust | "skip";
  skip: string[];
  /** What the bot is called in the meeting. */
  name: string;
  /** Free text after the front matter, for the prep. */
  notes: string;
}

export const RULES_PATH = join(homedir(), ".screenless", "meetings.md");

const list = (v = "") => v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const trustOf = (v: string | undefined, d: Trust): Trust => (v === "listen" || v === "read" || v === "full" ? v : d);

export function parseRules(text: string): MeetingRules {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head = m ? m[1] : "";
  const kv: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const hit = line.replace(/\s+#.*$/, "").match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (hit) kv[hit[1].toLowerCase()] = hit[2];
  }
  const join = (["off", "invited", "accepted", "all"] as const).find((j) => j === kv.join) ?? "off";
  const outside = kv["trust-outside"] === "skip" ? "skip" : trustOf(kv["trust-outside"], "listen");
  return {
    join,
    bots: list(kv.bot),
    team: list(kv.team).map((d) => d.replace(/^@/, "")),
    // `full` never by rule: a meeting is a room, and a room is not the owner.
    trustTeam: trustOf(kv["trust-team"], "read") === "full" ? "read" : trustOf(kv["trust-team"], "read"),
    trustOutside: outside === "full" ? "listen" : outside,
    skip: list(kv.skip),
    name: (kv.name ?? "").slice(0, 40),
    notes: (m ? m[2] : "").trim(),
  };
}

export function loadRules(path = RULES_PATH): MeetingRules | null {
  try {
    return parseRules(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** A calendar event in the shape Google Calendar gives it (and most others
 *  can be mapped to). */
export interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  conferenceUrl?: string;
  hangoutLink?: string;
  conferenceData?: { videoEntryPoint?: { uri?: string }; entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean; organizer?: boolean; resource?: boolean }>;
  organizer?: { email?: string; self?: boolean };
}

export interface Decision {
  title: string;
  start: number;
  link: string;
  join: boolean;
  why: string;
  trust?: Trust;
  purpose?: string;
}

const MEETING_LINK = /https:\/\/(meet\.google\.com|([\w-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/[^\s"'<>)]+/i;

export function linkOf(e: CalendarEvent): string {
  const tries = [
    e.conferenceUrl,
    e.hangoutLink,
    e.conferenceData?.videoEntryPoint?.uri,
    ...(e.conferenceData?.entryPoints ?? []).filter((p) => p.entryPointType === "video").map((p) => p.uri),
    e.location,
    e.description,
  ];
  for (const t of tries) {
    const hit = t?.match(MEETING_LINK);
    if (hit) return hit[0];
  }
  return "";
}

const glob = (pattern: string, text: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(text);

/** Whether the bot joins this event, and as what. Pure: the clock is given. */
export function decide(e: CalendarEvent, r: MeetingRules, now: number, horizonMs: number): Decision {
  const title = (e.summary ?? "").trim() || "(no title)";
  const start = Date.parse(e.start?.dateTime ?? "");
  const link = linkOf(e);
  const base = { title, start, link };
  const no = (why: string): Decision => ({ ...base, join: false, why });
  if (r.join === "off") return no("joining is off");
  if (!e.start?.dateTime || !Number.isFinite(start)) return no("all-day or no time");
  if (e.status === "cancelled") return no("cancelled");
  if (start < now - 5 * 60_000) return no("already under way");
  if (start > now + horizonMs) return no("later than this run looks ahead");
  if (!link) return no("no meeting link");
  if (r.skip.some((p) => glob(p, title))) return no("its title is on the skip list");
  const people = (e.attendees ?? []).filter((a) => a.email && !a.resource);
  const me = people.find((a) => a.self);
  if (me?.responseStatus === "declined") return no("the owner declined it");
  const emails = people.map((a) => a.email!.toLowerCase());
  if (r.join === "invited" && !emails.some((x) => r.bots.includes(x))) return no("the bot is not invited");
  if (r.join === "accepted" && !(me?.responseStatus === "accepted" || e.organizer?.self || me?.organizer))
    return no("the owner has not accepted it");
  // Who is in the room sets what anyone in it may have the session do.
  const outside = emails.filter((x) => !r.bots.includes(x) && !r.team.some((d) => x.endsWith(`@${d}`)));
  const trust = outside.length ? r.trustOutside : r.trustTeam;
  if (trust === "skip") return no(`someone from outside the team is invited (${outside.length})`);
  const about = (e.description ?? "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  return {
    ...base,
    join: true,
    why: outside.length ? `${r.join}, with ${outside.length} from outside the team` : `${r.join}, team only`,
    trust,
    purpose: about ? `${title}: ${about}` : title,
  };
}
