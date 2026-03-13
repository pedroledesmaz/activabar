const fs = require("fs");
const path = require("path");

const TABLES = [
  "restaurants",
  "leads",
  "promotions",
  "promotion_deliveries",
  "operators",
  "sessions",
  "restaurant_staff_tokens",
  "promotion_schedules",
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function timestampForFile(date = new Date()) {
  const iso = new Date(date.getTime()).toISOString();
  return iso.replace(/[:.]/g, "-");
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function writeCsvFromRows(filePath, rows) {
  if (!rows || rows.length === 0) {
    fs.writeFileSync(filePath, "");
    return;
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function pruneOldBackups(backupDir, retentionDays) {
  const keepMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - keepMs;
  const entries = fs.readdirSync(backupDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(backupDir, entry.name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

async function performPostgresBackup({
  db,
  backupDir,
  retentionDays,
  label = "auto",
}) {
  ensureDir(backupDir);

  const destination = path.join(backupDir, `${label}_${timestampForFile()}`);
  ensureDir(destination);

  const schemaSource = path.resolve(__dirname, "..", "migrations", "postgres_schema.sql");
  if (fs.existsSync(schemaSource)) {
    fs.copyFileSync(schemaSource, path.join(destination, "schema.sql"));
  }

  const metadata = {
    createdAt: new Date().toISOString(),
    label,
    tables: TABLES,
    format: "postgres-json-v1",
  };
  fs.writeFileSync(
    path.join(destination, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`
  );

  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all();
    fs.writeFileSync(path.join(destination, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  }

  pruneOldBackups(backupDir, retentionDays);
  return destination;
}

module.exports = {
  TABLES,
  ensureDir,
  writeCsvFromRows,
  performPostgresBackup,
};
