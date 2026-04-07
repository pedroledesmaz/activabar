const env = require("../../config/env");
const db = require("../../lib/db");
const { normalizeSlug } = require("../../lib/slug");
const { normalizePhone } = require("../../../phone");

const PUBLIC_RESTAURANT_SELECT = `
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
  twilio_whatsapp_from,
  twilio_sender_status,
  qr_image_url,
  is_archived,
  archived_at,
  created_at
`;

const PRIVATE_RESTAURANT_SELECT = `
  ${PUBLIC_RESTAURANT_SELECT},
  twilio_account_sid,
  twilio_auth_token
`;

function normalizeTwilioSender(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  return normalizePhone(trimmed, env.defaultCountryCode);
}

function isValidTwilioAccountSid(value) {
  return /^AC[0-9a-f]{32}$/i.test(String(value || "").trim());
}

async function listRestaurants() {
  return db.many(
    `SELECT
        id,
        name,
        slug,
        default_reward,
        qr_image_url,
        twilio_whatsapp_from,
        twilio_sender_status,
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
        ${PUBLIC_RESTAURANT_SELECT}
     FROM restaurants
     WHERE slug = $1`,
    [slug]
  );
}

async function getRestaurantBySlugAny(slug) {
  return db.one(
    `SELECT
        ${PUBLIC_RESTAURANT_SELECT}
     FROM restaurants
     WHERE slug = $1`,
    [slug]
  );
}

async function getRestaurantBySlugWithSecrets(slug) {
  return db.one(
    `SELECT
        ${PRIVATE_RESTAURANT_SELECT}
     FROM restaurants
     WHERE slug = $1`,
    [slug]
  );
}

async function getRestaurantBySlugAnyWithSecrets(slug) {
  return db.one(
    `SELECT
        ${PRIVATE_RESTAURANT_SELECT}
     FROM restaurants
     WHERE slug = $1`,
    [slug]
  );
}

async function findRestaurantByWhatsAppSender(phoneE164) {
  return db.one(
    `SELECT
        ${PRIVATE_RESTAURANT_SELECT}
     FROM restaurants
     WHERE twilio_whatsapp_from = $1`,
    [phoneE164]
  );
}

async function getRestaurantSummary(restaurantId) {
  return db.one(
    `SELECT
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL) AS total_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND opt_out_at IS NULL) AS active_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND opt_out_at IS NOT NULL) AS opted_out_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND redeemed_at IS NOT NULL) AS redeemed_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS new_leads_30d,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND redeemed_at IS NOT NULL AND redeemed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS redeemed_30d,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = $1 AND deleted_at IS NULL AND opt_out_at IS NOT NULL AND opt_out_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS optouts_30d,
        (SELECT COUNT(1) FROM promotions WHERE restaurant_id = $1 AND archived_at IS NULL) AS total_promotions,
        (SELECT COUNT(1) FROM promotions WHERE restaurant_id = $1 AND archived_at IS NOT NULL) AS archived_promotions,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = $1) AS total_sent_deliveries,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = $1) AS total_failed_deliveries,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = $1
           AND d.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS sent_30d,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = $1
           AND d.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS failed_30d
     `,
    [restaurantId]
  );
}

async function updateRestaurantSettings(slug, input) {
  const restaurant = await getRestaurantBySlugWithSecrets(slug);
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
  const qrImageUrl = String(input.qrImageUrl || "").trim() || null;
  const promoConversionPct = Number.parseFloat(input.promoConversionPct);
  const whatsappCostEur = Number.parseFloat(input.whatsappCostEur);
  const hasTwilioFieldsInInput = [
    "twilioAccountSid",
    "twilioAuthToken",
    "twilioWhatsappFrom",
  ].some((key) => Object.prototype.hasOwnProperty.call(input, key));

  let twilioAccountSid = restaurant.twilio_account_sid || null;
  let twilioAuthToken = restaurant.twilio_auth_token || null;
  let twilioWhatsappFrom = restaurant.twilio_whatsapp_from || null;
  let twilioSenderStatus = restaurant.twilio_sender_status || null;

  if (!name) {
    const error = new Error("El nombre del restaurante es obligatorio.");
    error.statusCode = 400;
    throw error;
  }

  if (hasTwilioFieldsInInput) {
    const twilioAccountSidInput = String(input.twilioAccountSid || "").trim();
    const twilioAuthTokenInput = String(input.twilioAuthToken || "").trim();
    const twilioWhatsappFromInput = String(input.twilioWhatsappFrom || "").trim();

    if (!twilioAccountSidInput && !twilioAuthTokenInput && !twilioWhatsappFromInput) {
      twilioAccountSid = null;
      twilioAuthToken = null;
      twilioWhatsappFrom = null;
      twilioSenderStatus = null;
    } else {
      twilioAccountSid = twilioAccountSidInput || twilioAccountSid;
      twilioAuthToken = twilioAuthTokenInput || twilioAuthToken;
      twilioWhatsappFrom = normalizeTwilioSender(
        twilioWhatsappFromInput || twilioWhatsappFrom
      );

      if (!twilioWhatsappFrom) {
        const error = new Error("El numero Twilio/WhatsApp del bar no es valido.");
        error.statusCode = 400;
        throw error;
      }

      if (!isValidTwilioAccountSid(twilioAccountSid)) {
        const error = new Error("El Account SID de Twilio no tiene un formato valido.");
        error.statusCode = 400;
        throw error;
      }

      if (!twilioAuthToken) {
        const error = new Error(
          "Falta el Auth Token de Twilio. Si ya estaba guardado, deja el campo vacio pero conserva el resto."
        );
        error.statusCode = 400;
        throw error;
      }

      twilioSenderStatus = "configured";
    }
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
         whatsapp_cost_eur = $8,
         qr_image_url = $9,
         twilio_account_sid = $10,
         twilio_auth_token = $11,
         twilio_whatsapp_from = $12,
         twilio_sender_status = $13
     WHERE id = $14`,
    [
      name,
      defaultReward,
      welcomeTemplate,
      promotionTemplate,
      Number.isFinite(avgTicketEur) ? avgTicketEur : null,
      Number.isFinite(grossMarginPct) ? grossMarginPct : null,
      Number.isFinite(promoConversionPct) ? promoConversionPct : null,
      Number.isFinite(whatsappCostEur) ? whatsappCostEur : null,
      qrImageUrl,
      twilioAccountSid,
      twilioAuthToken,
      twilioWhatsappFrom,
      twilioSenderStatus,
      restaurant.id,
    ]
  );

  return getRestaurantBySlugWithSecrets(slug);
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
  getRestaurantBySlugWithSecrets,
  getRestaurantBySlugAnyWithSecrets,
  findRestaurantByWhatsAppSender,
  getRestaurantSummary,
  createRestaurant,
  updateRestaurantSettings,
};
