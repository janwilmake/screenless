/**
 * Who may do what on the line: `.agents/permissions.md`.
 *
 * The line proves *who* is calling (it rings the verified number back, and a
 * WhatsApp call is tied to the account). What that caller may do is the
 * owner's to say: the file names levels and what each may do here, and the
 * team page (screenless.sh/team) says which level each person has, so the
 * file holds no people and an open-source repo can carry one (session 16).
 * Screenless enforces only a coarse gate per level and hands the owner's own
 * rules to the agent as text; any permission scheme fits in that text.
 *
 *   ---
 *   default: team                 # a level this repo does not define
 *   modes:
 *     team: { gate: read }
 *     lead: { gate: full }
 *   ---
 *   ## lead
 *   May order merges into dev by PR number.
 *   ## Never
 *   Secrets go to nobody.
 *
 * A `callers:` block naming emails, `*@domain` or phones still works
 * (session 17): it decides for a caller the team page gives no level, and
 * only narrows one it does. The file lives in the repo the watcher runs
 * from, so a change goes through review. `~/.agents/permissions.md` may narrow it on one machine, never widen
 * it. A missing file changes nothing; an unreadable one is reported and
 * ignored, so a typo can only ever cost permissions, never add them.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** The ceiling screenless enforces. `listen`: nothing runs, the call is
 *  recorded for the session. `read`: reads and local work. `full`: what the
 *  session may do, except secrets. */
export type Gate = "listen" | "read" | "full";
const GATES: Gate[] = ["listen", "read", "full"];
const rank = (g: Gate) => GATES.indexOf(g);
export const lowest = (a: Gate, b: Gate): Gate => (rank(a) <= rank(b) ? a : b);

export interface Policy {
  /** The mode, or bare gate, for a teammate no caller line matches. */
  default: string;
  modes: Record<string, { gate: Gate }>;
  /** email, `*@domain`, `*`, or phone → mode name or bare gate. */
  callers: Record<string, string>;
  /** `## <mode>` sections, verbatim. */
  rules: Record<string, string>;
  /** `## Never` lines: no mode loosens them. */
  never: string[];
}

export interface Caller {
  email?: string | null;
  phone?: string | null;
  /** Their level from the team page; '' or absent = the file's default. */
  level?: string;
  /** The account owner of this terminal's screenless login. */
  owner: boolean;
}

export interface Resolved {
  mode: string;
  gate: Gate;
  rules: string;
  never: string[];
  /** Where it came from, for the watcher's output. */
  source: string;
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
const stripComment = (s: string) => s.replace(/\s+#.*$/, "");

/** Parses the file. Throws with a readable reason on anything it cannot
 *  trust; the caller turns that into a warning and no policy. */
export function parsePolicy(text: string): Policy {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no front matter: the file must start with a --- block");
  const [, head, body] = m;
  const p: Policy = { default: "listen", modes: {}, callers: {}, rules: {}, never: [] };
  let section: "modes" | "callers" | null = null;
  let mode: string | null = null;
  let sawDefault = false;

  for (const [i, raw] of head.split(/\r?\n/).entries()) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = /^\s*/.exec(line)![0].length;
    const where = `line ${i + 2}`;
    const kv = /^\s*("[^"]*"|'[^']*'|[^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${where}: expected "key: value"`);
    const key = unquote(kv[1]);
    const value = kv[2].trim();

    if (indent === 0) {
      mode = null;
      if (key === "default") {
        if (!value) throw new Error(`${where}: default needs a mode`);
        p.default = unquote(value);
        sawDefault = true;
        section = null;
      } else if (key === "modes" || key === "callers") {
        if (value) throw new Error(`${where}: ${key} takes an indented list`);
        section = key;
      } else throw new Error(`${where}: unknown key "${key}"`);
      continue;
    }
    if (section === "callers") {
      if (!value) throw new Error(`${where}: caller "${key}" needs a mode`);
      p.callers[key.toLowerCase()] = unquote(value);
    } else if (section === "modes") {
      // `name: { gate: read }` on one line, or `name:` with `gate: read` below.
      const inline = /^\{\s*gate\s*:\s*([^,}]+?)\s*\}$/.exec(value);
      if (inline) {
        p.modes[key] = { gate: gateOf(unquote(inline[1]), where) };
        mode = null;
      } else if (!value && (mode === null || indent <= 2)) {
        mode = key;
      } else if (mode && key === "gate") {
        p.modes[mode] = { gate: gateOf(unquote(value), where) };
      } else throw new Error(`${where}: a mode is "name: { gate: listen|read|full }"`);
    } else throw new Error(`${where}: indented line outside modes or callers`);
  }
  if (mode && !p.modes[mode]) throw new Error(`mode "${mode}" has no gate`);
  if (!sawDefault) throw new Error('no "default:" — say what an unlisted teammate may do');

  const known = (v: string) => v in p.modes || (GATES as string[]).includes(v);
  if (!known(p.default)) throw new Error(`default "${p.default}" is neither a mode nor listen/read/full`);
  for (const [who, v] of Object.entries(p.callers))
    if (!known(v)) throw new Error(`caller "${who}" names "${v}", which is neither a mode nor listen/read/full`);

  // `## <name>` sections. Text before the first heading is the file's own
  // introduction for people; it is not a rule.
  let current: string | null = null;
  const sections: Record<string, string[]> = {};
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      current = h[1].trim();
      sections[current] ??= [];
    } else if (current) sections[current].push(line);
  }
  for (const [name, lines] of Object.entries(sections)) {
    const text = lines.join("\n").trim();
    if (name.toLowerCase() === "never")
      p.never = lines.map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()).filter(Boolean);
    else p.rules[name] = text;
  }
  return p;
}

function gateOf(v: string, where: string): Gate {
  if ((GATES as string[]).includes(v)) return v as Gate;
  throw new Error(`${where}: gate "${v}" is not listen, read or full`);
}

const digits = (s: string) => s.replace(/[^\d]/g, "");

/** The mode a caller gets from one file: exact email, then phone, then
 *  `*@domain`, then `*`, then `default`. The owner keeps full when no line
 *  names them: the file lists people, and should not need the owner's own
 *  number to leave the owner working. A line that names the owner may
 *  narrow them. */
export function resolve(p: Policy, c: Caller, source = ""): Resolved {
  const email = (c.email ?? "").trim().toLowerCase();
  const phone = digits(c.phone ?? "");
  let hit: string | undefined;
  if (email && p.callers[email] !== undefined) hit = p.callers[email];
  if (hit === undefined && phone)
    for (const [k, v] of Object.entries(p.callers))
      if (!k.includes("@") && k !== "*" && digits(k) && digits(k) === phone) hit = v;
  // `*@domain` and `*` describe teammates; only an explicit line narrows the owner.
  if (hit === undefined && email.includes("@") && !c.owner) {
    const domain = `*@${email.split("@")[1]}`;
    if (p.callers[domain] !== undefined) hit = p.callers[domain];
  }
  if (hit === undefined && p.callers["*"] !== undefined && !c.owner) hit = p.callers["*"];
  if (hit === undefined && c.owner) return { mode: "owner", gate: "full", rules: "", never: p.never, source };
  const gateOfName = (name: string) => p.modes[name]?.gate ?? (name as Gate);
  const level = (c.level ?? "").trim();
  // A level this file does not define gets its default here: a name can
  // never widen a repo that does not know it.
  const assigned = level ? (level in p.modes || level === p.default ? level : p.default) : null;
  let name = assigned ?? hit ?? p.default;
  // A caller line only narrows a level the team page gave.
  if (assigned !== null && hit !== undefined && rank(gateOfName(hit)) < rank(gateOfName(assigned))) name = hit;
  return { mode: name, gate: gateOfName(name), rules: p.rules[name] ?? "", never: p.never, source };
}

/** What the watcher tells the Worker about this file, so the team page can
 *  offer its level names and route a teammate's call: `name:gate,…`. */
export function levelsOf(p: Policy): { levels: string; default: string } {
  const pairs = Object.entries(p.modes).map(([n, m]) => `${n}:${m.gate}`);
  if (!(p.default in p.modes) && (GATES as string[]).includes(p.default)) pairs.push(`${p.default}:${p.default}`);
  return { levels: pairs.join(","), default: p.default };
}

/** With no file: the owner full; a teammate the built-in level the team
 *  page gives them, else their words recorded for the session, never run. */
export function baseline(c: Caller): Resolved {
  if (c.owner) return { mode: "owner", gate: "full", rules: "", never: [], source: "" };
  const level = (c.level ?? "").trim();
  if ((GATES as string[]).includes(level)) return { mode: level, gate: level as Gate, rules: "", never: [], source: "team page" };
  return { mode: "teammate", gate: "listen", rules: "", never: [], source: "" };
}

/** The repo file, narrowed by the personal one: the lower gate, both rule
 *  texts, every Never line. */
export function combine(base: Resolved, personal: Resolved | null): Resolved {
  if (!personal) return base;
  return {
    mode: base.mode,
    gate: lowest(base.gate, personal.gate),
    rules: [base.rules, personal.rules && `Also, on this machine:\n${personal.rules}`].filter(Boolean).join("\n\n"),
    never: [...new Set([...base.never, ...personal.never])],
    source: [base.source, personal.source].filter(Boolean).join(" + "),
  };
}

/**
 * A meeting's asker, in a room the owner gave one level with `meet --trust`
 * (session 19). Tying a speaker to a team account rests on a display name,
 * so the room is the unit: anyone the meeting could not tie to the team gets
 * the room's level, and anyone it could gets their own, never above the
 * room's. Never lines and the personal file still narrow both.
 */
export function inRoom(l: Loaded, c: Caller, recognized: boolean, room: Gate): Resolved {
  if (recognized) {
    const r = permissionsFor(l, c);
    return { ...r, gate: lowest(r.gate, room) };
  }
  const base: Resolved = { mode: `room (${room})`, gate: room, rules: "", never: l.repo?.never ?? [], source: "the meeting's --trust" };
  return combine(base, l.personal ? resolve(l.personal, c, "~/.agents/permissions.md") : null);
}

export interface Loaded {
  repo: Policy | null;
  personal: Policy | null;
  /** Problems to show once; each means that file is ignored. */
  warnings: string[];
  paths: { repo: string; personal: string };
}

const cache = new Map<string, { stamp: string; policy: Policy | null; warning?: string }>();

function loadOne(path: string): { policy: Policy | null; warning?: string } {
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return { policy: null };
  }
  const hit = cache.get(path);
  if (hit && hit.stamp === stamp) return hit;
  let out: { policy: Policy | null; warning?: string };
  try {
    out = { policy: parsePolicy(readFileSync(path, "utf8")) };
  } catch (err) {
    out = { policy: null, warning: `${path}: ${(err as Error).message} — ignored` };
  }
  cache.set(path, { stamp, ...out });
  return out;
}

/** Reads both files, again whenever one changed on disk. */
export function loadPolicies(cwd: string, home = homedir()): Loaded {
  const paths = { repo: join(cwd, ".agents", "permissions.md"), personal: join(home, ".agents", "permissions.md") };
  const repo = loadOne(paths.repo);
  const personal = paths.personal === paths.repo ? { policy: null } : loadOne(paths.personal);
  return {
    repo: repo.policy,
    personal: personal.policy,
    warnings: [repo.warning, personal.warning].filter((w): w is string => !!w),
    paths,
  };
}

/** What a caller may do, from both files. A broken repo file counts as
 *  missing, and a broken personal one as absent: never wider than today. */
export function permissionsFor(l: Loaded, c: Caller): Resolved {
  const base = l.repo ? resolve(l.repo, c, ".agents/permissions.md") : baseline(c);
  return combine(base, l.personal ? resolve(l.personal, c, "~/.agents/permissions.md") : null);
}

/** The block every request on the call, and the session after it, is given. */
export function permissionsText(who: string, r: Resolved): string {
  const lines = [
    `Permissions for this caller (${who}): mode "${r.mode}", gate ${r.gate}${r.source ? `, from ${r.source}` : ""}.`,
  ];
  if (r.rules) lines.push(`What this mode may do, in the owner's words:\n${r.rules}`);
  if (r.never.length) lines.push(`Never, whatever the mode:\n${r.never.map((n) => `- ${n}`).join("\n")}`);
  lines.push(
    "These rules only narrow what the gate allows. Where they ask for a step this caller may not take, do not take it: say what is left for the owner.",
  );
  return lines.join("\n\n");
}
