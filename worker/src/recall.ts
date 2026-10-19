/**
 * Recall.ai, the meeting bot. It joins the meeting under a name, renders our
 * page (meet-bot.html) as its camera and microphone, and streams the meeting's
 * transcript and participant events back to the meeting's Durable Object.
 */

import type { Env } from "./index";

const base = (env: Env) => `https://${env.RECALL_REGION || "us-west-2"}.recall.ai/api/v1`;

async function call<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${env.RECALL_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Recall ${init.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export interface CreateBot {
  meetingUrl: string;
  botName: string;
  /** The page the bot loads as its camera and microphone. */
  pageUrl: string;
  joinMessage: string;
  recordingConfig: Record<string, unknown>;
  /** ISO time to join at; omitted joins now. */
  joinAt?: string;
}

export async function createBot(env: Env, o: CreateBot): Promise<{ id: string }> {
  return call(env, "/bot/", {
    method: "POST",
    body: JSON.stringify({
      meeting_url: o.meetingUrl,
      bot_name: o.botName,
      ...(o.joinAt ? { join_at: o.joinAt } : {}),
      output_media: { camera: { kind: "webpage", config: { url: o.pageUrl } } },
      // The page's audio stutters on the default quarter core (chimein, M2).
      variant: { google_meet: "web_4_core", zoom: "web_4_core", microsoft_teams: "web_4_core" },
      chat: { on_bot_join: { send_to: "everyone", message: o.joinMessage } },
      recording_config: o.recordingConfig,
      // Recall's default leaves 2 s after the last person, before anyone can
      // be let back in.
      automatic_leave: { everyone_left_timeout: { timeout: 30 } },
    }),
  });
}

export async function getBot(env: Env, id: string): Promise<{ status_changes?: Array<{ code: string }> }> {
  return call(env, `/bot/${id}/`);
}

export async function leaveCall(env: Env, id: string): Promise<void> {
  await call(env, `/bot/${id}/leave_call/`, { method: "POST" });
}

/** The latest status of a bot, such as `in_waiting_room` or `in_call_recording`. */
export function latestStatus(bot: { status_changes?: Array<{ code: string }> } | null): string | undefined {
  const changes = bot?.status_changes;
  return Array.isArray(changes) && changes.length ? changes[changes.length - 1].code : undefined;
}

/** In the meeting: the voice may start, and the minutes count from here. */
export const inCall = (status: string | undefined): boolean => !!status && status.startsWith("in_call");

/** Gone for good: the meeting ended, the bot was removed, or it never got in. */
export const isOver = (status: string | undefined): boolean =>
  !!status && ["call_ended", "done", "fatal", "analysis_done", "analysis_failed", "media_expired", "recording_permission_denied"].includes(status);
