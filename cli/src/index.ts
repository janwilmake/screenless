#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import * as config from "./config.js";

/* ------------------------------------------------------------------ output */

const isTTY = stdout.isTTY;
const c = {
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};

function die(message: string): never {
  console.error(`${c.red("error")} ${message}`);
  exit(1);
}

/* --------------------------------------------------------------- http glue */

interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function api<T>(base: string, path: string, o: ApiOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: o.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  } catch (err) {
    return die(`could not reach ${base} — ${(err as Error).message}`);
  }

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) return die((parsed as { error?: string }).error ?? `HTTP ${res.status}`);
  return parsed as T;
}

/* ------------------------------------------------------------------- setup */

async function setup(args: string[]): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const existing = await config.load();
    const apiUrl = (
      argFlag(args, "--api") ??
      (await rl.question(`Worker URL ${c.dim(existing?.apiUrl ?? "https://screenless.you.workers.dev")}: `)) ??
      ""
    ).trim() || existing?.apiUrl;

    if (!apiUrl) die("a Worker URL is required");
    const base = apiUrl.replace(/\/$/, "");

    await api(base, "/health");
    console.log(`${c.green("✓")} reached ${base}`);

    const phone = (await rl.question("Your phone number (E.164, e.g. +31612345678): ")).trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) die("that is not a valid E.164 number");

    const channel = argFlag(args, "--voice") !== undefined ? "call" : "sms";
    await api(base, "/auth/start", { method: "POST", body: { phone, channel } });
    console.log(
      `${c.green("✓")} code sent to ${phone} ${c.dim(channel === "call" ? "(by phone call)" : "(by SMS)")}`,
    );

    const code = (await rl.question("Enter the code: ")).trim();
    const result = await api<{ token: string; phone: string; expiresAt: number }>(
      base,
      "/auth/verify",
      { method: "POST", body: { phone, code } },
    );

    const path = await config.save({
      apiUrl: base,
      token: result.token,
      phone: result.phone,
      expiresAt: result.expiresAt,
    });

    console.log(`${c.green("✓")} verified as ${c.bold(result.phone)}`);
    console.log(c.dim(`  saved to ${path} (0600)`));
    console.log(`\nTry: ${c.cyan('screenless call "vraag me hoe mijn week was"')}`);
  } finally {
    rl.close();
  }
}

/* -------------------------------------------------------------------- call */

interface CallStatus {
  callId: string;
  status: string;
  done: boolean;
  durationSecs?: number | null;
  transcript?: Array<{ role: string; text: string; at?: string }>;
}

async function call(args: string[]): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");
  if (cfg.expiresAt * 1000 < Date.now()) die("session expired — run `screenless setup` again");

  const prompt = args.find((a) => !a.startsWith("--"));
  if (!prompt) die('usage: screenless call "your prompt here" [--lang en|nl|multi] [--json]');

  const language = argFlag(args, "--lang") ?? "en";
  const asJson = args.includes("--json");

  const { callId } = await api<{ callId: string }>(cfg.apiUrl, "/calls", {
    method: "POST",
    body: { prompt, language },
    token: cfg.token,
  });

  if (!asJson) {
    console.log(`${c.green("→")} calling ${c.bold(cfg.phone)} ${c.dim(`(${callId})`)}`);
    console.log(c.dim("  pick up — the agent opens by disclosing it is an AI\n"));
  }

  // Poll rather than hold a socket open: the Worker learns the call ended from
  // Telnyx's status webhook, so all we do here is wait for it to say so.
  const deadline = Date.now() + 15 * 60 * 1000;
  let last = "";
  let result: CallStatus | undefined;

  while (Date.now() < deadline) {
    const status = await api<CallStatus>(cfg.apiUrl, `/calls/${callId}`, { token: cfg.token });
    if (!asJson && status.status !== last) {
      last = status.status;
      console.log(c.dim(`  ${status.status}...`));
    }
    if (status.done) {
      result = status;
      break;
    }
    await sleep(2000);
  }

  if (!result) die("timed out after 15 minutes waiting for the call to finish");

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "failed") {
    console.log(`\n${c.red("✗")} call did not connect (no answer, busy, or failed)`);
    exit(1);
  }

  const transcript = result.transcript ?? [];
  console.log(
    `\n${c.green("✓")} call completed${result.durationSecs ? c.dim(` · ${result.durationSecs}s`) : ""}\n`,
  );

  if (!transcript.length) {
    console.log(c.dim("  (no transcript — the call may have ended before anyone spoke)"));
    return;
  }

  for (const line of transcript) {
    const who = line.role === "assistant" ? c.cyan("agent") : c.bold("you  ");
    console.log(`${who}  ${line.text}`);
  }
}

/* ------------------------------------------------------------------- misc */

async function whoami(): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");
  const expired = cfg.expiresAt * 1000 < Date.now();
  console.log(`${c.bold(cfg.phone)} ${c.dim(`via ${cfg.apiUrl}`)}`);
  console.log(
    expired
      ? c.red("session expired — run `screenless setup`")
      : c.dim(`session valid until ${new Date(cfg.expiresAt * 1000).toLocaleString()}`),
  );
}

/**
 * Hands a built edition to the Worker to be sent at wake-up.
 *
 * The Worker holds it rather than the laptop, because the machine that builds
 * the paper at 03:00 is usually asleep by the time it should send.
 */
async function mail(args: string[]): Promise<void> {
  const cfg = await config.load();
  if (!cfg) die("not set up yet — run `screenless setup`");
  if (cfg.expiresAt * 1000 < Date.now()) die("session expired — run `screenless setup` again");

  const file = args.find((a) => !a.startsWith("--"));
  if (!file) die("usage: screenless mail <file.pdf> [--at HH:MM] [--to you@example.com]");

  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");

  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    die(`cannot read ${file}`);
  }

  const at = argFlag(args, "--at") || "";
  const to = argFlag(args, "--to") || "";
  const subject = argFlag(args, "--subject") || `screenless · ${basename(file, ".pdf")}`;

  // The Worker has no idea what timezone the reader wakes up in, so "07:00"
  // is meaningless without this. Node's offset is minutes *behind* UTC, which
  // is the opposite sign of what everyone expects — negate it here, once.
  const offsetMinutes = -new Date().getTimezoneOffset();

  const res = await api<{ id: string; sendAt: string }>(cfg.apiUrl, "/mail", {
    method: "POST",
    token: cfg.token,
    body: {
      filename: basename(file),
      contentBase64: content.toString("base64"),
      subject,
      at,
      offsetMinutes,
      ...(to ? { to } : {}),
    },
  });

  const when = new Date(res.sendAt);
  const size = (content.length / 1024).toFixed(0);
  console.log(
    `${c.green("✓")} queued ${c.bold(basename(file))} ${c.dim(`(${size} KB)`)} → ` +
      `${when.toLocaleString()} ${c.dim(`· ${res.id.slice(0, 8)}`)}`,
  );
}

async function logout(): Promise<void> {
  await config.clear();
  console.log(`${c.green("✓")} signed out, ${c.dim(config.configPath)} removed`);
}

function usage(): void {
  console.log(`${c.bold("screenless")} — take the decisions your agents are blocked on by phone

${c.bold("Usage")}
  screenless setup [--api <url>] [--voice]   verify your phone number by OTP
  screenless call "<prompt>" [options]       call yourself, block, print transcript
  screenless mail <file.pdf> [--at HH:MM]    schedule an edition for wake-up
  screenless whoami                          show the verified number
  screenless logout                          discard the local session

${c.bold("Call options")}
  --lang en|nl|multi   conversation language (default: en)
                       "multi" follows Dutch/English code-switching
  --json               emit the raw result instead of a formatted transcript

${c.bold("Mail options")}
  --at HH:MM           next occurrence of that local time (default: now)
  --to <email>         recipient, if the Worker has no MAIL_TO default
  --subject <text>     override the subject line

${c.bold("Setup options")}
  --api <url>          Worker URL, skips the prompt
  --voice              receive the OTP as a phone call instead of an SMS
`);
}

const argFlag = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : "";
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- entry */

const [command, ...rest] = argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void> | void> = {
  setup,
  call,
  mail,
  whoami,
  logout,
  help: usage,
};

const handler = commands[command ?? "help"];
if (!handler) {
  console.error(`${c.red("error")} unknown command: ${command}\n`);
  usage();
  exit(1);
}

await Promise.resolve(handler(rest)).catch((err: Error) => die(err.message));
