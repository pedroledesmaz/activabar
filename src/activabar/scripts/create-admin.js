require("dotenv").config();

const { applySchema } = require("../lib/schema");
const db = require("../lib/db");
const { upsertAdmin } = require("../modules/auth/service");

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const password = String(process.argv[3] || "");

  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.log(
      'Uso: npm run create-admin:activabar -- "admin@tuempresa.com" "TuPasswordSegura123"'
    );
    process.exit(1);
  }

  await applySchema();
  const result = await upsertAdmin(email, password);
  // eslint-disable-next-line no-console
  console.log(`${result.created ? "Admin creado" : "Admin actualizado"}: ${result.email}`);
  await db.close();
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  await db.close();
  process.exit(1);
});
