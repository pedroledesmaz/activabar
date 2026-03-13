const env = require("../../config/env");
const db = require("../../lib/db");
const { renderTemplate } = require("../../lib/templates");
const { sendWhatsAppMessage } = require("../../../whatsapp");

const activePromotionDispatches = new Set();

const DEFAULT_PROMOTION_TEMPLATE =
  "{message}{validity_line}\n\nResponde BAJA/STOP para dejar de recibir mensajes.";

function buildPromotionMessage(promotion) {
  const validityParts = [];
  if (promotion.valid_from) validityParts.push(`desde ${promotion.valid_from}`);
  if (promotion.valid_to) validityParts.push(`hasta ${promotion.valid_to}`);
  const validityText = validityParts.length > 0 ? `Validez: ${validityParts.join(" ")}` : "";
  const validityLine = validityText ? `\n${validityText}` : "";

  return renderTemplate(
    promotion.promotion_template || DEFAULT_PROMOTION_TEMPLATE,
    {
      message: promotion.message,
      title: promotion.title,
      restaurant_name: promotion.restaurant_name,
      valid_from: promotion.valid_from || "",
      valid_to: promotion.valid_to || "",
      validity: validityText,
      validity_line: validityLine,
    }
  );
}

async function listPromotionsByRestaurant(restaurantId, limit = 20) {
  return db.many(
    `SELECT
        p.id,
        p.title,
        p.message,
        p.valid_from,
        p.valid_to,
        p.max_messages,
        p.offer_cost_eur,
        p.sent_at,
        p.created_at,
        COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0) AS sent_count,
        COALESCE(SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count
     FROM promotions p
     LEFT JOIN promotion_deliveries d ON d.promotion_id = p.id
     WHERE p.restaurant_id = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC
     LIMIT $2`,
    [restaurantId, limit]
  );
}

async function createPromotion(input) {
  const cleanTitle = String(input.title || "").trim();
  const cleanMessage = String(input.message || "").trim();
  const maxMessages = Number.parseInt(input.maxMessages, 10);
  const offerCostEur = Number.parseFloat(input.offerCostEur);

  if (!cleanTitle || !cleanMessage) {
    const error = new Error("Titulo y mensaje son obligatorios.");
    error.statusCode = 400;
    throw error;
  }

  return db.one(
    `INSERT INTO promotions (
       restaurant_id,
       title,
       message,
       valid_from,
       valid_to,
       max_messages,
       offer_cost_eur
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING
       id,
       restaurant_id,
       title,
       message,
       valid_from,
       valid_to,
       max_messages,
       offer_cost_eur,
       sent_at,
       created_at`,
    [
      input.restaurantId,
      cleanTitle,
      cleanMessage,
      String(input.validFrom || "").trim() || null,
      String(input.validTo || "").trim() || null,
      Number.isFinite(maxMessages) && maxMessages > 0 ? maxMessages : 100,
      Number.isFinite(offerCostEur) && offerCostEur >= 0 ? offerCostEur : 0,
    ]
  );
}

async function countEligibleLeadsForPromotion({ promotionId }) {
  const promotion = await db.one(
    `SELECT id, restaurant_id, max_messages
     FROM promotions
     WHERE id = $1`,
    [promotionId]
  );

  if (!promotion) {
    return 0;
  }

  const row = await db.one(
    `SELECT COUNT(1) AS total
     FROM (
       SELECT l.id
       FROM leads l
       WHERE l.restaurant_id = $1
         AND l.deleted_at IS NULL
         AND l.opt_out_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM promotion_deliveries d
           WHERE d.promotion_id = $2
             AND d.lead_id = l.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM promotion_deliveries d2
           JOIN promotions p2 ON p2.id = d2.promotion_id
           WHERE d2.lead_id = l.id
             AND d2.status = 'sent'
             AND p2.restaurant_id = $1
             AND d2.created_at >= CURRENT_TIMESTAMP - ($3 * INTERVAL '1 hour')
         )
         AND (
           SELECT COUNT(1)
           FROM promotion_deliveries d3
           JOIN promotions p3 ON p3.id = d3.promotion_id
           WHERE d3.lead_id = l.id
             AND d3.status = 'sent'
             AND p3.restaurant_id = $1
             AND d3.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
         ) < $4
       ORDER BY l.created_at ASC
       LIMIT $5
     ) eligible`,
    [
      promotion.restaurant_id,
      promotion.id,
      env.messageCooldownHours,
      env.weeklyMessageLimit,
      promotion.max_messages,
    ]
  );

  return Number(row?.total || 0);
}

async function dispatchPromotion({ promotionId }) {
  if (activePromotionDispatches.has(promotionId)) {
    return { inProgress: true };
  }
  activePromotionDispatches.add(promotionId);

  try {
    const promotion = await db.one(
      `SELECT
          p.*,
          r.slug AS restaurant_slug,
          r.name AS restaurant_name,
          r.is_archived,
          r.promotion_template
       FROM promotions p
       JOIN restaurants r ON r.id = p.restaurant_id
       WHERE p.id = $1`,
      [promotionId]
    );

    if (!promotion) {
      return { notFound: true };
    }

    if (Number(promotion.is_archived) === 1) {
      return { archivedRestaurant: true };
    }

    const eligibleLeads = await db.many(
      `SELECT l.id, l.phone_e164
       FROM leads l
       WHERE l.restaurant_id = $1
         AND l.deleted_at IS NULL
         AND l.opt_out_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM promotion_deliveries d
           WHERE d.promotion_id = $2
             AND d.lead_id = l.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM promotion_deliveries d2
           JOIN promotions p2 ON p2.id = d2.promotion_id
           WHERE d2.lead_id = l.id
             AND d2.status = 'sent'
             AND p2.restaurant_id = $1
             AND d2.created_at >= CURRENT_TIMESTAMP - ($3 * INTERVAL '1 hour')
         )
         AND (
           SELECT COUNT(1)
           FROM promotion_deliveries d3
           JOIN promotions p3 ON p3.id = d3.promotion_id
           WHERE d3.lead_id = l.id
             AND d3.status = 'sent'
             AND p3.restaurant_id = $1
             AND d3.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
         ) < $4
       ORDER BY l.created_at ASC
       LIMIT $5`,
      [
        promotion.restaurant_id,
        promotion.id,
        env.messageCooldownHours,
        env.weeklyMessageLimit,
        promotion.max_messages,
      ]
    );

    const message = buildPromotionMessage(promotion);
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const lead of eligibleLeads) {
      try {
        const result = await sendWhatsAppMessage({
          to: lead.phone_e164,
          body: message,
        });

        try {
          await db.query(
            `INSERT INTO promotion_deliveries (
               promotion_id, lead_id, status, provider_message_id, error
             )
             VALUES ($1, $2, 'sent', $3, NULL)`,
            [promotion.id, lead.id, result.providerMessageId || null]
          );
          sent += 1;
        } catch (error) {
          if (error.code === "23505") {
            skipped += 1;
            continue;
          }
          throw error;
        }
      } catch (error) {
        try {
          await db.query(
            `INSERT INTO promotion_deliveries (
               promotion_id, lead_id, status, provider_message_id, error
             )
             VALUES ($1, $2, 'failed', NULL, $3)`,
            [promotion.id, lead.id, error.message || "Unknown error"]
          );
          failed += 1;
        } catch (insertError) {
          if (insertError.code === "23505") {
            skipped += 1;
            continue;
          }
          throw insertError;
        }
      }
    }

    await db.query(
      "UPDATE promotions SET sent_at = CURRENT_TIMESTAMP WHERE id = $1",
      [promotion.id]
    );

    return {
      ok: true,
      promotionId: promotion.id,
      eligible: eligibleLeads.length,
      sent,
      failed,
      skipped,
    };
  } finally {
    activePromotionDispatches.delete(promotionId);
  }
}

module.exports = {
  listPromotionsByRestaurant,
  createPromotion,
  countEligibleLeadsForPromotion,
  dispatchPromotion,
};
