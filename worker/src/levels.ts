/**
 * Line levels: who may do what when they call a teammate's session.
 *
 * The team page assigns each member a level by name; each repo's
 * `.agents/permissions.md` says what a name means there (a gate and rules),
 * with no people in it, so an open-source repo can carry one. The Worker never
 * reads a repo: a watcher reports its file's level names when it checks in,
 * and they are kept a month per repo so the page can offer them.
 */

import type { Env } from "./index";
import * as db from "./db";

export type Gate = "listen" | "read" | "full";
export const BUILT_IN: Gate[] = ["listen", "read", "full"];

export interface KnownLevel {
  name: string;
  /** Repo → gate, for each repo that defines it. */
  repos: Record<string, Gate>;
}

/** Every level name the team's repos define, with where and how. */
export async function knownLevels(env: Env, orgId: string): Promise<{ levels: KnownLevel[]; defaults: Record<string, string> }> {
  const byName = new Map<string, KnownLevel>();
  const defaults: Record<string, string> = {};
  for (const { key, value } of await db.stashByPrefix(env, `levels:${orgId}:`)) {
    const repo = key.slice(`levels:${orgId}:`.length);
    const r = JSON.parse(value) as { levels: Record<string, Gate>; default: string };
    defaults[repo] = r.default;
    for (const [name, gate] of Object.entries(r.levels)) {
      const k = byName.get(name) ?? { name, repos: {} };
      k.repos[repo] = gate;
      byName.set(name, k);
    }
  }
  return { levels: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), defaults };
}

/** A level an admin may assign: '' (the default), a built-in, or a word —
 *  a repo may define it later, and a repo that does not uses its default. */
export const validLevel = (level: string): boolean => level === "" || db.LEVEL_RULE.test(level);

/* ----------------------------------------------- routing to a session */

const GATES: Gate[] = BUILT_IN;

/** What a watcher's checking-in said about its repo: the level names its
 *  `.agents/permissions.md` defines with their gates, and its default. */
export interface Shared {
  userId: string;
  watcherId: string;
  repo: string;
  name?: string;
  share: string[] | "team";
  run?: string[];
  levels?: Record<string, Gate>;
  ldefault?: string;
}

/**
 * The gate a caller with `level` (from the team page; '' = default) gets in
 * one watcher's repo. A repo with a permissions file decides by its own
 * level names, and a name it does not define falls to its default, so no
 * name can widen a repo that does not know it. Without a file only the
 * built-in names mean anything. Routing only: the watcher resolves the
 * caller again from the file on disk.
 */
function gateIn(w: Shared, level: string): Gate | null {
  if (w.levels) {
    const name = level && w.levels[level] ? level : w.ldefault ?? "listen";
    return w.levels[name] ?? ((GATES as string[]).includes(name) ? (name as Gate) : null);
  }
  return (GATES as string[]).includes(level) ? (level as Gate) : null;
}

/**
 * A teammate's live watcher that will serve this caller: the one that gives
 * them the most. Their level on the team page, read against each watcher's
 * levels; a `callers:` line naming them in the file (session 17, kept so a
 * file that lists people still routes); or `--brief-for`. Only used when the
 * caller has no live watcher of their own, which always comes first.
 */
export async function sharedWatcher(
  env: Env,
  orgId: string,
  caller: { id: string; email: string | null; phone?: string; level: string },
): Promise<{ userId: string; watcherId: string; repo: string; name?: string; run: boolean } | null> {
  let best: { w: Shared; gate: Gate } | null = null;
  for (const { value } of await db.stashByPrefix(env, `liveshare:${orgId}:`)) {
    const w = JSON.parse(value) as Shared;
    if (w.userId === caller.id) continue;
    const gates = [
      gateIn(w, caller.level),
      w.run && runsFor(w.run, caller) ? "read" : null,
      w.share === "team" || (caller.email && Array.isArray(w.share) && w.share.includes(caller.email.toLowerCase())) ? "listen" : null,
    ].filter((g): g is Gate => !!g);
    for (const gate of gates)
      if (!best || GATES.indexOf(gate) > GATES.indexOf(best.gate)) best = { w, gate };
  }
  return best ? { userId: best.w.userId, watcherId: best.w.watcherId, repo: best.w.repo, name: best.w.name, run: best.gate !== "listen" } : null;
}

/** `name:gate,…` from a watcher, or null when its repo has no file. */
export function parseLevels(raw: string): Record<string, Gate> | null {
  const out: Record<string, Gate> = {};
  for (const pair of raw.split(",").slice(0, 50)) {
    const [name, gate] = pair.split(":").map((x) => x.trim());
    if (name && db.LEVEL_RULE.test(name) && (GATES as string[]).includes(gate)) out[name] = gate as Gate;
  }
  return Object.keys(out).length ? out : null;
}

/** Whether a watcher's `run` patterns (from its permissions file: emails,
 *  `*@domain`, `*`, phones) cover this caller. Routing only: the watcher
 *  resolves the caller again and gates every request itself. */
function runsFor(patterns: string[], caller: { email: string | null; phone?: string }): boolean {
  const email = (caller.email ?? "").toLowerCase();
  const digits = (s: string) => s.replace(/[^\d]/g, "");
  const phone = digits(caller.phone ?? "");
  return patterns.some((p) =>
    p === "*" ||
    (email && p === email) ||
    (email && p.startsWith("*@") && email.endsWith(p.slice(1))) ||
    (!p.includes("@") && phone && digits(p) === phone),
  );
}
