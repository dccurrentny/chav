-- Runtime settings editable from the staff console.
--
-- SkySwitch credentials used to live only in /etc/portal/portal.env, which
-- meant SSH-ing to the box to add or rotate them. They are secrets, so the
-- value is encrypted at rest rather than sitting in a readable column: the
-- database dump, the nightly backup and any replica all carry this table.

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  -- AES-256-GCM: iv (12) || auth tag (16) || ciphertext
  value_enc  bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff(id) ON DELETE SET NULL
);
