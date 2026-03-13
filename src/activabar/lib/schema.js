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
}

module.exports = { applySchema };
