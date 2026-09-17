-- Per-customer dispatch schedule.
--
-- A customer says who should answer the phone in each hour of the week, and
-- an engine applies the current hour to SkySwitch. That is the shape the
-- Scheduler Suite already used, and it beats creating a time frame per hour:
-- one answer rule is rewritten as the hour turns.

-- Where calls can go: a named dispatcher, ring group, queue or outside number.
CREATE TABLE IF NOT EXISTS tenant_destinations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  -- An extension, or an external number. Validated in the API against the
  -- same shapes the SkySwitch allowlist accepts.
  target     text NOT NULL,
  -- Shown on the grid so a painted week is readable at a glance.
  colour     text NOT NULL DEFAULT '#2F6FED' CHECK (colour ~ '^#[0-9A-Fa-f]{6}$'),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_destinations_tenant_idx ON tenant_destinations(tenant_id);

-- The week: 7 days x 24 hours. A missing row means "leave this hour alone",
-- which is deliberate — it lets a customer schedule part of the week without
-- the engine touching the rest.
CREATE TABLE IF NOT EXISTS tenant_schedule (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day_of_week    smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Monday
  hour_of_day    smallint NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
  destination_id uuid REFERENCES tenant_destinations(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, day_of_week, hour_of_day)
);

-- Hours are local to the customer, not to the server.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York';

-- What the engine last applied, so it does not rewrite an unchanged rule every
-- hour and so an operator can see what the phone system is actually set to.
CREATE TABLE IF NOT EXISTS tenant_schedule_state (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  applied_target text,
  applied_at     timestamptz,
  last_error     text,
  last_attempt   timestamptz
);
