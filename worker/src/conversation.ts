/**
 * What a call and a meeting share (session 19): when the voice speaks, how
 * it hands a request to the session, and how it says the result. A phone
 * call can have several people on speaker, and a meeting can come down to
 * one person, so neither is fixed by the kind of call: it is the number of
 * people the voice is talking with.
 *
 * - **direct**: one other person. Everything they say is to the voice, as on
 *   a phone call; waiting for its name would be odd.
 * - **addressed**: several. The voice speaks only when someone says its
 *   name; people mostly talk to each other.
 */

export type Speaking = "direct" | "addressed";

/** A request with no answer by now gets one line, in the voice's own
 *  words, that it is under way; one answered sooner, or refused, gets none. */
export const ACK_AFTER_MS = 4_000;

/** How long a new head count has to hold before the voice's rules change:
 *  a dropped connection or a late joiner should not flip them back and forth. */
export const SPEAKING_SETTLE_MS = 10_000;

/** Exactly one person besides the voice: direct. Nobody known yet stays
 *  addressed, so the seconds before the platform says who is there cannot
 *  make the voice answer a room's chatter. */
export const speakingFor = (others: number): Speaking => (others === 1 ? "direct" : "addressed");

/** The "When to speak" section, for the voice's instructions. */
export function speakingRules(mode: Speaking, name: string, o: { phone?: boolean } = {}): string {
  if (mode === "direct")
    return `# When to speak
You are talking with one person. What they say is said to you: answer it, without waiting for your name.${
      o.phone
        ? `
If you notice that several people are on the line (more than one voice, or someone says you are on speaker), respond only when someone addresses you by name ("${name}") until it is one person again.`
        : ""
    }
Keep listening while they pause to think. Do not treat a cough, music, typing or a side conversation as a request.`;
  return `# When to speak
Several people are here. Respond only when somebody addresses you by name ("${name}") and asks or tells you something, or when the result of one of your own requests arrives.
Otherwise, keep listening. People mostly talk to each other, not to you. A question between two people is not a question to you, and a question asked of the room ("did we decide...", "does anyone know...") is not addressed to you, even when you know the answer. Only your name makes a question yours.
Keep listening while people pause to think. Do not treat a cough, music, typing or a side conversation as a request.`;
}

/** Told to a voice that is already talking, when the head count changes. */
export function speakingSwitch(mode: Speaking, name: string): string {
  return mode === "direct"
    ? `From now on you are talking with one person: answer what they say to you without waiting for your name ("${name}").`
    : `Several people are here now: from now on respond only when somebody addresses you by name ("${name}"), or when one of your results arrives.`;
}

/**
 * How the voice hands work to the session. The same on a call and in a
 * meeting but for one thing, when it says that it is on it:
 * - in a meeting, nothing at once: a line in its own words only when the
 *   answer takes longer than ACK_AFTER_MS, and the speech gate enforces it;
 * - on a call, one line in its own words right away. Told to stay silent
 *   instead, the voice on a test call stopped delegating and answered
 *   itself ("370 lines" for a 72-line file); with the line, it delegated
 *   and the answer was right (session 19).
 */
export function handoffRules(o: { ackAtOnce: boolean }): string {
  return `- Do not delegate greetings, small talk, or questions about yourself or whether you can hear people ("are you there?", "can you hear me?"): answer those yourself, in a few words.
${
    o.ackAtOnce
      ? `- When you delegate, say one short line in your own words about what is being done, such as "Let me check the repo." or "I'll look at the logs.", and stop. Vary it; never just "On it."`
      : "- When you delegate, say nothing and go quiet. If the work takes a while you will be told to say so, in your own words."
  }
- Never say you pass it on, hand it over or are waiting for it, and never guess the result while it works.
- Several requests can run at once; delegate each one separately.
- If someone asks how it is going, say you are still working on it.`;
}

/** How the voice says what comes back. */
export const RESULT_RULES = `- A result arrives as commentary. Say first which question it answers when more than one is open, then the answer, in at most three short sentences: under about 20 seconds. Keep its meaning exact: names, numbers and yes-or-no answers word for word.
- For a list, say how many there are and the two or three that matter most, and offer the rest. Never read out code, long lists, file paths, URLs or secrets.
- Progress may arrive as commentary that starts "Still working on it". Say it in one short sentence at a natural pause, and make clear it is not done yet.`;

/** The line the voice is asked for when a request has had no answer for
 *  ACK_AFTER_MS: what is being done, in its own words, never a fixed phrase. */
export const ackText = (request: string, asker?: string): string =>
  `The session is working on "${request.slice(0, 160)}"${asker ? ` for ${asker}` : ""}. Tell them in one short sentence, in your own words, what is being done for it, such as looking something up, checking the code or making the change. Vary the wording; never just "On it." Then go quiet; the answer follows.`;

/** A request whose asker may not have anything run: the voice answers what
 *  the conversation itself holds, and otherwise says it is kept for afterwards. */
export const refusalText = (name: string, request: string): string =>
  `${name}'s permissions do not let the session run requests during this conversation. If what you heard answers "${request.slice(0, 160)}", answer it now, briefly. Otherwise say in one sentence that it is noted in the transcript for afterwards. Do not say you are working on it.`;
