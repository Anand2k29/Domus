-- Domus D1 schema. Apply with:
--   npx wrangler d1 execute domus-db --remote --file=./schema.sql

-- Phone numbers are never stored in plain text: phone_hash is an HMAC with PRIVACY_PEPPER.
-- phone_last4 is kept only so the UI can show a masked number.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone_hash TEXT UNIQUE NOT NULL,
  phone_last4 TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin' (admin set via ADMIN_PHONES)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  phone_hash TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- Session tokens are random and sent only in an HttpOnly cookie. Only their SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Gemini quota counters: one row per user per window ('min:YYYY-MM-DDTHH:MM' or 'day:YYYY-MM-DD').
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_key)
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  name TEXT NOT NULL,
  age INTEGER,
  gender TEXT,
  looking_for TEXT,
  occupation TEXT,
  lifestyle TEXT,
  city TEXT,
  locality TEXT,
  budget_min INTEGER,
  budget_max INTEGER,
  move_in TEXT,
  deposit INTEGER,
  sleep TEXT,
  cleanliness TEXT,
  cooking TEXT,
  smoking INTEGER DEFAULT 0,
  pets TEXT,
  guests TEXT,
  work_mode TEXT,
  about TEXT,
  verified INTEGER DEFAULT 0,
  is_seed INTEGER DEFAULT 0,
  ai_summary TEXT,
  ai_tags TEXT,
  ai_filters TEXT,
  ai_source TEXT,
  discoverable INTEGER NOT NULL DEFAULT 1,     -- 0 = hidden from Discover and from other users
  share_locality INTEGER NOT NULL DEFAULT 1,   -- 0 = other users see city only
  share_budget INTEGER NOT NULL DEFAULT 1,     -- 0 = other users do not see the budget range
  privacy_consent_at INTEGER,                  -- when the user agreed to the privacy notice
  privacy_version TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS match_notes (
  viewer_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  note TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (viewer_id, target_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL,
  to_profile TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (from_user, to_profile)
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_by TEXT NOT NULL,
  category TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agreements (
  user_id TEXT PRIMARY KEY,
  title TEXT,
  clauses TEXT,
  source TEXT,
  updated_at INTEGER
);
