-- "View as customer" for support.
--
-- Two pieces, because cookies are host-only: the console runs on
-- ADMIN_HOSTNAME and cannot set a cookie on a customer's hostname. So an
-- operator mints a short-lived, single-use grant, and redeems it on the
-- customer's own host, which is where the session cookie is then set.

CREATE TABLE IF NOT EXISTS impersonation_grants (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Deliberately tiny: the grant only has to survive the redirect.
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  ip         inet
);
CREATE INDEX IF NOT EXISTS impersonation_grants_expires_idx ON impersonation_grants(expires_at);

-- A session created by an operator is marked as such for its whole life. It is
-- never indistinguishable from the customer's own login: the portal shows a
-- banner, writes are refused, and the audit trail names the operator.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS impersonated_by uuid REFERENCES staff(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS sessions_impersonated_idx
  ON sessions(impersonated_by) WHERE impersonated_by IS NOT NULL;
