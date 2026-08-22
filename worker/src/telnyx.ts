/**
 * Thin fetch wrapper over the Telnyx v2 REST API.
 *
 * We deliberately avoid the `telnyx` npm SDK here: it is generated for Node and
 * pulls in a lot of surface we do not need. Workers give us `fetch` natively,
 * and we only touch a handful of endpoints.
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
 * Sends a plain SMS from our number. Used for the one-time welcome text, so a
 * new user has the line saved and knows to ring it. Needs a messaging profile
 * on the account; `messagingProfileId` is optional because sending from a
 * number already attached to a profile does not require it.
 */
export function sendSms(
  apiKey: string,
  from: string,
  to: string,
  text: string,
  messagingProfileId?: string,
) {
  return call(apiKey, "POST", "/messages", {
    from,
    to,
    text,
    ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}),
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

/* ------------------------------------------------------------------- calls */

export interface TexmlCallOptions {
  from: string;
  to: string;
  /** TeXML to run when the call is answered — for us, the SIP bridge to OpenAI. */
  url: string;
  statusCallback: string;
  /** Optional AMD, so an outbound brief is not read into a voicemail. */
  amdCallback?: string;
}

/**
 * Dials out and runs TeXML we host at `Url` when the leg answers.
 *
 * Unlike initiateAiCall (which relies on an assistant's own auto-created app
 * and its voice_url), this passes an explicit `Url` so one standing TeXML
 * application can place every OpenAI call — the per-call document it fetches is
 * the `<Dial><Sip>` bridge to OpenAI, stamped with our correlation header.
 */
export function initiateTexmlCall(
  apiKey: string,
  connectionId: string,
  o: TexmlCallOptions,
) {
  return call<{ sid?: string; call_sid?: string }>(
    apiKey,
    "POST",
    `/texml/calls/${connectionId}`,
    {
      From: o.from,
      To: o.to,
      Url: o.url,
      StatusCallback: o.statusCallback,
      StatusCallbackEvent: "initiated ringing answered completed",
      StatusCallbackMethod: "POST",
      ...(o.amdCallback
        ? {
            MachineDetection: "Enable",
            AsyncAmd: "true",
            AsyncAmdStatusCallback: o.amdCallback,
            AsyncAmdStatusCallbackMethod: "POST",
          }
        : {}),
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
