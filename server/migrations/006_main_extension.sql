-- The extension whose answer rules a customer's portal shows.
--
-- It was hardcoded to 2001 in the frontend, so every customer's portal asked
-- about the same extension regardless of whose portal it was. It belongs to
-- the tenant, like the hostname and the branding.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS main_extension text;

-- Same dial-plan shape the API allowlist enforces.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_main_extension_ck;
ALTER TABLE tenants ADD CONSTRAINT tenants_main_extension_ck
  CHECK (main_extension IS NULL OR main_extension ~ '^[0-9]{3,6}$');
