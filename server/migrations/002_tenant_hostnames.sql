-- Per-tenant hostnames and branding.
--
-- The hostname becomes part of the authorization story: a session cookie is
-- host-only, and login checks that the user belongs to the tenant that owns
-- the hostname they are signing in on. Acme's credentials do not work on
-- Bolt's portal.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS hostname      text,
  ADD COLUMN IF NOT EXISTS brand_name    text,
  ADD COLUMN IF NOT EXISTS brand_color   text,
  ADD COLUMN IF NOT EXISTS logo_url      text,
  ADD COLUMN IF NOT EXISTS support_email text,
  ADD COLUMN IF NOT EXISTS support_phone text;

-- Hostnames are matched case-insensitively and must be unique across tenants.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_hostname_idx ON tenants (lower(hostname));

-- Only a sensible hex accent is accepted; the frontend injects this into CSS.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_brand_color_ck;
ALTER TABLE tenants ADD CONSTRAINT tenants_brand_color_ck
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-Fa-f]{6}$');

-- A hostname must look like a hostname. Keeps junk out of the on-demand TLS
-- check, which decides whether Caddy will request a certificate.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_hostname_ck;
ALTER TABLE tenants ADD CONSTRAINT tenants_hostname_ck
  CHECK (hostname IS NULL OR hostname ~ '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$');
