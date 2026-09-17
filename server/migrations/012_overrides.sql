-- Temporary overrides of the weekly schedule.
--
-- "Yossi is out this afternoon, send calls to Moshe until six" should not mean
-- editing the week and remembering to change it back. An override covers a
-- real span of time, wins over the weekly grid while it lasts, and then stops
-- mattering on its own.

CREATE TABLE IF NOT EXISTS tenant_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Null means "nobody" — calls follow whatever the phone system already has,
  -- which is how a customer says "stop routing this period at all".
  destination_id uuid REFERENCES tenant_destinations(id) ON DELETE CASCADE,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  CHECK (ends_at > starts_at)
);

-- The engine asks "is anything covering right now" on every tick.
CREATE INDEX IF NOT EXISTS tenant_overrides_window_idx
  ON tenant_overrides(tenant_id, starts_at, ends_at);
