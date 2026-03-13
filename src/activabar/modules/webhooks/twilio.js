const crypto = require("crypto");
const express = require("express");
const env = require("../../config/env");
const logger = require("../../lib/logger");
const db = require("../../lib/db");
const { normalizePhone } = require("../../../phone");
const { getRestaurantBySlugAny } = require("../restaurants/service");

const router = express.Router();

const STOP_KEYWORDS = new Set([
  "STOP",
  "BAJA",
  "UNSUBSCRIBE",
  "CANCEL",
  "CANCELAR",
  "SALIR",
  "PARAR",
  "QUIT",
  "END",
]);

const START_KEYWORDS = new Set(["START", "ALTA", "REANUDAR", "CONTINUAR"]);

function isStopCommand(text) {
  const normalized = String(text || "")
    .trim()
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  const token = normalized.split(/\s+/)[0] || "";
  return STOP_KEYWORDS.has(token);
}

function isStartCommand(text) {
  const normalized = String(text || "")
    .trim()
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  const token = normalized.split(/\s+/)[0] || "";
  return START_KEYWORDS.has(token);
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlMessage(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
    message
  )}</Message></Response>`;
}

function buildRequestUrl(req) {
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function computeTwilioSignature(url, payload, authToken) {
  const sortedKeys = Object.keys(payload || {}).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += `${key}${payload[key]}`;
  }
  return crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

function validateTwilioSignature(req) {
  if (!env.twilioWebhookValidateSignature) return true;

  const providedSignature = String(req.get("x-twilio-signature") || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!providedSignature || !authToken) {
    return false;
  }

  const expected = computeTwilioSignature(buildRequestUrl(req), req.body || {}, authToken);
  const left = Buffer.from(providedSignature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

async function applyInboundOptCommand({ restaurantId = null, phoneE164, bodyText }) {
  if (!phoneE164) {
    return { ok: false, code: "invalid_phone" };
  }

  const cleanBody = String(bodyText || "").trim();
  const isStop = isStopCommand(cleanBody);
  const isStart = isStartCommand(cleanBody);
  if (!isStop && !isStart) {
    return { ok: true, ignored: true };
  }

  const params = [phoneE164];
  let whereClause = "phone_e164 = $1 AND deleted_at IS NULL";
  if (restaurantId) {
    params.push(restaurantId);
    whereClause += ` AND restaurant_id = $${params.length}`;
  }

  if (isStop) {
    const result = await db.query(
      `UPDATE leads
       SET opt_out_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE ${whereClause}`,
      params
    );
    return { ok: true, action: "optout", affected: result.rowCount || 0 };
  }

  const result = await db.query(
    `UPDATE leads
     SET opt_out_at = NULL,
         consent_at = CURRENT_TIMESTAMP,
         consent_version = $1,
         consent_text = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE ${
       restaurantId
         ? "phone_e164 = $3 AND deleted_at IS NULL AND restaurant_id = $4"
         : "phone_e164 = $3 AND deleted_at IS NULL"
     }`,
    [
      "whatsapp-reactivation-v1",
      "Reactivado por mensaje START/ALTA",
      ...params,
    ]
  );
  return { ok: true, action: "optin", affected: result.rowCount || 0 };
}

async function handleTwilioInboundWebhook(req, res, targetRestaurant) {
  if (!validateTwilioSignature(req)) {
    logger.warn("twilio.webhook.invalid_signature", {
      path: req.originalUrl,
      requestId: req.requestId,
    });
    return res.status(403).send("Forbidden");
  }

  const fromRaw = String(req.body.From || "").replace(/^whatsapp:/i, "");
  const bodyText = String(req.body.Body || "");
  const phoneE164 = normalizePhone(fromRaw, env.defaultCountryCode);
  const restaurantId = targetRestaurant ? targetRestaurant.id : null;
  const result = await applyInboundOptCommand({
    restaurantId,
    phoneE164,
    bodyText,
  });

  logger.info("twilio.webhook.inbound", {
    from: phoneE164 || fromRaw,
    bodyText,
    restaurantSlug: targetRestaurant?.slug || null,
    result,
  });

  let responseText =
    "Mensaje recibido. Si quieres dejar de recibir promociones responde BAJA.";
  if (result.action === "optout") {
    responseText =
      result.affected > 0
        ? "Has sido dado de baja correctamente. No recibiras mas promociones."
        : "No hemos encontrado tu registro activo para darlo de baja.";
  } else if (result.action === "optin") {
    responseText =
      result.affected > 0
        ? "Has vuelto a activar tus mensajes promocionales."
        : "No encontramos un registro para reactivar.";
  }

  res.type("text/xml");
  return res.send(twimlMessage(responseText));
}

router.post("/twilio/whatsapp/inbound", async (req, res, next) => {
  try {
    return await handleTwilioInboundWebhook(req, res, null);
  } catch (error) {
    return next(error);
  }
});

router.post("/twilio/whatsapp/:slug/inbound", async (req, res, next) => {
  try {
    const restaurant = await getRestaurantBySlugAny(req.params.slug);
    if (!restaurant) {
      return res.status(404).send("Restaurant not found");
    }
    return await handleTwilioInboundWebhook(req, res, restaurant);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
