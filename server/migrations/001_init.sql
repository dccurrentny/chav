-- Portal schema. Apply with:  psql "$DATABASE_URL" -f migrations/001_init.sql
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A tenant is one customer, pinned to exactly one NetSapiens domain.
-- This table is the whole basis of authorization: a user's tenant decides
-- which NetSapiens domain their requests may touch, and nothing else does.
CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ns_domain   text NOT NULL UNIQUE,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users(tenant_id);

-- Server-side sessions. We store only a SHA-256 of the cookie token, so a
-- database leak does not hand out live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          inet,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

-- Append-only record of everything the portal did to SkySwitch.
-- This is the table you cannot reconstruct. Back it up.
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email text,
  ns_domain   text,
  op          text NOT NULL,
  target      text,
  params      jsonb,
  before_val  jsonb,
  after_val   jsonb,
  result      text NOT NULL CHECK (result IN ('ok','error','denied')),
  error       text,
  duration_ms integer,
  dedupe_key  text,
  ip          inet
);
CREATE INDEX IF NOT EXISTS audit_tenant_at_idx ON audit_log(tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_dedupe_idx    ON audit_log(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Failed-login tracking for lockout.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         bigserial PRIMARY KEY,
  email      citext NOT NULL,
  ip         inet,
  at         timestamptz NOT NULL DEFAULT now(),
  successful boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_email_at_idx ON login_attempts(email, at DESC);
