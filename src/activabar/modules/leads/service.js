const env = require("../../config/env");
const db = require("../../lib/db");
const { renderTemplate } = require("../../lib/templates");
const { normalizePhone } = require("../../../phone");
const { sendWhatsAppMessage } = require("../../../whatsapp");

const DEFAULT_WELCOME_TEMPLATE = [
  "{restaurant_name}",
  "Tu codigo para canjear {reward_label} es: {claim_code}",
  "Ensenalo al camarero para validar el canje.",
  "Si no solicitaste este mensaje, ignora o responde BAJA/STOP.",
].join("\n");

function generateClaimCode(length) {
  const max = Math.pow(10, length);
  const min = Math.pow(10, length - 1);
  return String(Math.floor(Math.random() * (max - min) + min));
}

async function generateUniqueClaimCode(restaurantId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const claimCode = generateClaimCode(env.welcomeCodeLength);
    const existing = await db.one(
      "SELECT id FROM leads WHERE restaurant_id = $1 AND claim_code = $2",
      [restaurantId, claimCode]
    );
    if (!existing) {
      return claimCode;
    }
  }

  throw new Error("Could not generate unique claim code.");
}

async function listLeadsByRestaurant(restaurantId, limit = 50) {
  return db.many(
    `SELECT
        id,
        phone_e164,
        source_qr,
        reward_label,
        claim_code,
        claim_code_sent_at,
        redeemed_at,
        opt_out_at,
        created_at
     FROM leads
     WHERE restaurant_id = $1
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [restaurantId, limit]
  );
}

async function createLead({ restaurant, phone, sourceQr, rewardLabel, sendWelcome }) {
  const normalizedPhone = normalizePhone(phone, env.defaultCountryCode);
  if (!normalizedPhone) {
    const error = new Error("Numero de WhatsApp invalido.");
    error.statusCode = 400;
    throw error;
  }

  const claimCode = await generateUniqueClaimCode(restaurant.id);
  const cleanRewardLabel = String(
    rewardLabel || restaurant.default_reward || "detalle de bienvenida"
  ).trim();

  const existingLead = await db.one(
    `SELECT
        id,
        opt_out_at,
        deleted_at,
        consent_at,
        claim_code
     FROM leads
     WHERE restaurant_id = $1
       AND phone_e164 = $2`,
    [restaurant.id, normalizedPhone]
  );

  await db.query(
    `INSERT INTO leads (
       restaurant_id, phone_e164, source_qr, reward_label,
       consent_version, consent_text, consent_ip, consent_user_agent,
       claim_code, claim_code_sent_at, claim_code_redeemed_at,
       consent_at, redeemed_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, NULL, NULL,
       CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
     )
     ON CONFLICT (restaurant_id, phone_e164) DO UPDATE SET
       source_qr = EXCLUDED.source_qr,
       reward_label = EXCLUDED.reward_label,
       claim_code = EXCLUDED.claim_code,
       claim_code_sent_at = NULL,
       claim_code_redeemed_at = NULL,
       redeemed_at = NULL,
       deleted_at = NULL,
       deleted_reason = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [
      restaurant.id,
      normalizedPhone,
      String(sourceQr || "manual-admin").trim() || "manual-admin",
      cleanRewardLabel,
      "manual-panel-v1",
      "Alta manual desde panel por operador autorizado.",
      "manual",
      "activabar-panel",
      claimCode,
    ]
  );

  const lead = await db.one(
    `SELECT
        id,
        phone_e164,
        source_qr,
        reward_label,
        claim_code,
        claim_code_sent_at,
        opt_out_at,
        created_at
     FROM leads
     WHERE restaurant_id = $1
       AND phone_e164 = $2
       AND deleted_at IS NULL`,
    [restaurant.id, normalizedPhone]
  );

  let confirmationSent = false;
  let confirmationError = null;
  const remainsOptedOut = Boolean(lead.opt_out_at);

  if (sendWelcome && env.welcomeConfirmationEnabled && !remainsOptedOut) {
    const confirmationBody = renderTemplate(
      restaurant.welcome_template || DEFAULT_WELCOME_TEMPLATE,
      {
        restaurant_name: restaurant.name,
        reward_label: cleanRewardLabel,
        claim_code: lead.claim_code,
        phone_e164: lead.phone_e164,
      }
    );

    try {
      await sendWhatsAppMessage({
        to: normalizedPhone,
        body: confirmationBody,
        accountSid: restaurant.twilio_account_sid,
        authToken: restaurant.twilio_auth_token,
        from: restaurant.twilio_whatsapp_from,
      });
      await db.query(
        `UPDATE leads
         SET claim_code_sent_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [lead.id]
      );
      confirmationSent = true;
      lead.claim_code_sent_at = new Date().toISOString();
    } catch (error) {
      confirmationError = error.message || "No se pudo enviar el mensaje de bienvenida.";
    }
  }

  return {
    lead,
    confirmationSent,
    confirmationError,
    remainsOptedOut,
    wasExistingLead: Boolean(existingLead),
  };
}

module.exports = {
  listLeadsByRestaurant,
  createLead,
};
