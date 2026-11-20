-- Platform layer: the same agents, offers, support, ads, voice and identity serve any vertical.
-- Verticals in this repo: food (pizzerias), fitness (gyms), retail (any shop near a GPS point).

CREATE TABLE tenants (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  verticals text[] NOT NULL,                 -- which vertical agents this tenant exposes
  branding  jsonb,                           -- null = unbranded / white-label
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE brands ADD COLUMN tenant_id text NOT NULL DEFAULT 'slice';
ALTER TABLE orders ADD COLUMN offer_id text;
ALTER TABLE orders ADD COLUMN ad_id text;

-- Any offer-making business: a pizzeria, a gym, a shoe shop in a mall.
-- Pizzerias and gyms keep their own tables; `providers` is the common offer-making view.
CREATE TABLE merchants (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants(id),
  name              text NOT NULL,
  category          text NOT NULL,           -- 'shoes', 'coffee', 'electronics', ...
  lat               double precision NOT NULL,
  lng               double precision NOT NULL,
  place             text,                    -- e.g. 'Mall of Berlin, level 1' (no mall integration needed)
  theme             jsonb NOT NULL DEFAULT '{}',
  max_discount_pct  numeric(5,2) NOT NULL DEFAULT 10,
  compete_policy    text NOT NULL DEFAULT 'hold' CHECK (compete_policy IN ('hold', 'match', 'beat')),
  offer_agent_url   text                     -- franchisee/merchant's own A2A agent, if any
);
CREATE INDEX merchants_lat_lng_idx ON merchants (lat, lng);

CREATE TABLE merchant_deals (
  id                  text PRIMARY KEY,
  merchant_id         text NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  title               text NOT NULL,
  category            text NOT NULL,
  keywords            text[] NOT NULL DEFAULT '{}',
  price_cents         integer NOT NULL,
  floor_price_cents   integer NOT NULL,        -- lowest price the merchant allows in a bidding round
  stock               integer NOT NULL DEFAULT 10,
  active              boolean NOT NULL DEFAULT true
);

-- Time-boxed specials any provider can run (food, fitness, retail).
CREATE TABLE specials (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  provider_id  text NOT NULL,                -- pizzeria / gym / merchant id
  title        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('percent_off', 'free_item', 'fixed_off')),
  value        numeric NOT NULL,             -- percent, cents, or 0 for free_item
  sku          text,                         -- free item sku or restriction
  min_subtotal_cents integer NOT NULL DEFAULT 0,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE offer_requests (
  id           text PRIMARY KEY,             -- also the auction workflow id
  tenant_id    text NOT NULL,
  vertical     text NOT NULL,
  customer_key text NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  request      jsonb NOT NULL,
  preference   text NOT NULL DEFAULT 'best_value',
  status       text NOT NULL DEFAULT 'open',
  chosen_offer text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE offers (
  id             text PRIMARY KEY,
  request_id     text NOT NULL REFERENCES offer_requests(id) ON DELETE CASCADE,
  vertical       text NOT NULL,
  provider_id    text NOT NULL,
  provider_name  text NOT NULL,
  round          integer NOT NULL DEFAULT 1,
  price_cents    integer NOT NULL,
  list_price_cents integer NOT NULL,
  eta_minutes    integer,
  distance_m     integer NOT NULL,
  headline       text NOT NULL,
  special_title  text,
  theme          jsonb NOT NULL DEFAULT '{}',
  details        jsonb NOT NULL DEFAULT '{}',
  score          numeric NOT NULL DEFAULT 0,
  expires_at     timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'expired'))
);
CREATE INDEX offers_request_idx ON offers (request_id, score DESC);

-- Retail claims: a voucher the shop scans at the till.
CREATE TABLE vouchers (
  code         text PRIMARY KEY,
  offer_id     text NOT NULL REFERENCES offers(id),
  customer_key text NOT NULL,
  status       text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'redeemed', 'expired')),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Fitness vertical.
CREATE TABLE gyms (
  id        text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name      text NOT NULL,
  region    text NOT NULL,
  address   text NOT NULL,
  lat       double precision NOT NULL,
  lng       double precision NOT NULL,
  theme     jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE gym_classes (
  id            text PRIMARY KEY,
  gym_id        text NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  title         text NOT NULL,
  kind          text NOT NULL,             -- 'yoga', 'spin', 'hiit', 'strength'
  starts_at     timestamptz NOT NULL,
  duration_min  integer NOT NULL,
  capacity      integer NOT NULL,
  price_cents   integer NOT NULL,
  instructor    text NOT NULL
);
CREATE INDEX gym_classes_start_idx ON gym_classes (starts_at);
CREATE TABLE class_bookings (
  id          text PRIMARY KEY,            -- also the booking workflow id
  class_id    text NOT NULL REFERENCES gym_classes(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  status      text NOT NULL CHECK (status IN ('pending', 'confirmed', 'waitlisted', 'cancelled', 'expired', 'attended', 'no_show')),
  offer_id    text,
  price_cents integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX class_bookings_class_idx ON class_bookings (class_id, status, created_at);

-- Deep-agent memory: one session per conversation, whatever the channel.
CREATE TABLE agent_sessions (
  id          text PRIMARY KEY,            -- A2A contextId, chat session id, voice conversation id
  tenant_id   text NOT NULL,
  channel     text NOT NULL,
  customer_id uuid,
  plan        jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_messages (
  id         bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role       text NOT NULL,
  content    text NOT NULL,
  data       jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_messages_session_idx ON agent_messages (session_id, id);

-- Support.
CREATE TABLE support_cases (
  id           text PRIMARY KEY,           -- also the support workflow id
  tenant_id    text NOT NULL,
  customer_id  uuid,
  order_id     text,
  channel      text NOT NULL,
  category     text,
  status       text NOT NULL,
  summary      text NOT NULL,
  resolution   text,
  credit_cents integer NOT NULL DEFAULT 0,
  csat         integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_messages (
  id       bigserial PRIMARY KEY,
  case_id  text NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  author   text NOT NULL CHECK (author IN ('customer', 'agent', 'human', 'system')),
  body     text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);

-- Generated ads.
CREATE TABLE ads (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL,
  source_key   text NOT NULL,              -- what the ad is about, e.g. 'special:sp-1', 'idle:ber-kotti-03'
  variant      text NOT NULL,              -- 'a' | 'b' | 'c'
  provider_id  text,
  headline     text NOT NULL,
  body         text NOT NULL,
  cta          text NOT NULL,
  lat          double precision,
  lng          double precision,
  theme        jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'rejected', 'ended')),
  generated_by text NOT NULL,
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  conversions  integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_key, variant)
);

-- Identity for people and the assistants they connect.
CREATE TABLE auth_codes (
  phone_hash text PRIMARY KEY,
  code_hash  text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE TABLE customer_tokens (
  id           text PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('session', 'assistant')),
  label        text NOT NULL,
  scopes       text[] NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- Voice calls (ElevenLabs).
CREATE TABLE voice_calls (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  conversation_id text,
  recipient       text,
  purpose         text NOT NULL,
  status          text NOT NULL,
  summary         text,
  at              timestamptz NOT NULL DEFAULT now()
);

-- Partial refunds from support resolutions.
ALTER TABLE payments ADD COLUMN refunded_cents integer NOT NULL DEFAULT 0;
