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
        (SELECT COUNT(1) FROM promotions WHERE restaurant_id = $1 AND archived_at IS NULL) AS total_promotions,
        (SELECT COUNT(1) FROM promotions WHERE restaurant_id = $1 AND archived_at IS NOT NULL) AS archived_promotions,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = $1) AS total_sent_deliveries
     `,
    [restaurantId]
  );
}

async function updateRestaurantSettings(slug, input) {
  const restaurant = await getRestaurantBySlug(slug);
  if (!restaurant) {
    const error = new Error("Restaurante no encontrado.");
    error.statusCode = 404;
    throw error;
  }

  const name = String(input.name || "").trim();
  const defaultReward = String(input.defaultReward || "").trim() || null;
  const welcomeTemplate = String(input.welcomeTemplate || "").trim() || null;
  const promotionTemplate = String(input.promotionTemplate || "").trim() || null;
  const avgTicketEur = Number.parseFloat(input.avgTicketEur);
  const grossMarginPct = Number.parseFloat(input.grossMarginPct);
  const promoConversionPct = Number.parseFloat(input.promoConversionPct);
  const whatsappCostEur = Number.parseFloat(input.whatsappCostEur);

  if (!name) {
    const error = new Error("El nombre del restaurante es obligatorio.");
    error.statusCode = 400;
    throw error;
  }

  await db.query(
    `UPDATE restaurants
     SET name = $1,
         default_reward = $2,
         welcome_template = $3,
         promotion_template = $4,
         avg_ticket_eur = $5,
         gross_margin_pct = $6,
         promo_conversion_pct = $7,
         whatsapp_cost_eur = $8
     WHERE id = $9`,
    [
      name,
      defaultReward,
      welcomeTemplate,
      promotionTemplate,
      Number.isFinite(avgTicketEur) ? avgTicketEur : null,
      Number.isFinite(grossMarginPct) ? grossMarginPct : null,
      Number.isFinite(promoConversionPct) ? promoConversionPct : null,
      Number.isFinite(whatsappCostEur) ? whatsappCostEur : null,
      restaurant.id,
    ]
  );

  return getRestaurantBySlug(slug);
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
  updateRestaurantSettings,
};
