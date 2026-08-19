/**
 * Thin fetch wrapper over the Telnyx v2 REST API.
 *
 * We deliberately avoid the `telnyx` npm SDK here: it is generated for Node and
 * pulls in a lot of surface we do not need. Workers give us `fetch` natively,
 * and we only touch six endpoints.
 */

const BASE = "https://api.telnyx.com/v2";

export class TelnyxError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`Telnyx ${status} on ${path}: ${JSON.stringify(body)}`);
    this.name = "TelnyxError";
  }
}

async function call<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new TelnyxError(res.status, path, parsed ?? text);
  return parsed as T;
}

/* ------------------------------------------------------------------ verify */

export interface VerifyProfile {
  data: { id: string; name: string };
}

/**
 * Creates the Verify profile the OTP flow needs. Run once via `POST /admin/verify-profile`;
 * the returned id goes into the TELNYX_VERIFY_PROFILE_ID secret.
 *
 * `whitelisted_destinations` gates which countries may receive an OTP. It is
 * conditionally required depending on how your org is configured, and the value
 * doubles as a spend guard — leaving it as ["*"] means an attacker can pump SMS
 * to any country on your dime.
 */
export function createVerifyProfile(apiKey: string, destinations: string[]) {
  return call<VerifyProfile>(apiKey, "POST", "/verify_profiles", {
    name: "screenless",
    sms: {
      app_name: "screenless",
      code_length: 6,
      default_verification_timeout_secs: 300,
      whitelisted_destinations: destinations,
    },
    // The API rejects the profile unless `call` carries its own destination
    // allowlist too — it is not inherited from `sms`.
    call: {
      app_name: "screenless",
      default_verification_timeout_secs: 300,
      whitelisted_destinations: destinations,
    },
  });
}

export function triggerSmsVerification(
  apiKey: string,
  phone: string,
  profileId: string,
) {
  return call(apiKey, "POST", "/verifications/sms", {
    phone_number: phone,
    verify_profile_id: profileId,
  });
}

export function triggerCallVerification(
  apiKey: string,
  phone: string,
  profileId: string,
) {
  return call(apiKey, "POST", "/verifications/call", {
    phone_number: phone,
    verify_profile_id: profileId,
  });
}

/**
 * Note the response field is `response_code`, and its only values are
 * "accepted" | "rejected". An *expired* code comes back as "rejected" here —
 * `expired` only ever appears as the status on the verification record itself.
 */
export async function checkVerificationCode(
  apiKey: string,
  phone: string,
  code: string,
  profileId: string,
): Promise<boolean> {
  const path = `/verifications/by_phone_number/${encodeURIComponent(phone)}/actions/verify`;
  try {
    const res = await call<{ data: { response_code: "accepted" | "rejected" } }>(
      apiKey,
      "POST",
      path,
      { code, verify_profile_id: profileId },
    );
    return res.data.response_code === "accepted";
  } catch (err) {
    // A wrong code on a consumed/unknown verification 404s rather than
    // returning "rejected". Both mean the same thing to the caller.
    if (err instanceof TelnyxError && err.status === 404) return false;
    throw err;
  }
}

/* -------------------------------------------------------------- assistants */

export interface Assistant {
  id: string;
  telephony_settings?: { default_texml_app_id?: string };
}

export interface AssistantOptions {
  instructions: string;
  model: string;
  voice: string;
  language: string;
  greeting: string;
}

/**
 * One assistant per call. Wasteful in production, but it makes the
 * assistant_id a clean 1:1 handle for finding the conversation afterwards
 * without needing a call_control_id correlation.
 */
export function createAssistant(
  apiKey: string,
  name: string,
  o: AssistantOptions,
): Promise<Assistant> {
  return call<Assistant>(apiKey, "POST", "/ai/assistants", {
    name,
    model: o.model,
    instructions: o.instructions,
    greeting: o.greeting,
    voice_settings: { voice: o.voice },
    transcription: {
      // deepgram/flux is the turn-detection-optimised model: end-of-turn is
      // decided by a model rather than a silence timer. Dutch is one of its
      // ten languages. Use language "multi" for Dutch/English code-switching.
      model: "deepgram/flux",
      language: o.language,
      settings: { eot_threshold: 0.8, eot_timeout_ms: 5000, eager_eot_threshold: 0.4 },
    },
    telephony_settings: { time_limit_secs: 600, noise_suppression: "krisp" },
    // Conversation history must be retained or the transcript endpoint returns
    // nothing. This is the whole point of the tool, so it stays on.
    privacy_settings: { data_retention: true },
  });
}

export function deleteAssistant(apiKey: string, assistantId: string) {
  return call(apiKey, "DELETE", `/ai/assistants/${assistantId}`);
}

/**
 * Creating an assistant always auto-provisions a TeXML application, and
 * deleting the assistant does NOT remove it — delete it or they accumulate
 * one per call.
 */
export function deleteTexmlApplication(apiKey: string, appId: string) {
  return call(apiKey, "DELETE", `/texml_applications/${appId}`);
}

/**
 * Pins an application to a region.
 *
 * We must place calls through the assistant's own auto-created app, because
 * its voice_url points at `/ai/assistants/{id}/texml` — the document that
 * actually drives the conversation. A hand-made app with a different voice_url
 * connects the call and then sits in silence.
 *
 * The auto-created app defaults to anchorsite "Latency", so we patch it to the
 * region we want before dialling.
 */
export function setAnchorsite(apiKey: string, appId: string, anchorsite: string) {
  return call(apiKey, "PATCH", `/texml_applications/${appId}`, {
    anchorsite_override: anchorsite,
  });
}

/* ------------------------------------------------------------------- calls */

export interface AiCallOptions {
  from: string;
  to: string;
  assistantId: string;
  statusCallback: string;
  conversationCallback: string;
  /** Where Telnyx posts the answering-machine verdict, a few seconds in. */
  amdCallback: string;
}

/**
 * Places the call, driving it from TeXML we serve ourselves.
 *
 * Not `/texml/ai_calls`. That endpoint connects the call and then sits in
 * silence — the caller hears nothing, not even the assistant's greeting, and
 * the conversation records the human's "hello" against zero assistant turns.
 * It was diagnosed on day one and the workaround built the same afternoon;
 * this function then went on using the broken endpoint anyway, which is why
 * every call since has been silent.
 *
 * `/texml/calls` fetches `Url` and executes what it finds. We point it at our
 * own `/texml/assistant`, which returns the `<Connect><AIAssistant>` document
 * Telnyx would have served itself — the difference being that this route
 * actually runs it.
 */
export function initiateAiCall(
  apiKey: string,
  connectionId: string,
  o: AiCallOptions,
) {
  return call<{ sid?: string; call_sid?: string }>(
    apiKey,
    "POST",
    `/texml/calls/${connectionId}`,
    {
      From: o.from,
      To: o.to,
      // No Url. The connection here is the assistant's own auto-created TeXML
      // app, whose voice_url already points at
      // /ai/assistants/{id}/texml — the document Telnyx generates to connect
      // the leg to the assistant. Overriding it with our own copy of that same
      // document put this worker in the call path for no gain; without it,
      // Telnyx serves the canonical version and we are out of the way.
      StatusCallback: o.statusCallback,
      // Space-separated string, not an array — Telnyx rejects a JSON array here
      // with 10026 "must be of type 'string'", unlike the TwiML convention of
      // repeating the parameter.
      StatusCallbackEvent: "initiated ringing answered completed",
      StatusCallbackMethod: "POST",
      // Answering-machine detection, asynchronous: the assistant starts the
      // moment the call is answered and the verdict arrives on its own
      // callback a few seconds later. Synchronous detection would hold the
      // greeting back until Telnyx had decided, which a human hears as three
      // seconds of silence after "hello" — the worst possible opening. On a
      // machine verdict the Worker hangs up and re-parks the brief held; a
      // phone in Focus mode otherwise gets the whole briefing read into its
      // voicemail, which is what happened on the first evening.
      MachineDetection: "Enable",
      AsyncAmd: "true",
      AsyncAmdStatusCallback: o.amdCallback,
      AsyncAmdStatusCallbackMethod: "POST",
    },
  );
}

/**
 * Ends a live TeXML call. The account and call sids come straight off the
 * callback that told us it was a machine, so nothing has to be stored.
 */
export function hangupTexmlCall(apiKey: string, accountSid: string, callSid: string) {
  return call(apiKey, "POST", `/texml/Accounts/${accountSid}/Calls/${callSid}`, {
    Status: "completed",
  });
}

/* ----------------------------------------------------------- conversations */

export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  sent_at?: string;
  created_at?: string;
}

/**
 * Resolves the conversation for a call. We filter on assistant_id because we
 * mint a fresh assistant per call — the PostgREST-style filter syntax here is
 * Telnyx's, not a typo.
 */
export async function findConversationByAssistant(
  apiKey: string,
  assistantId: string,
): Promise<string | null> {
  const q = `metadata->assistant_id=eq.${assistantId}`;
  const res = await call<{ data: Array<{ id: string }> }>(
    apiKey,
    "GET",
    `/ai/conversations?${q}&limit=1&order=created_at.desc`,
  );
  return res.data?.[0]?.id ?? null;
}

/**
 * Deletes a conversation, and with it the stored transcript.
 *
 * The privacy policy promises transcripts are gone in 24 hours. Expiring our
 * own KV record does not achieve that while Telnyx still holds the
 * conversation, so the transcript is copied to KV first and the original is
 * deleted here.
 */
export function deleteConversation(apiKey: string, conversationId: string) {
  return call<unknown>(apiKey, "DELETE", `/ai/conversations/${conversationId}`);
}

export async function getTranscript(
  apiKey: string,
  conversationId: string,
): Promise<ConversationMessage[]> {
  const res = await call<{ data: ConversationMessage[] }>(
    apiKey,
    "GET",
    `/ai/conversations/${conversationId}/messages?page[size]=100`,
  );
  // sent_at is the field Telnyx documents as "when the end user experienced
  // the message" — created_at can be out of order for tool calls.
  return (res.data ?? []).sort((a, b) =>
    (a.sent_at ?? a.created_at ?? "").localeCompare(b.sent_at ?? b.created_at ?? ""),
  );
}
