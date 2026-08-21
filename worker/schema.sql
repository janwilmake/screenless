-- Teams and pay-as-you-go billing. Apply with:
--   npx wrangler d1 execute screenless --remote --file=schema.sql
-- Everything is IF NOT EXISTS so re-applying is safe.

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
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  -- The token *is* the id: unguessable, and the only credential in the accept
  -- link. 32 bytes of randomness, hex.
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL DEFAULT 0
);

-- Every movement of money or minutes: the $10 grant, topups, and calls
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

CREATE INDEX IF NOT EXISTS idx_users_org ON users (org_id);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites (org_id);
CREATE INDEX IF NOT EXISTS idx_ledger_org_created ON ledger (org_id, created_at);
