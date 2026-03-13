require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { db, initDb } = require("./db");
const { TABLES, ensureDir, writeCsvFromRows } = require("./backup");

initDb();

function tsLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

const outputDir = path.resolve(
  process.env.POSTGRES_EXPORT_DIR || `./exports/postgres_${tsLabel()}`
);
ensureDir(outputDir);

for (const table of TABLES) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  writeCsvFromRows(path.join(outputDir, `${table}.csv`), rows);
}

const schemaSource = path.resolve("./migrations/postgres_schema.sql");
if (fs.existsSync(schemaSource)) {
  fs.copyFileSync(schemaSource, path.join(outputDir, "postgres_schema.sql"));
}

const readme = [
  "Export PostgreSQL generado desde la base activa.",
  "",
  "Pasos sugeridos:",
  "1) Crear una base PostgreSQL vacia.",
  "2) Ejecutar postgres_schema.sql.",
  "3) Importar cada CSV con COPY.",
  "",
  "Ejemplo:",
  "\\copy restaurants FROM 'restaurants.csv' CSV HEADER",
].join("\n");
fs.writeFileSync(path.join(outputDir, "README.txt"), `${readme}\n`);

// eslint-disable-next-line no-console
console.log(`Export PostgreSQL listo en: ${outputDir}`);
