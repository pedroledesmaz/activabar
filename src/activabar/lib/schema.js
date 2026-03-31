const fs = require("fs");
const path = require("path");
const db = require("./db");

async function applySchema() {
  const schemaPath = path.resolve(__dirname, "../../../migrations/postgres_schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await db.query(sql);
  await db.query(
    "ALTER TABLE promotions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP"
  );
  await db.query(
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS twilio_account_sid TEXT"
  );
  await db.query(
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS twilio_auth_token TEXT"
  );
  await db.query(
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS twilio_whatsapp_from TEXT"
  );
  await db.query(
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS twilio_sender_status TEXT"
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS operator_restaurant_access (
      id BIGSERIAL PRIMARY KEY,
      operator_id BIGINT NOT NULL REFERENCES operators(id),
      restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (operator_id, restaurant_id)
    )
  `);
  await db.query(
    "CREATE INDEX IF NOT EXISTS idx_operator_restaurant_access_restaurant ON operator_restaurant_access (restaurant_id)"
  );
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_twilio_sender_unique
      ON restaurants (twilio_whatsapp_from)
      WHERE twilio_whatsapp_from IS NOT NULL
  `);
}

module.exports = { applySchema };
