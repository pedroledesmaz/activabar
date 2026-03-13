require("dotenv").config();

const { db, initDb } = require("./db");
const { hashPassword } = require("./auth");

initDb();

const email = String(process.argv[2] || "").trim().toLowerCase();
const password = String(process.argv[3] || "");

if (!email || !password) {
  // eslint-disable-next-line no-console
  console.log('Uso: npm run create-admin -- "admin@tuempresa.com" "TuPasswordSegura123"');
  process.exit(1);
}

const existing = db
  .prepare("SELECT id, email FROM operators WHERE email = ?")
  .get(email);

const passwordHash = hashPassword(password);

if (existing) {
  db.prepare(
    "UPDATE operators SET password_hash = ?, is_active = 1 WHERE id = ?"
  ).run(passwordHash, existing.id);
  // eslint-disable-next-line no-console
  console.log(`Admin actualizado: ${existing.email}`);
  process.exit(0);
}

db.prepare(
  "INSERT INTO operators (email, password_hash, role, is_active) VALUES (?, ?, 'admin', 1)"
).run(email, passwordHash);

// eslint-disable-next-line no-console
console.log(`Admin creado: ${email}`);

