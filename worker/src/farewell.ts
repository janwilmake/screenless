/**
 * When the line may hang up by itself.
 *
 * Only after both sides said goodbye: the caller first (or asked to be hung
 * up on), then the voice. Hanging up on someone mid-sentence reads as broken
 * — answering-machine detection taught that, hanging up on two of four real
 * people — while a call left open a few seconds too long costs pennies. So
 * the lists are narrow, and any further speech from the caller cancels.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();

/** Asking to be hung up on: on its own enough to end the call, once the
 *  caller then stays quiet. */
const HANGUP_ASK = [
  /\b(you can|please|just|can you|could you)( now| just| please)? hang up\b|\bhang up( now| please)?$/,
  /\b(ophangen|hang (maar |nu )?op)\b/,
];

const CALLER_BYE = [
  /\b(good ?bye|bye(-bye| bye)?|bye now|see you|see ya|talk (to you )?(later|soon|tomorrow)|speak (to you )?(later|soon)|have a (good|nice|great) (one|day|evening|night|weekend))\b/,
  // Leaving without the word: "I'm gonna go now", "I have to go", "that's all".
  /\b((i'?m|i am) (gonna|going to) (go|leave|hang up)|(i|i've) (have|got) to go|gotta go)( now)?( then)?$|^(that's|that is) (all|it)( for now)?$/,
  /\b(doei|dag dag|doeg|tot (ziens|later|straks|morgen|zo)|fijne dag|ik (ga|moet) (nu )?(gaan|ophangen|weg))\b/,
  ...HANGUP_ASK,
];

const VOICE_BYE = [/\b(good ?bye|bye(-bye)?|bye now|take care|talk (to you )?(soon|later))\b/, /\b(doei|dag|tot (ziens|later|straks|zo))\b/];

/** The caller is ending the call. */
export const callerSaysBye = (text: string): boolean => CALLER_BYE.some((r) => r.test(norm(text)));

/** The caller asked the line to hang up. */
export const callerAsksHangup = (text: string): boolean => HANGUP_ASK.some((r) => r.test(norm(text)));

/** The voice said goodbye: a short closing line, not a sentence that merely
 *  contains "bye" somewhere in an answer. */
export function voiceSaysBye(text: string): boolean {
  const t = norm(text);
  return t.split(" ").length <= 14 && VOICE_BYE.some((r) => r.test(t));
}

/** How long the caller must stay quiet after the voice's goodbye. */
export const HANGUP_AFTER_MS = 2500;

/** How long after "please hang up" the line waits for the voice's goodbye
 *  before hanging up without one. */
export const HANGUP_ON_REQUEST_MS = 6000;
