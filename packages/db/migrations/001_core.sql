-- Slice Network core schema.
-- Design rules:
--   * Personal data lives ONLY in customer_pii / customer_addresses, encrypted with pgcrypto.
--     Erasing a customer = deleting those rows; orders keep a pseudonymous customer_id.
--   * Orders are the slow-moving record; order_events is the fast, append-only stream.
--   * Temporal owns order *orchestration* state; this schema owns the business record.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE brands (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('real', 'virtual')),
  tagline       text NOT NULL DEFAULT '',
  accent_color  text NOT NULL DEFAULT '#d9480f'
);

CREATE TABLE pizzerias (
  id                  text PRIMARY KEY,
  brand_id            text NOT NULL REFERENCES brands(id),
  name                text NOT NULL,
  region              text NOT NULL,           -- data-residency + canary unit, e.g. 'de-berlin'
  address             text NOT NULL,
  lat                 double precision NOT NULL,
  lng                 double precision NOT NULL,
  delivery_mode       text NOT NULL CHECK (delivery_mode IN ('own_fleet', 'third_party')),
  capacity_per_15min  integer NOT NULL DEFAULT 8,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paused', 'closed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Bounding-box prefilter for nearest-pizzeria search (exact distance computed after).
CREATE INDEX pizzerias_lat_lng_idx ON pizzerias (lat, lng) WHERE status = 'open';
CREATE INDEX pizzerias_region_idx ON pizzerias (region);

CREATE TABLE menu_items (
  sku               text PRIMARY KEY,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  category          text NOT NULL CHECK (category IN ('pizza', 'side', 'drink', 'dessert')),
  base_price_cents  integer NOT NULL CHECK (base_price_cents >= 0),
  tags              text[] NOT NULL DEFAULT '{}',
  active            boolean NOT NULL DEFAULT true
);

CREATE TABLE pizzeria_menu (
  pizzeria_id          text NOT NULL REFERENCES pizzerias(id) ON DELETE CASCADE,
  sku                  text NOT NULL REFERENCES menu_items(sku),
  available            boolean NOT NULL DEFAULT true,
  price_override_cents integer,
  PRIMARY KEY (pizzeria_id, sku)
);

-- Pseudonymous customer record: safe to keep for analytics after erasure.
CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region             text NOT NULL,
  phone_hash         text UNIQUE,              -- sha256(pepper || phone) for lookup without decrypting
  created_at         timestamptz NOT NULL DEFAULT now(),
  erased_at          timestamptz
);

CREATE TABLE customer_pii (
  customer_id  uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  name_enc     bytea NOT NULL,
  phone_enc    bytea NOT NULL,
  email_enc    bytea
);

CREATE TABLE customer_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  line_enc     bytea NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  purpose      text NOT NULL,                  -- 'marketing', 'personalisation', 'call_recording'
  granted      boolean NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, purpose)
);

CREATE TABLE campaigns (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  percent_off  numeric(5,2) NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  regions      text[],
  skus         text[],
  CHECK (ends_at > starts_at)
);

CREATE TABLE feature_flags (
  key      text PRIMARY KEY,
  rollout  jsonb NOT NULL,                     -- { regions: [...], percent: n, build: '...' }
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id                  text PRIMARY KEY,        -- also the Temporal workflow id
  customer_id         uuid NOT NULL REFERENCES customers(id),
  pizzeria_id         text REFERENCES pizzerias(id),
  region              text NOT NULL,
  channel             text NOT NULL,
  status              text NOT NULL,
  items               jsonb NOT NULL,
  quote               jsonb,
  total_cents         integer,
  campaign_code       text,
  experiment_variant  text,
  delivery_lat        double precision NOT NULL,
  delivery_lng        double precision NOT NULL,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_pizzeria_active_idx ON orders (pizzeria_id)
  WHERE status IN ('routed', 'payment_authorized', 'accepted', 'preparing', 'ready');
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_created_idx ON orders (created_at);

-- Append-only event stream. In production: partition by month, ship to the analytics lake.
CREATE TABLE order_events (
  id        bigserial PRIMARY KEY,
  order_id  text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type      text NOT NULL,
  payload   jsonb NOT NULL DEFAULT '{}',
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);

CREATE TABLE payments (
  order_id     text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  provider_ref text NOT NULL,
  amount_cents integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('authorized', 'captured', 'voided', 'refunded')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
  order_id      text PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  provider      text NOT NULL,                 -- 'own_fleet' | 'courierco' | ...
  external_ref  text NOT NULL,
  status        text NOT NULL,
  eta_minutes   integer,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory (
  pizzeria_id        text NOT NULL REFERENCES pizzerias(id) ON DELETE CASCADE,
  ingredient         text NOT NULL,
  qty                numeric NOT NULL,
  unit               text NOT NULL,
  reorder_threshold  numeric NOT NULL,
  reorder_qty        numeric NOT NULL,
  PRIMARY KEY (pizzeria_id, ingredient)
);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  order_id    text,
  pizzeria_id text,
  channel     text NOT NULL,                   -- 'sms' | 'call' | 'push' | 'email' | 'ops_call'
  recipient   text NOT NULL,                   -- role or pseudonymous id, never raw PII
  message     text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

-- Signals from usage that feed the bot-driven development loop.
CREATE TABLE product_signals (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL,                    -- 'agent', 'web', 'mcp', 'a2a', 'ops'
  kind       text NOT NULL,                    -- 'unhandled_intent', 'error', 'abandoned_cart', 'feature_request'
  detail     jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  triaged_at timestamptz
);

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
