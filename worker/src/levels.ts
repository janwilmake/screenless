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
