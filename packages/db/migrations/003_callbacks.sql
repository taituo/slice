-- "Call me back": a physical button (Flic, Shelly, ESP32…) or an app button asks the AI to phone
-- the customer. The callback itself is a Temporal workflow; these tables are its business record.

CREATE TABLE buttons (
  id           text PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,         -- device credential, stored hashed
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  label        text NOT NULL,                -- "Kitchen fridge", "Gym bag"
  kind         text NOT NULL CHECK (kind IN ('physical', 'app')),
  -- What each press means. Defaults: single = call me back, double = my usual, long = cancel.
  actions      jsonb NOT NULL DEFAULT '{"single":"callback","double":"reorder","long":"cancel"}',
  quiet_from   smallint,                     -- local hour; no calls from quiet_from to quiet_to
  quiet_to     smallint,
  timezone     text NOT NULL DEFAULT 'Europe/Berlin',
  last_pressed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE TABLE callbacks (
  id              text PRIMARY KEY,           -- also the workflow id
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id       text NOT NULL,
  source          text NOT NULL,              -- 'button:<id>' | 'app' | 'order:<id>' | 'system:<reason>'
  intent          text NOT NULL CHECK (intent IN ('callback', 'reorder', 'support_followup')),
  status          text NOT NULL,
  presses         integer NOT NULL DEFAULT 1,
  attempts        integer NOT NULL DEFAULT 0,
  scheduled_for   timestamptz,
  conversation_id text,
  context         jsonb NOT NULL DEFAULT '{}',
  outcome         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX callbacks_customer_idx ON callbacks (customer_id, created_at DESC);
CREATE INDEX callbacks_conversation_idx ON callbacks (conversation_id);
