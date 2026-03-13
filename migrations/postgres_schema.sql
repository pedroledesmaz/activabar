CREATE TABLE IF NOT EXISTS restaurants (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  default_reward TEXT,
  welcome_template TEXT,
  promotion_template TEXT,
  avg_ticket_eur DOUBLE PRECISION,
  gross_margin_pct DOUBLE PRECISION,
  promo_conversion_pct DOUBLE PRECISION,
  whatsapp_cost_eur DOUBLE PRECISION,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
  phone_e164 TEXT NOT NULL,
  source_qr TEXT,
  reward_label TEXT,
  consent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consent_version TEXT,
  consent_text TEXT,
  consent_ip TEXT,
  consent_user_agent TEXT,
  redeemed_at TIMESTAMP,
  opt_out_at TIMESTAMP,
  claim_code TEXT,
  claim_code_sent_at TIMESTAMP,
  claim_code_redeemed_at TIMESTAMP,
  deleted_at TIMESTAMP,
  deleted_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (restaurant_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS promotions (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  max_messages INTEGER NOT NULL DEFAULT 100,
  offer_cost_eur DOUBLE PRECISION NOT NULL DEFAULT 0,
  sent_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promotion_deliveries (
  id BIGSERIAL PRIMARY KEY,
  promotion_id BIGINT NOT NULL REFERENCES promotions(id),
  lead_id BIGINT NOT NULL REFERENCES leads(id),
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (promotion_id, lead_id)
);

CREATE TABLE IF NOT EXISTS operators (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES operators(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restaurant_staff_tokens (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (restaurant_id, token_hash)
);

CREATE TABLE IF NOT EXISTS promotion_schedules (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  max_messages INTEGER NOT NULL DEFAULT 100,
  offer_cost_eur DOUBLE PRECISION NOT NULL DEFAULT 0,
  day_of_week INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_restaurant_optout
  ON leads (restaurant_id, opt_out_at);

CREATE INDEX IF NOT EXISTS idx_leads_restaurant_claim
  ON leads (restaurant_id, claim_code);

CREATE INDEX IF NOT EXISTS idx_leads_restaurant_deleted
  ON leads (restaurant_id, deleted_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_restaurant_claim_unique
  ON leads (restaurant_id, claim_code)
  WHERE claim_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deliveries_lead_created
  ON promotion_deliveries (lead_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_operator
  ON sessions (operator_id, expires_at, revoked_at);

CREATE INDEX IF NOT EXISTS idx_staff_tokens_restaurant_active
  ON restaurant_staff_tokens (restaurant_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_schedules_restaurant
  ON promotion_schedules (restaurant_id, is_active);

CREATE INDEX IF NOT EXISTS idx_schedules_next_run
  ON promotion_schedules (is_active, next_run_at);
