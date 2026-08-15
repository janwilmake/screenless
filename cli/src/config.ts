import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";

const DIR = join(homedir(), ".voxcall");
const FILE = join(DIR, "config.json");

export interface Config {
  /** Base URL of the deployed Worker. */
  apiUrl: string;
  /** Session token bound to the verified phone number. */
  token: string;
  /** The verified number — display only; the server trusts the token, not this. */
  phone: string;
  /** Session expiry, seconds since epoch. */
  expiresAt: number;
}

export async function load(): Promise<Config | null> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    return null;
  }
}

export async function save(config: Config): Promise<string> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  // Write first, then tighten. A token is a bearer credential; it should never
  // be group- or world-readable, even briefly.
  await writeFile(FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(FILE, 0o600);
  return FILE;
}

export async function clear(): Promise<void> {
  await rm(FILE, { force: true });
}

export const configPath = FILE;
