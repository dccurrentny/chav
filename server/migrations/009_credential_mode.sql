-- Which SkySwitch credentials a customer uses, stated rather than inferred.
--
-- It was implicit: a complete set of per-customer credentials meant "use
-- them", anything less meant "fall back to the shared ones". That silently
-- turns a half-finished local setup into a reseller-credentialled one, which
-- is the opposite of what someone choosing local wants.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS credential_mode text NOT NULL DEFAULT 'shared';

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_credential_mode_ck;
ALTER TABLE tenants ADD CONSTRAINT tenants_credential_mode_ck
  CHECK (credential_mode IN ('shared', 'own'));

-- Anything already holding a full set of its own credentials was using them,
-- so preserve that rather than quietly moving it to the shared ones.
UPDATE tenants t SET credential_mode = 'own'
 WHERE credential_mode = 'shared'
   AND (SELECT count(*) FROM tenant_settings ts
         WHERE ts.tenant_id = t.id
           AND ts.key IN ('NS_BASE_URL','NS_CLIENT_ID','NS_CLIENT_SECRET',
                          'NS_USERNAME','NS_PASSWORD')) = 5;
