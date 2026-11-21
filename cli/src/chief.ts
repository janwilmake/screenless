/**
 * The chief: one watcher that answers for every Claude Code session on this
 * machine, not only its own (session 21, `screenless watch --chief`).
 *
 * Its brief is built from Roost (the session strip, 127.0.0.1:4777), which
 * already holds each session's title, notes and badge, and is rebuilt every
 * 20 s with no model, so it is ready before the phone rings. There are two:
 * the owner's, of every session, and the team's, of only the sessions working
 * in one of the team's repositories (`--team-repos`, matched on the git
 * origin of each session's folder). Everything else is the owner's private
 * work, and a teammate's call never hears of it, nor that it exists.
 *
 * On a call the chief routes; it does not do the work. A request goes to the
 * session whose work it is, as one message, by the name Claude Code's
 * SendMessage knows it by (Roost's `agentName`). Status is never asked for by
 * message: every message starts a turn and leaves a red dot, and the notes
 * already say where each session stands.
 *
 * Without Roost the chief has nothing to say about other sessions, and says
 * so; the watcher otherwise works as it always did.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOST = "http://127.0.0.1:4777/api/sessions";
const EVERY_MS = 20_000;

interface RoostSession {
  id: string;
  pid?: number;
  title?: string;
  agentName?: string;
  status?: string;
  waiting?: number;
  notes?: string | null;
  deadline?: string | number | null;
}

export interface Row {
  agent: string;
  title: string;
  about: string;
  /** The customer-watch header, e.g. "Late: 3 · Waiting for us: 7". */
  header: string;
  forYou: string[];
  waiting: number;
  late: number;
  deadline: number | null;
  team: boolean;
}

/** The parts of a Roost note the brief uses. */
export function parseNotes(notes: string): { about: string; header: string; forYou: string[] } {
  const lines = notes.split("\n").map((l) => l.trim());
  const header = lines.find((l) => /(^|— )Late: \d+|Waiting for us: \d+/.test(l)) ?? "";
  const about = (lines.find((l) => l.startsWith("About:")) ?? "").replace(/^About:\s*/, "");
  const forYou: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (/^Waiting for you:?$/i.test(l)) inside = true;
    else if (inside && l.startsWith("- ")) forYou.push(l.slice(2));
    else if (inside && l) inside = false;
  }
  return { about, header, forYou };
}

/** "owner/name" of a git remote URL, for matching a team's repositories. */
export function repoOf(url: string): string {
  const m = url.trim().replace(/\.git$/, "").match(/[:/]([^/:]+\/[^/]+)$/);
  return m ? m[1].toLowerCase() : "";
}

const origins = new Map<string, string>();
function originOf(cwd: string): string {
  if (!origins.has(cwd)) {
    let url = "";
    try {
      url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    } catch {
      /* not a repository */
    }
    origins.set(cwd, repoOf(url));
  }
  return origins.get(cwd)!;
}

function cwdOf(pid?: number): string {
  if (!pid) return "";
  try {
    return String(JSON.parse(readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8")).cwd ?? "");
  } catch {
    return "";
  }
}

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export class ChiefBrief {
  private rows: Row[] = [];
  private builtAt = 0;
  private building = false;
  private reached = false;

  constructor(private o: { teamRepos: string[]; selfSession?: string; owner?: string }) {}

  /** Cheap on every poll: rebuilds in the background every 20 s. */
  refresh(): void {
    if (this.building || Date.now() - this.builtAt < EVERY_MS) return;
    this.building = true;
    void this.build().finally(() => {
      this.building = false;
      this.builtAt = Date.now();
    });
  }

  private async build(): Promise<void> {
    let sessions: RoostSession[];
    try {
      const res = await fetch(ROOST, { signal: AbortSignal.timeout(2000) });
      sessions = ((await res.json()) as { sessions: RoostSession[] }).sessions ?? [];
      this.reached = true;
    } catch {
      this.reached = false;
      return;
    }
    const team = new Set(this.o.teamRepos.map((r) => r.toLowerCase()));
    this.rows = sessions
      .filter((s) => s.id !== this.o.selfSession && s.agentName)
      .map((s) => {
        const n = parseNotes(s.notes ?? "");
        // A customer header counts its late items itself; otherwise count them.
        const headerLate = n.header.match(/Late: (\d+)/);
        const late = headerLate ? Number(headerLate[1]) : n.forYou.filter((i) => /\blate\b/i.test(i)).length;
        const d = s.deadline == null ? NaN : typeof s.deadline === "number" ? s.deadline : Date.parse(s.deadline);
        const cwd = cwdOf(s.pid);
        return {
          agent: s.agentName!,
          title: s.title || n.about || s.agentName!,
          about: n.about,
          header: n.header,
          forYou: n.forYou,
          waiting: s.waiting ?? n.forYou.length,
          late,
          deadline: Number.isFinite(d) ? d : null,
          team: team.size > 0 && !!cwd && team.has(originOf(cwd)),
        };
      })
      // Most urgent first: what is late, then the nearest deadline, then
      // what waits on the owner the most.
      .sort(
        (a, b) =>
          b.late - a.late ||
          (a.deadline ?? Infinity) - (b.deadline ?? Infinity) ||
          b.waiting - a.waiting,
      );
  }

  /** One line per session. Short for the voice, which needs where each
   *  stands; fuller for routing, which needs to tell sessions apart. */
  private lines(rows: Row[], routing: boolean): string {
    const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    return rows
      .map((r) => {
        let line = `- ${r.title}${routing ? ` [${r.agent}]` : ""}`;
        if (r.about && r.about !== r.title) line += `: ${clip(r.about, routing ? 160 : 80)}`;
        const counts = [r.late ? `${r.late} late` : "", r.waiting ? `${r.waiting} waiting` : ""].filter(Boolean).join(", ");
        if (counts) line += ` (${counts})`;
        const items = r.forYou.slice(0, routing ? 3 : 1).map((i) => clip(i, routing ? 140 : 100));
        if (items.length) line += `. Next: ${items.join("; ")}`;
        if (r.deadline) line += `. Due ${when(r.deadline)}`;
        return line;
      })
      .join("\n");
  }

  private brief(team: boolean): string {
    if (!this.reached) return "The list of the owner's other Claude Code sessions is not available right now (Roost is not running).";
    const rows = this.rows.filter((r) => !team || r.team);
    const need = rows.filter((r) => r.waiting > 0).length;
    const head = team
      ? `You speak for the team's Claude Code sessions on this machine: ${rows.length} sessions, ${need} with something waiting. These are the only sessions that exist as far as this caller is concerned; never mention or hint at any others.`
      : `You speak for all of ${this.o.owner || "the owner"}'s Claude Code sessions on this machine: ${rows.length} sessions, ${need} with something waiting on the owner. Most urgent first. Answer where things stand from this list, briefly; never read it out.`;
    // The voice needs where things stand, not anyone's address or number.
    return `${head}\n\n${redact(this.lines(rows, false))}`.slice(0, 8000);
  }

  /** What the voice knows on the owner's call. */
  current(): string {
    return this.brief(false);
  }

  /** What the voice knows on a teammate's call: the team's sessions only. */
  forTeammate(): string {
    return this.brief(true);
  }

  /** The rules and the table a request on the owner's call routes by. */
  routing(): string {
    return `${CHIEF_RULES}\n\nThe sessions (title [name to message], what it is about, what waits):\n${this.lines(this.rows, true) || "(none: Roost is not running)"}`.slice(0, 12_000);
  }
}

/** Email addresses and phone numbers out of what the voice hears. */
export const redact = (t: string): string =>
  t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]").replace(/\+?\d[\d ()-]{7,}\d/g, "[number]");

export const CHIEF_RULES = `You are the chief of the owner's Claude Code sessions on this machine, answering a request from a phone call. You route; you do not do the work, even when you could.
- Status questions ("what needs me?", "how is X going?") are answered from the table below, never by messaging a session, when the table holds the answer.
- When it does not (work started minutes ago, "has Cody picked up the tickets yet?"), do not investigate yourself: ask the one session whose work it is, by message, and say so.
- When the caller asks for something to be done, find the one session whose work it is. Send it one message with SendMessage, to its name exactly as in brackets below: what the caller asked, in their words, and that it came from the owner's phone call. Then answer in one spoken sentence which session got it.
- Every message ends with: "Answer by updating your Roost notes (what you did, what waits on the owner); do not reply by message, the sender is a one-off run that has ended." The table below is rebuilt from those notes every 20 seconds, so later requests in this call see the answer there.
- What was already sent or decided in this call (see the call so far) wins over the table, which can lag by minutes: never tell the owner something waits on them that they settled earlier in this call.
- A message starts a turn in that session and leaves a red dot: send one only when a session must act or the table cannot answer, and never to several sessions for one request.
- If no session fits, or more than one could, do not guess: say which ones you considered and ask the caller which.
- If the request is for this session itself (screenless), do it as usual.`;
