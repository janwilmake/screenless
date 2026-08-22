-- The whole Worker's state. Apply with:
--   npx wrangler d1 execute screenless --remote --file=schema.sql
-- Everything is IF NOT EXISTS so re-applying is safe. Upgrading an existing
-- database to a newer schema is ALTER TABLE by hand — SQLite tolerates
-- additive change well, and this file is the reference for what should exist.
--
-- There is no KV. Settings live on the user, briefs and calls are rows,
-- watcher liveness is a timestamp comparison, the team's call queue is a
-- query over calls, rate limits are counters, and short-lived codes are a
-- stash with expiries the cron sweeps. The one thing not here is the parked
-- edition PDF, which goes to R2 — a 12 MB attachment is not a row.

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'My team',
  -- Authoritative balance, in cents. The ledger is the story; this is the sum,
  -- kept denormalised so the call gate is one indexed read.
  credit_cents INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  -- Unique when present. A CLI-created user may have no email yet; an invited
  -- user has no phone until they verify one. SQLite treats NULLs as distinct.
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  phone_verified_at INTEGER NOT NULL DEFAULT 0,
  -- "please verify your phone" nudge, sent at most once, a day after joining.
  phone_reminder_sent_at INTEGER NOT NULL DEFAULT 0,
  -- The paper and the call are personal, so their settings are columns here,
  -- not a table: when the call rings, in which zone, in what language, where
  -- the edition mails, and whether the address was proven by a code.
  call_at TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  call_enabled INTEGER NOT NULL DEFAULT 1,
  language TEXT NOT NULL DEFAULT 'en',
  terms_accepted_at INTEGER NOT NULL DEFAULT 0,
  email_verified_at INTEGER NOT NULL DEFAULT 0,
  -- CLI bearer tokens minted before this instant are void; see auth.ts.
  tokens_revoked_at INTEGER NOT NULL DEFAULT 0,
  settings_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  -- The token *is* the id: unguessable, and the only credential in the accept
  -- link. 24 bytes of randomness, hex.
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL DEFAULT 0
);

-- Every movement of money or minutes: the free grant, topups, and calls
-- (negative delta). The billing tab is entirely queries over this table.
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('grant', 'topup', 'call')),
  delta_cents INTEGER NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- One call, from dial (or ring-in) to handled. The team's watcher queue is
-- not a structure of its own: it is WHERE queued AND completed AND handled_by
-- IS NULL, oldest first.
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT,
  -- Who placed the call. For a self-call and a ring-in this equals user_id;
  -- for a dispatched teammate call it is the initiator, who may read the
  -- transcript back even though user_id is the callee.
  initiated_by TEXT,
  phone TEXT NOT NULL,
  assistant_id TEXT NOT NULL DEFAULT '',
  texml_app_id TEXT,
  status TEXT NOT NULL,
  voicemail INTEGER NOT NULL DEFAULT 0,
  inbound INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  request_text TEXT,
  recording_url TEXT,
  queued INTEGER NOT NULL DEFAULT 0,
  handled_by TEXT,
  debited INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT,
  -- JSON array of {role, text, at}. Transcripts are tens of KB at most.
  transcript TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- Queued calls keep 7 days so a request survives a weekend with no watcher;
  -- everything else 24 hours. The cron deletes what has expired.
  expires_at INTEGER NOT NULL
);

-- One parked brief per phone — the morning call's script, written by the loop.
CREATE TABLE IF NOT EXISTS briefs (
  phone TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  language TEXT NOT NULL,
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'parked' CHECK (status IN ('parked', 'placed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  call_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- A live terminal. Alive means last_seen within the TTL; rows past it are
-- ignored by routing and swept by the cron.
CREATE TABLE IF NOT EXISTS watchers (
  org_id TEXT NOT NULL,
  watcher_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (org_id, watcher_id)
);

-- Parked mail. The attachment body lives in R2 under outbox/<id>; a row with
-- has_attachment = 0 is a text-only report.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT 'edition.pdf',
  has_attachment INTEGER NOT NULL DEFAULT 0,
  body_text TEXT NOT NULL DEFAULT '',
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Short-lived key/values: email codes, web sign-in codes, pending phone
-- verifications, the Checkout session a billing page is polling on.
CREATE TABLE IF NOT EXISTS stash (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Rate-limit counters with a window end; see util.rateLimit.
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users (org_id);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites (org_id);
CREATE INDEX IF NOT EXISTS idx_ledger_org_created ON ledger (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_org_queue ON calls (org_id, queued, status);
CREATE INDEX IF NOT EXISTS idx_calls_phone_created ON calls (phone, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_send ON outbox (send_at);
