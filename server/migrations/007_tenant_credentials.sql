-- Per-customer PBX credentials.
--
-- A SkySwitch token carries a scope. A Reseller-scope token can reach every
-- domain under the reseller; an Office Manager token can reach exactly one.
-- Both are legitimate, and they imply different deployments:
--
--   one Reseller credential  — simplest, and only this code keeps customers
--                              apart, because the token itself could reach
--                              any of them.
--   per-customer credentials — each customer's own Office Manager subscriber,
--                              so SkySwitch enforces the boundary too. A bug
--                              in our domain scoping cannot cross it.
--
-- The second is safer, so it must be possible. A customer with no credentials
-- of its own falls back to the server-wide ones.

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,
  -- AES-256-GCM: iv (12) || auth tag (16) || ciphertext, as app_settings.
  value_enc  bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, key)
);
