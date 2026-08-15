/**
 * The languages a call can be held in.
 *
 * Ten, because that is what the transcription side actually supports —
 * Deepgram's multilingual model covers exactly this set, and it is the
 * bottleneck. Telnyx has hosted voices in far more languages, but a voice
 * without transcription gives you an assistant that talks and cannot listen.
 *
 * Each entry names a `Telnyx.Ultra` voice, which runs on Telnyx's own GPUs:
 * no third-party key to hold, and no extra network hop mid-call.
 */

export interface Language {
  /** Passed to Telnyx as the assistant's language. */
  code: string;
  /** Shown in the CLI picker. */
  label: string;
  /** Telnyx-hosted voice id. */
  voice: string;
  /**
   * Opening line. EU AI Act Article 50 requires the caller be told they are
   * speaking to a machine, so this is hard-coded per language rather than left
   * to the system prompt — a prompt instruction is something a model can skip,
   * and this one is a legal obligation in every market we dial.
   */
  greeting: string;
}

/**
 * English first and Dutch second, deliberately: English is the default and
 * Dutch is where this started, so those are the two anyone is most likely to
 * want. The rest are alphabetical by label.
 */
export const LANGUAGES: Language[] = [
  {
    code: "en",
    label: "English",
    voice: "Telnyx.Ultra.00967b2f-88a6-4a31-8153-110a92134b9f",
    greeting: "Hi, you're speaking with an AI assistant. ",
  },
  {
    code: "nl",
    label: "Nederlands",
    voice: "Telnyx.Ultra.0eb213fe-4658-45bc-9442-33a48b24b133",
    greeting: "Hoi, je spreekt met een AI-assistent. ",
  },
  {
    code: "fr",
    label: "Français",
    voice: "Telnyx.Ultra.0418348a-0ca2-4e90-9986-800fb8b3bbc0",
    greeting: "Bonjour, vous parlez avec un assistant IA. ",
  },
  {
    code: "de",
    label: "Deutsch",
    voice: "Telnyx.Ultra.0b66a153-548f-4f2c-b734-09a13b0bd163",
    greeting: "Hallo, Sie sprechen mit einem KI-Assistenten. ",
  },
  {
    code: "hi",
    label: "हिन्दी (Hindi)",
    voice: "Telnyx.Ultra.098fb15d-2597-4186-8b74-25340050b6e7",
    greeting: "नमस्ते, आप एक AI सहायक से बात कर रहे हैं। ",
  },
  {
    code: "it",
    label: "Italiano",
    voice: "Telnyx.Ultra.029c3c7a-b6d9-44f0-814b-200d849830ff",
    greeting: "Ciao, stai parlando con un assistente IA. ",
  },
  {
    code: "ja",
    label: "日本語 (Japanese)",
    voice: "Telnyx.Ultra.177df681-25b1-48c2-bb47-03ca5fa27f0a",
    greeting: "こんにちは、AIアシスタントが対応しています。",
  },
  {
    code: "pt",
    label: "Português",
    voice: "Telnyx.Ultra.07b6f895-78b9-4921-8e10-8a21c99c2e8a",
    greeting: "Olá, você está falando com um assistente de IA. ",
  },
  {
    code: "ru",
    label: "Русский (Russian)",
    voice: "Telnyx.Ultra.064b17af-d36b-4bfb-b003-be07dba1b649",
    greeting: "Здравствуйте, вы разговариваете с ИИ-ассистентом. ",
  },
  {
    code: "es",
    label: "Español",
    voice: "Telnyx.Ultra.02aeee94-c02b-456e-be7a-659672acf82d",
    greeting: "Hola, está hablando con un asistente de IA. ",
  },
];

export const DEFAULT_LANGUAGE = "en";

/**
 * "multi" is not a language but a mode: it lets the transcriber follow
 * code-switching mid-sentence, which is how bilingual people actually talk.
 * It borrows the voice and greeting of the account's chosen language.
 */
export const MULTI = "multi";

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));

export const isSupportedLanguage = (code: unknown): code is string =>
  typeof code === "string" && (code === MULTI || byCode.has(code));

/** Falls back to English rather than throwing — a call in the wrong language beats no call. */
export const languageOf = (code: string): Language =>
  byCode.get(code) ?? byCode.get(DEFAULT_LANGUAGE)!;
