const { db } = require("./db");
const { sendWhatsAppMessage } = require("./whatsapp");

const activePromotionDispatches = new Set();

const DEFAULT_PROMOTION_TEMPLATE =
  "{message}{validity_line}\n\nResponde BAJA/STOP para dejar de recibir mensajes.";

function renderTemplate(template, variables) {
  return String(template || "").replace(/\{([a-z0-9_]+)\}/gi, (_, key) => {
    const normalizedKey = String(key).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(variables, normalizedKey)) {
      return "";
    }
    const value = variables[normalizedKey];
    return value === undefined || value === null ? "" : String(value);
  });
}

function buildPromotionMessage(promotion) {
  const validityParts = [];
  if (promotion.valid_from) validityParts.push(`desde ${promotion.valid_from}`);
  if (promotion.valid_to) validityParts.push(`hasta ${promotion.valid_to}`);
  const validityText = validityParts.length > 0 ? `Validez: ${validityParts.join(" ")}` : "";
  const validityLine = validityText ? `\n${validityText}` : "";

  const template = promotion.promotion_template || DEFAULT_PROMOTION_TEMPLATE;
  return renderTemplate(template, {
    message: promotion.message,
    title: promotion.title,
    restaurant_name: promotion.restaurant_name,
    valid_from: promotion.valid_from || "",
    valid_to: promotion.valid_to || "",
    validity: validityText,
    validity_line: validityLine,
  });
}

function isUniqueViolation(error) {
  return Boolean(error && error.code === "23505");
}

async function dispatchPromotion({
  promotionId,
  messageCooldownHours,
  weeklyMessageLimit,
}) {
  if (activePromotionDispatches.has(promotionId)) {
    return { inProgress: true };
  }
  activePromotionDispatches.add(promotionId);

  try {
  const promotion = db
    .prepare(
      `SELECT
         p.*,
         r.slug AS restaurant_slug,
         r.name AS restaurant_name,
         r.is_archived,
         r.promotion_template
       FROM promotions p
       JOIN restaurants r ON r.id = p.restaurant_id
       WHERE p.id = ?`
    )
    .get(promotionId);

  if (!promotion) {
    return { notFound: true };
  }
  if (promotion.is_archived) {
    return { archivedRestaurant: true };
  }

  const eligibleLeads = db
    .prepare(
      `
        SELECT l.id, l.phone_e164
        FROM leads l
        WHERE l.restaurant_id = @restaurantId
          AND l.deleted_at IS NULL
          AND l.opt_out_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM promotion_deliveries d
            WHERE d.promotion_id = @promotionId
              AND d.lead_id = l.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM promotion_deliveries d2
            JOIN promotions p2 ON p2.id = d2.promotion_id
            WHERE d2.lead_id = l.id
              AND d2.status = 'sent'
              AND p2.restaurant_id = @restaurantId
              AND d2.created_at >= CURRENT_TIMESTAMP - (@cooldownHours * INTERVAL '1 hour')
          )
          AND (
            SELECT COUNT(1)
            FROM promotion_deliveries d3
            JOIN promotions p3 ON p3.id = d3.promotion_id
            WHERE d3.lead_id = l.id
              AND d3.status = 'sent'
              AND p3.restaurant_id = @restaurantId
              AND d3.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
          ) < @weeklyLimit
        ORDER BY l.created_at ASC
        LIMIT @maxMessages
      `
    )
    .all({
      restaurantId: promotion.restaurant_id,
      promotionId: promotion.id,
      cooldownHours: messageCooldownHours,
      weeklyLimit: weeklyMessageLimit,
      maxMessages: promotion.max_messages,
    });

  const message = buildPromotionMessage(promotion);
  const insertDelivery = db.prepare(`
    INSERT INTO promotion_deliveries (promotion_id, lead_id, status, provider_message_id, error)
    VALUES (@promotionId, @leadId, @status, @providerMessageId, @error)
  `);

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
        insertDelivery.run({
          promotionId: promotion.id,
          leadId: lead.id,
          status: "sent",
          providerMessageId: result.providerMessageId || null,
          error: null,
        });
        sent += 1;
      } catch (error) {
        if (isUniqueViolation(error)) {
          skipped += 1;
          continue;
        }
        throw error;
      }
    } catch (error) {
      try {
        insertDelivery.run({
          promotionId: promotion.id,
          leadId: lead.id,
          status: "failed",
          providerMessageId: null,
          error: error.message || "Unknown error",
        });
        failed += 1;
      } catch (insertError) {
        if (isUniqueViolation(insertError)) {
          skipped += 1;
          continue;
        }
        throw insertError;
      }
    }
  }

  db.prepare("UPDATE promotions SET sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    promotion.id
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

module.exports = { dispatchPromotion };
