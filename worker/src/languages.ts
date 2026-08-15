/**
 * The languages a call can be held in.
 *
 * Ten, because that is what the transcription side actually supports —
 * Deepgram's multilingual model covers exactly this set, and it is the
 * bottleneck. Telnyx has hosted voices in far more languages, but a voice
 * without transcription gives you an assistant that talks and cannot listen.
 *
 * Voices are chosen on measured latency, and are deliberately *not* Telnyx-hosted
 * one. Telnyx's own TTS renders nothing on a PSTN call — the model replies, the
 * text is logged as an assistant turn, and no audio is ever produced. Telnyx
 * support confirmed it from their side: on a day of failed calls there were
 * "only 2 TTS records, neither associated with a call session". Every
 * Telnyx-hosted voice we tried was silent, including the default they pick when
 * `voice_settings` is omitted; the first third-party voice tried worked
 * immediately. See telnyx-bug/ for the reproduction.
 *
 * Latency was measured against /v2/text-to-speech/speech, three runs per voice,
 * one sentence. English is a clear win for AWS: Joanna-Neural ~300ms against
 * Azure Ava's ~525ms, saved on every turn. Dutch is a coin flip — Azure Fenna
 * ~396ms and AWS Laura-Neural ~418ms sit inside run-to-run noise — so Fenna
 * stays, having held a real conversation on the first call that worked.
 * AWS Polly's non-neural voices (Lotte, Ruben) are ~100ms faster still and
 * audibly worse; not worth it when the voice is the whole product.
 *
 * Caveat: this measures time to render a complete clip, not time to first
 * audio in a streaming call, which is what a caller actually waits through.
 * Treat it as a proxy and re-measure if a language ever feels sluggish.
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
    voice: "AWS.Polly.Joanna-Neural",
    greeting: "Hi, you're speaking with an AI assistant. ",
  },
  {
    code: "nl",
    label: "Nederlands",
    voice: "Azure.nl-NL-FennaNeural",
    greeting: "Hoi, je spreekt met een AI-assistent. ",
  },
  {
    code: "fr",
    label: "Français",
    voice: "Azure.fr-FR-DeniseNeural",
    greeting: "Bonjour, vous parlez avec un assistant IA. ",
  },
  {
    code: "de",
    label: "Deutsch",
    voice: "Azure.de-DE-KatjaNeural",
    greeting: "Hallo, Sie sprechen mit einem KI-Assistenten. ",
  },
  {
    code: "hi",
    label: "हिन्दी (Hindi)",
    voice: "Azure.hi-IN-AnanyaNeural",
    greeting: "नमस्ते, आप एक AI सहायक से बात कर रहे हैं। ",
  },
  {
    code: "it",
    label: "Italiano",
    voice: "Azure.it-IT-ElsaNeural",
    greeting: "Ciao, stai parlando con un assistente IA. ",
  },
  {
    code: "ja",
    label: "日本語 (Japanese)",
    voice: "Azure.ja-JP-NanamiNeural",
    greeting: "こんにちは、AIアシスタントが対応しています。",
  },
  {
    code: "pt",
    label: "Português",
    voice: "Azure.pt-BR-FranciscaNeural",
    greeting: "Olá, você está falando com um assistente de IA. ",
  },
  {
    code: "ru",
    label: "Русский (Russian)",
    voice: "Azure.ru-RU-SvetlanaNeural",
    greeting: "Здравствуйте, вы разговариваете с ИИ-ассистентом. ",
  },
  {
    code: "es",
    label: "Español",
    voice: "Azure.es-ES-ElviraNeural",
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
