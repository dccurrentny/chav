-- Staff console: DC Current's own operators, who can see every customer.
--
-- Staff are deliberately NOT rows in `users`. The security property that
-- holds the customer portals apart is that a user is always looked up by
-- email AND tenant. A user with a null tenant_id would be a hole in exactly
-- that invariant, so operators live in their own table with their own
-- sessions and their own cookie.

CREATE TABLE IF NOT EXISTS staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  -- 'owner' may manage other operators; 'operator' may manage customers only.
  role          text NOT NULL DEFAULT 'operator' CHECK (role IN ('owner','operator')),
  status        text NOT NULL DEFAULT 'active'   CHECK (status IN ('active','disabled')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash  text PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  csrf_secret text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          inet,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS staff_sessions_staff_idx   ON staff_sessions(staff_id);
CREATE INDEX IF NOT EXISTS staff_sessions_expires_idx ON staff_sessions(expires_at);

-- One timeline for everything, with the actor's kind recorded. A staff action
-- against a customer still shows up in that customer's own history, which is
-- the honest thing to do — they should be able to see that we changed it.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS actor_kind text NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS staff_id   uuid REFERENCES staff(id) ON DELETE SET NULL;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_kind_ck;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_ck
  CHECK (actor_kind IN ('customer','staff','system'));

CREATE INDEX IF NOT EXISTS audit_actor_kind_idx ON audit_log(actor_kind, at DESC);

-- Failed staff logins are tracked separately from customer ones: a brute force
-- against the console is a different event from one against a customer portal.
CREATE TABLE IF NOT EXISTS staff_login_attempts (
  id         bigserial PRIMARY KEY,
  email      citext NOT NULL,
  ip         inet,
  at         timestamptz NOT NULL DEFAULT now(),
  successful boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS staff_login_attempts_idx ON staff_login_attempts(email, at DESC);
