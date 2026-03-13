require("dotenv").config();

const { db, initDb } = require("./db");

initDb();

const name = process.argv[2];
const slug = process.argv[3];

if (!name || !slug) {
  // eslint-disable-next-line no-console
  console.log('Uso: npm run seed -- "Bar Central" bar-central');
  process.exit(1);
}

const existing = db
  .prepare("SELECT id, name, slug FROM restaurants WHERE slug = ?")
  .get(slug);

if (existing) {
  // eslint-disable-next-line no-console
  console.log(`Ya existe: ${existing.name} (${existing.slug})`);
  process.exit(0);
}

const result = db
  .prepare("INSERT INTO restaurants (name, slug) VALUES (?, ?)")
  .run(name, slug);

const restaurant = db
  .prepare("SELECT id, name, slug FROM restaurants WHERE id = ?")
  .get(result.lastInsertRowid);

// eslint-disable-next-line no-console
console.log(`Creado restaurante #${restaurant.id}: ${restaurant.name}`);
// eslint-disable-next-line no-console
console.log(
  `URL QR: http://localhost:${process.env.PORT || 3000}/r/${restaurant.slug}?reward=2x1%20en%20bebidas&source=mesa`
);
// eslint-disable-next-line no-console
console.log(`Panel staff: http://localhost:${process.env.PORT || 3000}/staff/${restaurant.slug}`);
// eslint-disable-next-line no-console
console.log(`Panel plataforma: http://localhost:${process.env.PORT || 3000}/login`);
