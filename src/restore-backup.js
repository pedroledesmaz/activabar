require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { db, initDb } = require("./db");
const { TABLES, performPostgresBackup } = require("./backup");

const sourceArg = process.argv[2];
const backupDir = path.resolve(process.env.BACKUP_DIR || "./data/backups");

if (!sourceArg) {
  // eslint-disable-next-line no-console
  console.log("Uso: npm run restore -- ./data/backups/carpeta_backup");
  process.exit(1);
}

const sourcePath = path.resolve(sourceArg);
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
  // eslint-disable-next-line no-console
  console.log(`No existe el backup indicado o no es una carpeta: ${sourcePath}`);
  process.exit(1);
}

for (const table of TABLES) {
  const tablePath = path.join(sourcePath, `${table}.json`);
  if (!fs.existsSync(tablePath)) {
    // eslint-disable-next-line no-console
    console.log(`Backup incompleto: falta ${table}.json`);
    process.exit(1);
  }
}

initDb();

const safetySnapshot = performPostgresBackup({
  db,
  backupDir,
  retentionDays: Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 14)),
  label: "pre_restore",
});

const restoreTx = db.transaction(() => {
  db.exec(
    "TRUNCATE TABLE promotion_deliveries, sessions, restaurant_staff_tokens, promotion_schedules, promotions, leads, operators, restaurants RESTART IDENTITY CASCADE"
  );

  for (const table of TABLES) {
    const rows = JSON.parse(fs.readFileSync(path.join(sourcePath, `${table}.json`), "utf8"));
    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      const placeholders = columns.map(() => "?").join(", ");
      const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
      db.prepare(sql).run(...columns.map((column) => row[column]));
    }
  }

  for (const table of TABLES) {
    db.exec(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table}`
    );
  }
});

try {
  restoreTx();
  Promise.resolve(safetySnapshot)
    .then((snapshotPath) => {
      // eslint-disable-next-line no-console
      console.log(`Restaurado: ${sourcePath}`);
      // eslint-disable-next-line no-console
      console.log(`Snapshot previo guardado en: ${snapshotPath}`);
      // eslint-disable-next-line no-console
      console.log("Recomendado: reinicia el servidor y valida /health/full");
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`Restore warning: no se pudo guardar snapshot previo (${error.message})`);
      // eslint-disable-next-line no-console
      console.log(`Restaurado: ${sourcePath}`);
    });
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(`Restore error: ${error.message}`);
  process.exit(1);
}
