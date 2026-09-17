-- Which parts of the portal each customer gets.
--
-- Customers want different things, so a portal is assembled per customer
-- rather than every customer seeing every screen. Stored as rows rather than
-- a column so enabling one is an insert and the audit trail reads naturally.

CREATE TABLE IF NOT EXISTS tenant_features (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature    text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  enabled_by uuid REFERENCES staff(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, feature)
);

-- Existing customers keep what the portal already did for them: read their
-- forwarding and see the history. Turning more on is a deliberate act.
INSERT INTO tenant_features (tenant_id, feature)
SELECT t.id, f.feature
  FROM tenants t
 CROSS JOIN (VALUES ('forwarding_view'), ('history')) AS f(feature)
    ON CONFLICT DO NOTHING;
