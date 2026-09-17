-- Second factor for the staff console.
--
-- The console reaches every customer behind one password. A leaked or reused
-- operator password is the single worst credential failure in this system, and
-- a second factor is the only control that survives it.

ALTER TABLE staff
  -- AES-256-GCM, same key derivation as app_settings. Encrypted rather than
  -- hashed because the server has to compute codes from it.
  ADD COLUMN IF NOT EXISTS totp_secret_enc   bytea,
  -- Null until a code has actually been entered correctly. A secret that was
  -- generated but never confirmed must not gate a login: that is how someone
  -- locks themselves out by closing the setup page halfway.
  ADD COLUMN IF NOT EXISTS totp_confirmed_at timestamptz,
  -- The last 30-second step accepted. Without this a code stays good for its
  -- whole window and anyone who reads it over a shoulder can reuse it.
  ADD COLUMN IF NOT EXISTS totp_last_step    bigint;

-- Shown once at enrolment, for the operator who has lost their phone.
CREATE TABLE IF NOT EXISTS staff_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  -- SHA-256, not argon2: these are 80 bits of randomness, not a chosen
  -- password, so there is nothing for a slow hash to defend against.
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_recovery_codes_uniq
  ON staff_recovery_codes(staff_id, code_hash);

-- The gap between "password accepted" and "code accepted".
--
-- Deliberately not a staff_sessions row with a flag: a half-authenticated
-- session that every other code path treats as a session is exactly the bug
-- this feature exists to prevent. A challenge is a different token, in a
-- different table, that no middleware can mistake for a sign-in.
CREATE TABLE IF NOT EXISTS staff_mfa_challenges (
  token_hash text PRIMARY KEY,
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  ip         inet
);
CREATE INDEX IF NOT EXISTS staff_mfa_challenges_expires_idx
  ON staff_mfa_challenges(expires_at);
