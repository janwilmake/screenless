#!/usr/bin/env node
/**
 * Collects the facts an edition is built from. Deterministic only — this script
 * makes no judgements about what matters, because that is the part worth
 * spending a model on.
 *
 *   node press/bin/collect.mjs --repo /path/to/repo [--days 7] > facts.json
 *
 * Sources: `git` for history and composition, `gh` for pull requests. Linear is
 * deliberately absent: it is reachable over MCP from inside Claude Code, which
 * is where the skill adds it. Anything requiring auth degrades to an empty
 * section rather than failing the run — a paper with one section missing is
 * still worth printing at 06:00.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/* -------------------------------------------------------------------- args */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const REPO = resolve(flag("repo", process.cwd()));
const DAYS = Number(flag("days", "7"));
const LONG = Number(flag("long-days", "30"));

if (!existsSync(join(REPO, ".git"))) {
  console.error(`not a git repository: ${REPO}`);
  process.exit(1);
}

/* ------------------------------------------------------------------- shell */

const run = (cmd, cmdArgs, { json = false, allowFail = true } = {}) => {
  try {
    const out = execFileSync(cmd, cmdArgs, {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return json ? JSON.parse(out) : out;
  } catch (err) {
    if (!allowFail) throw err;
    return json ? null : "";
  }
};

const days = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/**
 * Collapse a file path to an "area" — the unit the paper reports on. Two
 * segments is the sweet spot: `app/routes` says something, `app` does not, and
 * `app/routes/api/candidates` is too granular to fit on a page.
 */
const area = (path) => {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1) return parts[0];
  const skip = new Set(["src", "app", "lib", "packages", "apps"]);
  if (skip.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts.slice(0, 2).join("/");
};

/**
 * Files that move a lot but mean nothing. Lockfiles alone will outweigh every
 * hand-written area in a churn chart and make the map useless.
 */
const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|mp4)$/i;
const isNoise = (path) => GENERATED.test(path) || BINARY.test(path);

const tally = (pairs) => {
  const map = new Map();
  for (const [key, n] of pairs) map.set(key, (map.get(key) ?? 0) + n);
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
};

/* ------------------------------------------------------------ git activity */

/** Churn per area over a window, measured in lines added+removed. */
function churn(since) {
  const raw = run("git", ["log", `--since=${since} days ago`, "--numstat", "--format=%x00%H%x00%aI"]);
  const pairs = [];
  let commits = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("\0")) {
      commits += 1;
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    if (isNoise(m[3])) continue;
    const add = m[1] === "-" ? 0 : Number(m[1]);
    const del = m[2] === "-" ? 0 : Number(m[2]);
    pairs.push([area(m[3]), add + del]);
  }
  return { areas: tally(pairs), commits };
}

/** Commits per day for the window, oldest→newest. Feeds the masthead spark. */
function commitsPerDay(window) {
  const raw = run("git", ["log", `--since=${window} days ago`, "--format=%aI"]);
  const buckets = new Map();
  for (let d = window - 1; d >= 0; d -= 1) {
    buckets.set(new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), 0);
  }
  for (const line of raw.split("\n").filter(Boolean)) {
    const key = line.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

/** Every tracked file's area, weighted by size — the product's composition. */
function composition() {
  const files = run("git", ["ls-files"]).split("\n").filter(Boolean);
  const pairs = [];
  const docs = [];
  for (const f of files) {
    if (isNoise(f) || /\.svg$/i.test(f)) continue;
    if (/\.(md|mdx)$/i.test(f)) docs.push(f);
    pairs.push([area(f), 1]);
  }
  return { areas: tally(pairs), docs, fileCount: files.length };
}

/** How long since each area was last touched — the neglect view. */
function staleness(areas) {
  return areas
    .map(({ label }) => {
      const iso = run("git", ["log", "-1", "--format=%aI", "--", label]).trim();
      return iso ? { label, days: days(iso) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.days - a.days);
}

/* -------------------------------------------------------------- pull reqs */

/**
 * How many pull requests to ask GitHub for.
 *
 * The first version asked for 60 and filtered to the window locally, which on a
 * busy repo is a silent lie: hyre merged 159 in seven days and the paper
 * reported 60 without saying so. A collector that under-reports is worse than
 * one that errors, because the whole arrangement rests on scripts owning the
 * facts and the model trusting them.
 *
 * So: ask for far more than any week should contain, scope the merged query
 * server-side by date, and — when the ceiling is actually reached — say so in
 * the output rather than quietly truncating.
 */
const PR_LIMIT = 500;

function pullRequests() {
  const open = run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(PR_LIMIT),
      "--json",
      "number,title,author,createdAt,updatedAt,isDraft,additions,deletions,changedFiles,labels,headRefName,url",
    ],
    { json: true },
  );

  // Filtered by GitHub rather than locally, so the limit applies to the window
  // we care about instead of to all history.
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const merged = run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--search",
      `merged:>=${since}`,
      "--limit",
      String(PR_LIMIT),
      "--json",
      "number,title,author,mergedAt,additions,deletions,changedFiles,url",
    ],
    { json: true },
  );

  if (!open && !merged) return { available: false, open: [], mergedRecently: [] };

  // Hitting the ceiling exactly is indistinguishable from having exactly that
  // many, so treat it as suspect and let the edition say the number is a floor.
  const truncated = (open ?? []).length >= PR_LIMIT || (merged ?? []).length >= PR_LIMIT;

  return {
    available: true,
    truncated,
    limit: PR_LIMIT,
    open: (open ?? []).map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author?.login ?? "unknown",
      ageDays: days(p.createdAt),
      idleDays: days(p.updatedAt),
      draft: p.isDraft,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      labels: (p.labels ?? []).map((l) => l.name),
      branch: p.headRefName,
      url: p.url,
    })),
    mergedRecently: (merged ?? [])
      .filter((p) => days(p.mergedAt) <= DAYS)
      .map((p) => ({
        number: p.number,
        title: p.title,
        author: p.author?.login ?? "unknown",
        mergedDaysAgo: days(p.mergedAt),
        additions: p.additions,
        deletions: p.deletions,
        changedFiles: p.changedFiles,
        url: p.url,
      })),
  };
}

/** Which areas each open PR touches — the link between a ticket and the map. */
function prTouchedAreas(open) {
  const base = run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim().split("/").pop() || "main";
  return open.map((pr) => {
    const files = run("gh", ["pr", "diff", String(pr.number), "--name-only"]) || "";
    const list = files.split("\n").filter(Boolean);
    return {
      number: pr.number,
      areas: tally(list.map((f) => [area(f), 1])).slice(0, 6),
      fileCount: list.length,
      base,
    };
  });
}

/* -------------------------------------------------------------------- main */

const comp = composition();
const short = churn(DAYS);
const long = churn(LONG);
const prs = pullRequests();

const facts = {
  generatedAt: new Date().toISOString(),
  repo: {
    path: REPO,
    name: REPO.split("/").filter(Boolean).pop(),
    remote: run("git", ["remote", "get-url", "origin"]).trim() || null,
    head: run("git", ["rev-parse", "--short", "HEAD"]).trim(),
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  },
  window: { days: DAYS, longDays: LONG },
  composition: {
    areas: comp.areas.slice(0, 24),
    fileCount: comp.fileCount,
    docs: comp.docs.slice(0, 60),
    docCount: comp.docs.length,
  },
  activity: {
    commitsLastWindow: short.commits,
    commitsLongWindow: long.commits,
    churnByArea: short.areas.slice(0, 16),
    churnByAreaLong: long.areas.slice(0, 16),
    commitsPerDay: commitsPerDay(DAYS),
    commitsPerDayLong: commitsPerDay(LONG),
  },
  staleness: staleness(comp.areas.slice(0, 16)),
  pullRequests: prs,
  prAreas: prs.available ? prTouchedAreas(prs.open.slice(0, 20)) : [],
};

process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
