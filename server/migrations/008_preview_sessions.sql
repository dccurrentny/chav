-- Preview a customer's portal before they have any accounts.
--
-- Impersonation binds a session to a user. An operator setting a customer up
-- has no user to bind to yet, and creating a throwaway one to look at a page
-- would leave a real account and a misleading audit trail behind.
--
-- So a session may instead name a tenant directly, with no user. Exactly one
-- of the two is always set.

ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS preview_tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_subject_ck;
ALTER TABLE sessions ADD CONSTRAINT sessions_subject_ck
  CHECK ((user_id IS NULL) <> (preview_tenant_id IS NULL));

-- A preview session is only ever created by an operator, so it must carry the
-- impersonation marker too: that is what makes it read-only and visible.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_preview_is_staff_ck;
ALTER TABLE sessions ADD CONSTRAINT sessions_preview_is_staff_ck
  CHECK (preview_tenant_id IS NULL OR impersonated_by IS NOT NULL);

ALTER TABLE impersonation_grants ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE impersonation_grants
  ADD COLUMN IF NOT EXISTS preview_tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE impersonation_grants DROP CONSTRAINT IF EXISTS grants_subject_ck;
ALTER TABLE impersonation_grants ADD CONSTRAINT grants_subject_ck
  CHECK ((user_id IS NULL) <> (preview_tenant_id IS NULL));
