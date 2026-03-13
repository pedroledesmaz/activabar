require("dotenv").config();

const path = require("path");
const { db, initDb } = require("./db");
const { performPostgresBackup } = require("./backup");

initDb();

const backupDir = path.resolve(process.env.BACKUP_DIR || "./data/backups");
const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 14));

performPostgresBackup({
  db,
  backupDir,
  retentionDays,
  label: "manual",
})
  .then((filePath) => {
    // eslint-disable-next-line no-console
    console.log(`Backup creado: ${filePath}`);
    process.exit(0);
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`Backup error: ${error.message}`);
    process.exit(1);
  });
