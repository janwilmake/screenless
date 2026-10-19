/**
 * Who is in a meeting and who said what, from the Recall bot's real-time
 * endpoint: participant events and the platform's live transcript, which
 * names every speaker. The bot itself is left out. Ported from chimein.
 *
 * Pure, so it is tested without a meeting (test/room.test.ts).
 */

export interface Participant {
  id: number;
  name: string;
  /** Recall gives an email only for some platforms and some participants. */
  email: string | null;
  /** Signed in to the meeting platform with an account, not a typed guest name. */
  signedIn: boolean;
  present: boolean;
}

export interface Utterance {
  participantId: number;
  name: string;
  text: string;
  /** Wall-clock time the utterance arrived. */
  at: number;
}

/** The first name people use to address the bot: "Rex Hunter (AI)" -> "Rex". */
export function wakeName(botName: string): string {
  return botName.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0] || "Claude";
}

/** The bot's name as people say it, and as speech-to-text tends to write it. */
export function wakeRegex(botName: string): RegExp {
  const name = wakeName(botName).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const variants = name === "claude" ? ["claude", "claud", "cloud", "clod", "klaud", "clawed", "clode", "cloude"] : [name || "claude"];
  return new RegExp(`\\b(${variants.join("|")})\\b`, "i");
}

/** Names compared the way people type them: case, accents and spacing aside. */
export const normName = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length > 1);

export class Room {
  readonly participants = new Map<number, Participant>();
  readonly utterances: Utterance[] = [];
  /** Called with each new utterance, for the transcript. */
  onUtterance?: (u: Utterance) => void;

  private botName: string;

  constructor(botName: string) {
    this.botName = botName;
  }

  present(): Participant[] {
    return [...this.participants.values()].filter((p) => p.present);
  }

  /**
   * Who asked. The voice model's transcript names no speaker; the platform's
   * does, but each transcriber mishears different words ("Claude" became
   * "lord"). So the asker is the speaker of the recent utterance that shares
   * the most words with the question; one with the bot's name wins a tie.
   */
  askerOf(question: string, wake: RegExp, since: number): Participant | undefined {
    const q = new Set(words(question));
    let best: Utterance | undefined;
    let bestScore = 0;
    for (let i = this.utterances.length - 1; i >= 0; i--) {
      const u = this.utterances[i];
      if (u.at < since) break;
      const uw = words(u.text);
      const shared = uw.filter((w) => q.has(w)).length;
      if (shared < 3 && !(wake.test(u.text) && shared >= 1)) continue;
      const score = shared / Math.max(uw.length, 1) + (wake.test(u.text) ? 0.2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    return best && bestScore >= 0.5 ? this.participants.get(best.participantId) : undefined;
  }

  /** One message from Recall's real-time WebSocket endpoint. */
  handle(raw: string, now = Date.now()): void {
    let msg: { event?: string; data?: { data?: RecallData } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const inner = msg?.data?.data;
    const p = inner?.participant;
    if (!p || normName(p.name ?? "") === normName(this.botName)) return;
    const known = this.participants.get(p.id);
    const person: Participant = {
      id: p.id,
      name: p.name ?? `participant ${p.id}`,
      email: p.email ?? known?.email ?? null,
      signedIn: !!p.extra_data?.google_meet?.static_participant_id || (known?.signedIn ?? false),
      present: msg.event !== "participant_events.leave",
    };
    if (msg.event === "transcript.data") {
      // A speaker who was here before the bot joined may have had no join event.
      person.present = true;
      const text = (inner?.words ?? []).map((w) => w.text).join(" ").trim();
      if (text) {
        const u = { participantId: p.id, name: person.name, text, at: now };
        this.utterances.push(u);
        if (this.utterances.length > 2000) this.utterances.shift();
        this.onUtterance?.(u);
      }
    }
    this.participants.set(p.id, person);
  }
}

interface RecallData {
  participant?: {
    id: number;
    name?: string | null;
    email?: string | null;
    extra_data?: { google_meet?: { static_participant_id?: string } };
  };
  words?: Array<{ text: string }>;
}

/** A member of the team, as the meeting may match them. */
export interface Member {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  level: string;
}

/**
 * The team member a meeting participant is, or null for a guest. An email the
 * platform gives is proof enough. A display name is not: anyone can type
 * one, so a name counts only for a participant signed in to the platform,
 * and only when exactly one member has it.
 */
export function memberOf(p: Participant, team: Member[]): Member | null {
  const email = (p.email ?? "").trim().toLowerCase();
  if (email) return team.find((m) => (m.email ?? "").toLowerCase() === email) ?? null;
  if (!p.signedIn) return null;
  const name = normName(p.name);
  const hits = team.filter((m) => m.name && normName(m.name) === name);
  return hits.length === 1 ? hits[0] : null;
}

/** What the bot asks Recall for: the live transcript with speaker names, and
 *  participant events, sent to `endpointUrl` over a WebSocket. */
export function realtimeConfig(endpointUrl: string): Record<string, unknown> {
  return {
    transcript: {
      provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
      diarization: { use_separate_streams_when_available: true },
    },
    realtime_endpoints: [
      {
        type: "websocket",
        url: endpointUrl,
        events: [
          "transcript.data",
          "participant_events.join",
          "participant_events.leave",
          "participant_events.update",
          "participant_events.speech_on",
        ],
      },
    ],
  };
}
