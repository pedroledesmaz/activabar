const db = require("../../lib/db");
const { normalizeSlug } = require("../../lib/slug");

async function listRestaurants() {
  return db.many(
    `SELECT
        id,
        name,
        slug,
        default_reward,
        is_archived,
        archived_at,
        created_at
     FROM restaurants
     ORDER BY created_at DESC`
  );
}

async function getRestaurantBySlug(slug) {
  return db.one(
    `SELECT
        id,
        name,
        slug,
        default_reward,
        welcome_template,
        promotion_template,
        avg_ticket_eur,
        gross_margin_pct,
        promo_conversion_pct,
        whatsapp_cost_eur,
        is_archived,
        archived_at,
        created_at
     FROM restaurants
     WHERE slug = $1`,
    [slug]
  );
}

async function getRestaurantBySlugAny(slug) {
  return db.one(
    `SELECT
        id,
        name,
        slug,
        default_reward,
        welcome_template,
        promotion_template,
        avg_ticket_eur,
        gross_margin_pct,
        promo_conversion_pct,
        whatsapp_cost_eur,
        is_archived,
        archived_at,
        created_at
     FROM restaurants
     WHERE slug = $1`,
    [slug]
  );
}

async function getRestaurantSummary(restaurantId) {
  return db.one(
    `SELECT
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL) AS total_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND opt_out_at IS NULL) AS active_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND opt_out_at IS NOT NULL) AS opted_out_leads,
        (SELECT COUNT(1) FROM promotions WHERE restaurant_id = $1) AS total_promotions,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = $1) AS total_sent_deliveries
     `,
    [restaurantId]
  );
}

async function createRestaurant(input) {
  const name = String(input.name || "").trim();
  const slug = normalizeSlug(input.slug || input.name);
  const defaultReward = String(input.defaultReward || "").trim() || null;

  if (!name) {
    const error = new Error("Restaurant name is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!slug) {
    const error = new Error("Restaurant slug is required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const created = await db.one(
      `INSERT INTO restaurants (name, slug, default_reward)
       VALUES ($1, $2, $3)
       RETURNING id, name, slug, default_reward, created_at`,
      [name, slug, defaultReward]
    );
    return created;
  } catch (error) {
    if (error.code === "23505") {
      const conflict = new Error("Restaurant slug already exists.");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
}

module.exports = {
  listRestaurants,
  getRestaurantBySlug,
  getRestaurantBySlugAny,
  getRestaurantSummary,
  createRestaurant,
};
