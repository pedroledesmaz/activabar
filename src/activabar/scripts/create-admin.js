const { applySchema } = require("../lib/schema");
const db = require("../lib/db");
const { upsertAdmin } = require("../modules/auth/service");

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const password = String(process.argv[3] || "");

  if (!email || !password) {
    throw new Error("Usage: node src/activabar/scripts/create-admin.js <email> <password>");
  }

  await applySchema();
  const result = await upsertAdmin(email, password);
  console.log(JSON.stringify({ ok: true, ...result }));
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
