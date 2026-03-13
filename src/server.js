require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { db, initDb } = require("./db");
const { normalizePhone } = require("./phone");
const { dispatchPromotion } = require("./dispatch");
const { sendWhatsAppMessage } = require("./whatsapp");
const { performPostgresBackup } = require("./backup");
const logger = require("./logger");
const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  parseCookies,
} = require("./auth");

const app = express();
initDb();

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "+34";
const STAFF_TOKEN = process.env.STAFF_TOKEN || "dev-staff-token";
const JOB_TOKEN = process.env.JOB_TOKEN || "dev-job-token";
const MESSAGE_COOLDOWN_HOURS = Number(process.env.MESSAGE_COOLDOWN_HOURS || 72);
const WEEKLY_MESSAGE_LIMIT = Number(process.env.WEEKLY_MESSAGE_LIMIT || 2);
const WELCOME_CONFIRMATION_ENABLED = isTruthy(
  process.env.WELCOME_CONFIRMATION_ENABLED || "true"
);
const WELCOME_CODE_LENGTH = Math.min(
  10,
  Math.max(4, Number(process.env.WELCOME_CODE_LENGTH || 6))
);
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "wm_session";
const NODE_ENV = process.env.NODE_ENV || "development";
const SCHEDULER_ENABLED = isTruthy(process.env.SCHEDULER_ENABLED || "true");
const SCHEDULER_POLL_SECONDS = Math.max(
  10,
  Number(process.env.SCHEDULER_POLL_SECONDS || 30)
);
const BACKUP_ENABLED = isTruthy(process.env.BACKUP_ENABLED || "true");
const BACKUP_INTERVAL_HOURS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24));
const BACKUP_RETENTION_DAYS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 14));
const BACKUP_DIR = process.env.BACKUP_DIR || "./data/backups";
const CONSENT_VERSION = String(process.env.CONSENT_VERSION || "2026-02-14-v1").trim();
const PRIVACY_URL = process.env.PRIVACY_URL || "/privacy";
const DATA_CONTROLLER_NAME = String(
  process.env.DATA_CONTROLLER_NAME || "Titular del servicio"
).trim();
const DATA_CONTROLLER_EMAIL = String(process.env.DATA_CONTROLLER_EMAIL || "").trim();
const DATA_CONTROLLER_ADDRESS = String(process.env.DATA_CONTROLLER_ADDRESS || "").trim();
const TWILIO_WEBHOOK_VALIDATE_SIGNATURE = isTruthy(
  process.env.TWILIO_WEBHOOK_VALIDATE_SIGNATURE || "false"
);

const DEFAULT_WELCOME_TEMPLATE = [
  "{restaurant_name}",
  "Tu codigo para canjear {reward_label} es: {claim_code}",
  "Ensenalo al camarero para validar el canje.",
  "Si no solicitaste este mensaje, ignora o responde BAJA/STOP.",
].join("\n");

const DEFAULT_PROMOTION_TEMPLATE =
  "{message}{validity_line}\n\nResponde BAJA/STOP para dejar de recibir mensajes.";
const WEEKDAY_LABELS = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miercoles",
  "Jueves",
  "Viernes",
  "Sabado",
];
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
const CONSENT_TEXT =
  "Acepto recibir promociones puntuales por WhatsApp y entiendo que puedo darme de baja respondiendo BAJA/STOP.";

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.set("trust proxy", 1);

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isTruthy(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

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

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (typeof req.ip === "string" && req.ip.trim()) {
    return req.ip;
  }
  return req.socket?.remoteAddress || "";
}

function twimlMessage(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeHtml(
    String(message || "")
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
  if (!TWILIO_WEBHOOK_VALIDATE_SIGNATURE) return true;
  const providedSignature = String(req.get("x-twilio-signature") || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!providedSignature || !authToken) return false;

  const expected = computeTwilioSignature(buildRequestUrl(req), req.body || {}, authToken);
  const left = Buffer.from(providedSignature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireToken(headerName, expectedToken) {
  return (req, res, next) => {
    const token = req.get(headerName);
    if (!token || token !== expectedToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  };
}

function getRestaurantBySlug(slug) {
  return db
    .prepare(
      `SELECT
        id, name, slug, default_reward, welcome_template, promotion_template,
        avg_ticket_eur, gross_margin_pct, promo_conversion_pct, whatsapp_cost_eur,
        is_archived, archived_at
       FROM restaurants
       WHERE slug = ? AND is_archived = 0`
    )
    .get(slug);
}

function getRestaurantBySlugAny(slug) {
  return db
    .prepare(
      `SELECT
        id, name, slug, default_reward, welcome_template, promotion_template,
        avg_ticket_eur, gross_margin_pct, promo_conversion_pct, whatsapp_cost_eur,
        is_archived, archived_at
       FROM restaurants
       WHERE slug = ?`
    )
    .get(slug);
}

function normalizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toSqlDatetimeFromNow(days) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function setSessionCookie(res, token) {
  const maxAgeSeconds = Math.max(1, Math.floor(SESSION_TTL_DAYS * 24 * 60 * 60));
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (NODE_ENV === "production") {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (NODE_ENV === "production") {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const row = db
    .prepare(
      `SELECT
          s.id AS session_id,
          s.operator_id,
          o.email,
          o.role
       FROM sessions s
       JOIN operators o ON o.id = s.operator_id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > CURRENT_TIMESTAMP
         AND o.is_active = 1`
    )
    .get(tokenHash);

  if (!row) return null;
  return {
    token,
    tokenHash,
    sessionId: row.session_id,
    operatorId: row.operator_id,
    email: row.email,
    role: row.role,
  };
}

function safeReturnTo(returnTo) {
  if (!returnTo || typeof returnTo !== "string") return "/app";
  if (!returnTo.startsWith("/app")) return "/app";
  return returnTo;
}

function appendQuery(urlPath, params) {
  const base = "http://localhost";
  const url = new URL(urlPath, base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

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

function hashStaffToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateStaffToken() {
  return `stf_${crypto.randomBytes(24).toString("hex")}`;
}

function authenticateStaffTokenForRestaurant(restaurantId, providedToken) {
  const token = String(providedToken || "").trim();
  if (!token) {
    return false;
  }

  // Optional global master token for emergency operations.
  if (STAFF_TOKEN && token === STAFF_TOKEN) {
    return true;
  }

  const tokenHash = hashStaffToken(token);
  const staffToken = db
    .prepare(
      `SELECT id
       FROM restaurant_staff_tokens
       WHERE restaurant_id = ?
         AND token_hash = ?
         AND revoked_at IS NULL`
    )
    .get(restaurantId, tokenHash);

  if (!staffToken) {
    return false;
  }

  db.prepare(
    "UPDATE restaurant_staff_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(staffToken.id);

  return true;
}

function generateClaimCode(length) {
  const max = Math.pow(10, length);
  const min = Math.pow(10, length - 1);
  return String(Math.floor(Math.random() * (max - min) + min));
}

function generateUniqueClaimCode(restaurantId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateClaimCode(WELCOME_CODE_LENGTH);
    const existing = db
      .prepare(
        "SELECT id FROM leads WHERE restaurant_id = ? AND claim_code = ?"
      )
      .get(restaurantId, code);
    if (!existing) {
      return code;
    }
  }
  throw new Error("Could not generate unique claim code");
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatEuro(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${amount.toFixed(2)} EUR`;
}

function computeNextRunAt(dayOfWeek, hour, minute, fromDate = new Date()) {
  const day = Math.max(0, Math.min(6, Number(dayOfWeek)));
  const hh = Math.max(0, Math.min(23, Number(hour)));
  const mm = Math.max(0, Math.min(59, Number(minute)));

  const candidate = new Date(fromDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setHours(hh, mm, 0, 0);

  const today = candidate.getDay();
  let offset = day - today;
  if (offset < 0 || (offset === 0 && candidate <= fromDate)) {
    offset += 7;
  }
  candidate.setDate(candidate.getDate() + offset);
  return candidate;
}

function toSqlDatetime(date) {
  return new Date(date.getTime()).toISOString().slice(0, 19).replace("T", " ");
}

function estimatePromotionFinance({
  sentCount,
  offerCostEur,
  avgTicketEur,
  grossMarginPct,
  promoConversionPct,
  whatsappCostEur,
}) {
  const sent = asNumber(sentCount, 0);
  const offerCost = Math.max(0, asNumber(offerCostEur, 0));
  const avgTicket = Math.max(0, asNumber(avgTicketEur, 20));
  const marginPct = Math.max(0, Math.min(100, asNumber(grossMarginPct, 70)));
  const conversionPct = Math.max(0, Math.min(100, asNumber(promoConversionPct, 8)));
  const messageCost = Math.max(0, asNumber(whatsappCostEur, 0.08));

  const estimatedOrders = sent * (conversionPct / 100);
  const estimatedRevenue = estimatedOrders * avgTicket;
  const estimatedGrossProfit = estimatedRevenue * (marginPct / 100);
  const estimatedCampaignCost = sent * messageCost + offerCost;
  const estimatedNet = estimatedGrossProfit - estimatedCampaignCost;
  const roiPct =
    estimatedCampaignCost > 0 ? (estimatedNet / estimatedCampaignCost) * 100 : 0;

  return {
    sent,
    estimatedOrders,
    estimatedRevenue,
    estimatedGrossProfit,
    estimatedCampaignCost,
    estimatedNet,
    roiPct,
  };
}

function formatDayTime(dayOfWeek, hour, minute) {
  const day = WEEKDAY_LABELS[Math.max(0, Math.min(6, Number(dayOfWeek)))];
  const hh = String(Math.max(0, Math.min(23, Number(hour)))).padStart(2, "0");
  const mm = String(Math.max(0, Math.min(59, Number(minute)))).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

function requireAppAuth(req, res, next) {
  if (!req.operator) {
    if (req.accepts("html")) {
      return res.redirect("/login");
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

function createPromotion({
  restaurantId,
  title,
  message,
  validFrom,
  validTo,
  maxMessages,
  offerCostEur,
}) {
  const cleanTitle = String(title || "").trim();
  const cleanMessage = String(message || "").trim();

  if (!cleanTitle || !cleanMessage) {
    return { error: "title and message are required" };
  }

  const max = Number.isFinite(Number(maxMessages)) ? Number(maxMessages) : 100;
  const parsedOfferCost = Number(offerCostEur);
  const cleanOfferCost =
    Number.isFinite(parsedOfferCost) && parsedOfferCost >= 0 ? parsedOfferCost : 0;

  const insert = db.prepare(`
    INSERT INTO promotions (
      restaurant_id, title, message, valid_from, valid_to, max_messages, offer_cost_eur
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    restaurantId,
    cleanTitle,
    cleanMessage,
    validFrom || null,
    validTo || null,
    max > 0 ? max : 100,
    cleanOfferCost
  );

  const promotion = db
    .prepare("SELECT * FROM promotions WHERE id = ?")
    .get(result.lastInsertRowid);

  return { promotion };
}

function ensureBootstrapOperator() {
  const totalOperators = db.prepare("SELECT COUNT(1) AS count FROM operators").get().count;
  if (totalOperators > 0) return;

  let email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD || "";

  if (!email || !password) {
    if (NODE_ENV === "production") {
      logger.error("auth.bootstrap_admin.missing_env", {
        message: "No admin configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.",
      });
      return;
    }
    email = "admin@local.test";
    password = "admin12345";
    logger.warn("auth.bootstrap_admin.local_default", {
      message: "Auto-created local admin user: admin@local.test / admin12345",
    });
  }

  db.prepare(
    "INSERT INTO operators (email, password_hash, role, is_active) VALUES (?, ?, 'admin', 1)"
  ).run(email, hashPassword(password));
}

let schedulerRunning = false;
let backupRunning = false;

async function runDueSchedulesOnce() {
  if (!SCHEDULER_ENABLED || schedulerRunning) return;
  schedulerRunning = true;
  try {
    const dueSchedules = db
      .prepare(
        `SELECT
          s.*,
          r.is_archived
        FROM promotion_schedules s
        JOIN restaurants r ON r.id = s.restaurant_id
        WHERE s.is_active = 1
          AND s.next_run_at <= CURRENT_TIMESTAMP
        ORDER BY s.next_run_at ASC
        LIMIT 20`
      )
      .all();

    for (const schedule of dueSchedules) {
      const nextRunAt = toSqlDatetime(
        computeNextRunAt(schedule.day_of_week, schedule.hour, schedule.minute, new Date())
      );

      if (schedule.is_archived) {
        db.prepare(
          `UPDATE promotion_schedules
           SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(nextRunAt, schedule.id);
        continue;
      }

      const created = createPromotion({
        restaurantId: schedule.restaurant_id,
        title: schedule.title,
        message: schedule.message,
        validFrom: schedule.valid_from,
        validTo: schedule.valid_to,
        maxMessages: schedule.max_messages,
        offerCostEur: schedule.offer_cost_eur,
      });

      if (!created.error && created.promotion) {
        await dispatchPromotion({
          promotionId: created.promotion.id,
          messageCooldownHours: MESSAGE_COOLDOWN_HOURS,
          weeklyMessageLimit: WEEKLY_MESSAGE_LIMIT,
        });
      }

      db.prepare(
        `UPDATE promotion_schedules
         SET last_run_at = CURRENT_TIMESTAMP,
             next_run_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(nextRunAt, schedule.id);
    }
  } finally {
    schedulerRunning = false;
  }
}

async function runBackupOnce(label = "auto") {
  if (!BACKUP_ENABLED || backupRunning) return;
  backupRunning = true;
  try {
    const destination = await performPostgresBackup({
      db,
      backupDir: BACKUP_DIR,
      retentionDays: BACKUP_RETENTION_DAYS,
      label,
    });
    logger.info("backup.completed", { label, destination });
  } finally {
    backupRunning = false;
  }
}

function startBackgroundWorkers() {
  if (SCHEDULER_ENABLED) {
    setInterval(() => {
      runDueSchedulesOnce().catch((error) => {
        logger.error("scheduler.loop.error", { message: error.message }, error);
      });
    }, SCHEDULER_POLL_SECONDS * 1000);
  }

  if (BACKUP_ENABLED) {
    setInterval(() => {
      runBackupOnce("auto").catch((error) => {
        logger.error("backup.loop.error", { message: error.message }, error);
      });
    }, BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
  }
}

app.use((req, _res, next) => {
  req.operator = getSessionFromRequest(req);
  next();
});

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    logger.info("http.request", {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: getClientIp(req),
      operatorEmail: req.operator?.email || null,
    });
  });
  next();
});

ensureBootstrapOperator();
startBackgroundWorkers();
runDueSchedulesOnce().catch((error) => {
  logger.error("scheduler.startup.error", { message: error.message }, error);
});
runBackupOnce("startup").catch((error) => {
  logger.error("backup.startup.error", { message: error.message }, error);
});

app.get("/", (req, res) => {
  if (req.operator) return res.redirect("/app");
  return res.redirect("/login");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/health/full", (_req, res) => {
  try {
    db.prepare("SELECT 1").get();
    return res.json({
      status: "ok",
      app: "whatsapp-restaurant-mvp",
      db: "ok",
      time: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("health.full.error", { message: error.message }, error);
    return res.status(500).json({ status: "error", db: "down" });
  }
});

app.get("/privacy", (_req, res) => {
  return res.send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Politica de privacidad</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
          main { max-width: 860px; margin: 24px auto; padding: 0 16px 32px; }
          .card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 10px 22px rgba(0,0,0,.08); }
          h1, h2 { margin-top: 0; }
          p, li { line-height: 1.5; }
        </style>
      </head>
      <body>
        <main>
          <section class="card">
            <h1>Politica de privacidad</h1>
            <p><strong>Responsable:</strong> ${escapeHtml(DATA_CONTROLLER_NAME)}</p>
            <p><strong>Email de contacto:</strong> ${escapeHtml(
              DATA_CONTROLLER_EMAIL || "No configurado"
            )}</p>
            <p><strong>Direccion:</strong> ${escapeHtml(
              DATA_CONTROLLER_ADDRESS || "No configurada"
            )}</p>
            <h2>Datos que tratamos</h2>
            <ul>
              <li>Numero de WhatsApp en formato internacional.</li>
              <li>Fecha y contexto del consentimiento (bar y origen QR).</li>
              <li>Historial de promociones, baja y canje cuando aplique.</li>
            </ul>
            <h2>Finalidad</h2>
            <p>Enviar promociones puntuales y gestionar canjes solicitados por el usuario.</p>
            <h2>Base legal</h2>
            <p>Consentimiento expreso del usuario (version ${escapeHtml(
              CONSENT_VERSION
            )}).</p>
            <h2>Derechos</h2>
            <p>Puedes solicitar acceso, rectificacion o supresion de tus datos y darte de baja en cualquier momento respondiendo BAJA/STOP.</p>
            <p>Para ejercer derechos, escribe a ${escapeHtml(
              DATA_CONTROLLER_EMAIL || "tu email de soporte"
            )}.</p>
          </section>
        </main>
      </body>
    </html>
  `);
});

app.get("/login", (req, res) => {
  if (req.operator) return res.redirect("/app");
  const error = req.query.error ? "Credenciales incorrectas" : "";

  return res.send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Acceso plataforma</title>
        <style>
          body { margin: 0; font-family: Arial, sans-serif; background: radial-gradient(circle at 20% 0%, #f3f8ff 0%, #e9eef8 45%, #eef1f5 100%); color: #17212b; }
          .wrap { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
          .card { width: 100%; max-width: 420px; background: #fff; border-radius: 14px; padding: 26px; box-shadow: 0 18px 36px rgba(0,0,0,.12); }
          h1 { margin: 0 0 8px; }
          p { margin: 0 0 20px; color: #4a5663; }
          label { display: block; font-weight: 600; margin-top: 12px; }
          input { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 12px; border-radius: 9px; border: 1px solid #c8d2df; }
          button { width: 100%; margin-top: 18px; padding: 12px; border: none; border-radius: 10px; background: #0f172a; color: #fff; font-weight: 700; cursor: pointer; }
          .err { color: #b91c1c; font-weight: 700; min-height: 20px; }
        </style>
      </head>
      <body>
        <main class="wrap">
          <section class="card">
            <h1>Panel de control</h1>
            <p>Gestiona varios bares desde una sola plataforma.</p>
            <div class="err">${escapeHtml(error)}</div>
            <form method="post" action="/login">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" required />
              <label for="password">Contrasena</label>
              <input id="password" name="password" type="password" required />
              <button type="submit">Entrar</button>
            </form>
          </section>
        </main>
      </body>
    </html>
  `);
});

app.post("/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.redirect("/login?error=1");
  }

  const operator = db
    .prepare("SELECT id, email, password_hash, is_active FROM operators WHERE email = ?")
    .get(email);

  if (!operator || !operator.is_active) {
    return res.redirect("/login?error=1");
  }

  const valid = verifyPassword(password, operator.password_hash);
  if (!valid) {
    return res.redirect("/login?error=1");
  }

  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = toSqlDatetimeFromNow(SESSION_TTL_DAYS);

  db.prepare(
    "INSERT INTO sessions (operator_id, token_hash, expires_at) VALUES (?, ?, ?)"
  ).run(operator.id, tokenHash, expiresAt);

  // Lazy cleanup of expired sessions.
  db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();

  setSessionCookie(res, token);
  return res.redirect("/app");
});

app.post("/logout", (req, res) => {
  const session = getSessionFromRequest(req);
  if (session) {
    db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      session.sessionId
    );
  }
  clearSessionCookie(res);
  return res.redirect("/login");
});

app.get("/app", requireAppAuth, (req, res) => {
  const restaurants = db
    .prepare(
      `SELECT
        r.id,
        r.name,
        r.slug,
        r.is_archived,
        r.archived_at,
        r.created_at,
        (SELECT COUNT(1) FROM leads l WHERE l.restaurant_id = r.id AND l.deleted_at IS NULL) AS total_leads,
        (SELECT COUNT(1) FROM leads l WHERE l.restaurant_id = r.id AND l.deleted_at IS NULL AND l.opt_out_at IS NULL) AS active_leads,
        (SELECT COUNT(1) FROM promotions p WHERE p.restaurant_id = r.id) AS promotions_count
      FROM restaurants r
      ORDER BY r.is_archived ASC, r.created_at DESC`
    )
    .all();

  const noticeByType = {
    created: "Bar creado correctamente",
    archived: "Bar archivado",
    reactivated: "Bar reactivado",
  };
  const success = noticeByType[String(req.query.ok || "")] || "";

  const rows = restaurants
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.slug)}</td>
        <td>${row.is_archived ? "Archivado" : "Activo"}</td>
        <td>${row.total_leads}</td>
        <td>${row.active_leads}</td>
        <td>${row.promotions_count}</td>
        <td>
          <div class="row-actions">
            <a href="/app/restaurants/${encodeURIComponent(row.slug)}">Abrir</a>
            ${
              row.is_archived
                ? `<form method="post" action="/app/restaurants/${encodeURIComponent(
                    row.slug
                  )}/reactivate"><button class="btn-inline" type="submit">Reactivar</button></form>`
                : `<form method="post" action="/app/restaurants/${encodeURIComponent(
                    row.slug
                  )}/archive"><button class="btn-inline btn-warn" type="submit">Archivar</button></form>`
            }
          </div>
        </td>
      </tr>
    `
    )
    .join("");

  return res.send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Dashboard</title>
        <style>
          body { margin: 0; font-family: Arial, sans-serif; background: #f1f5f9; color: #0f172a; }
          header { background: #0b1324; color: #fff; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
          main { max-width: 1100px; margin: 24px auto; padding: 0 16px 40px; }
          .card { background: #fff; border-radius: 12px; padding: 18px; box-shadow: 0 10px 22px rgba(15, 23, 42, 0.08); margin-bottom: 16px; }
          h1, h2 { margin: 0 0 12px; }
          .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
          @media (min-width: 900px) { .grid { grid-template-columns: 1fr 2fr; } }
          input, button { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #cbd5e1; }
          button { background: #0f172a; color: #fff; border: none; font-weight: 700; cursor: pointer; margin-top: 10px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 0.95rem; }
          .ok { color: #166534; font-weight: 700; }
          .logout { background: #fff; color: #0b1324; border-radius: 8px; padding: 8px 10px; border: none; cursor: pointer; font-weight: 700; }
          .row-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
          .row-actions form { margin: 0; }
          .btn-inline { width: auto; margin: 0; padding: 6px 10px; font-size: .82rem; border-radius: 999px; background: #0f172a; }
          .btn-warn { background: #9a3412; }
        </style>
      </head>
      <body>
        <header>
          <div><strong>Plataforma WhatsApp</strong> | ${escapeHtml(req.operator.email)}</div>
          <form method="post" action="/logout">
            <button class="logout" type="submit">Salir</button>
          </form>
        </header>
        <main>
          <section class="grid">
            <article class="card">
              <h2>Alta de nuevo bar</h2>
              <form method="post" action="/app/restaurants">
                <label>Nombre del local</label>
                <input name="name" placeholder="Ej: Bar Sol" required />
                <label>Slug (URL corta)</label>
                <input name="slug" placeholder="Ej: bar-sol" required />
                <button type="submit">Crear bar</button>
              </form>
              <p style="font-size:.9rem;color:#475569;">Cada bar queda separado por slug y datos.</p>
              <div class="ok">${escapeHtml(success)}</div>
            </article>

            <article class="card">
              <h2>Bares registrados (${restaurants.length})</h2>
              <table>
                <thead>
                  <tr>
                    <th>Bar</th>
                    <th>Slug</th>
                    <th>Estado</th>
                    <th>Leads</th>
                    <th>Activos</th>
                    <th>Promos</th>
                    <th>Accion</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || '<tr><td colspan="7">Sin bares aun.</td></tr>'}
                </tbody>
              </table>
            </article>
          </section>
        </main>
      </body>
    </html>
  `);
});

app.post("/app/restaurants", requireAppAuth, (req, res) => {
  const name = String(req.body.name || "").trim();
  const slug = normalizeSlug(req.body.slug);

  if (!name || !slug) {
    return res.status(400).send("Nombre y slug son obligatorios");
  }

  const existing = getRestaurantBySlugAny(slug);
  if (existing) {
    return res.status(409).send("Ese slug ya existe");
  }

  db.prepare(
    `INSERT INTO restaurants (
      name, slug, avg_ticket_eur, gross_margin_pct, promo_conversion_pct, whatsapp_cost_eur
    ) VALUES (?, ?, 20, 70, 8, 0.08)`
  ).run(name, slug);
  return res.redirect("/app?ok=created");
});

app.post("/app/restaurants/:slug/archive", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurante no encontrado");
  }

  db.prepare(
    "UPDATE restaurants SET is_archived = 1, archived_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(restaurant.id);

  return res.redirect("/app?ok=archived");
});

app.post("/app/restaurants/:slug/reactivate", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurante no encontrado");
  }

  db.prepare("UPDATE restaurants SET is_archived = 0, archived_at = NULL WHERE id = ?").run(
    restaurant.id
  );

  return res.redirect("/app?ok=reactivated");
});

app.get("/app/restaurants/:slug", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurante no encontrado");
  }
  const isArchived = Boolean(restaurant.is_archived);
  const metricSettings = {
    avgTicketEur: asNumber(restaurant.avg_ticket_eur, 20),
    grossMarginPct: asNumber(restaurant.gross_margin_pct, 70),
    promoConversionPct: asNumber(restaurant.promo_conversion_pct, 8),
    whatsappCostEur: asNumber(restaurant.whatsapp_cost_eur, 0.08),
  };

  const stats = db
    .prepare(
      `SELECT
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = @restaurantId AND deleted_at IS NULL) AS total_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = @restaurantId AND deleted_at IS NULL AND opt_out_at IS NULL) AS active_leads,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = @restaurantId AND deleted_at IS NULL AND redeemed_at IS NOT NULL) AS redeemed_leads`
    )
    .get({ restaurantId: restaurant.id });

  const activity30d = db
    .prepare(
      `SELECT
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = @restaurantId AND deleted_at IS NULL AND created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS new_leads_30d,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = @restaurantId AND deleted_at IS NULL AND redeemed_at IS NOT NULL AND redeemed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS redeemed_30d,
        (SELECT COUNT(1) FROM leads WHERE restaurant_id = @restaurantId AND deleted_at IS NULL AND opt_out_at IS NOT NULL AND opt_out_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS optouts_30d,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = @restaurantId
           AND d.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS sent_30d,
        (SELECT COALESCE(SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END), 0)
         FROM promotion_deliveries d
         JOIN promotions p ON p.id = d.promotion_id
         WHERE p.restaurant_id = @restaurantId
           AND d.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS failed_30d`
    )
    .get({ restaurantId: restaurant.id });

  const promotions = db
    .prepare(
      `SELECT
        p.id,
        p.title,
        p.message,
        p.max_messages,
        p.offer_cost_eur,
        p.sent_at,
        p.created_at,
        COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0) AS sent_count,
        COALESCE(SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count
      FROM promotions p
      LEFT JOIN promotion_deliveries d ON d.promotion_id = p.id
      WHERE p.restaurant_id = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 20`
    )
    .all(restaurant.id);

  const schedules = db
    .prepare(
      `SELECT
        id, name, title, message, day_of_week, hour, minute,
        max_messages, offer_cost_eur, is_active, next_run_at, last_run_at
       FROM promotion_schedules
       WHERE restaurant_id = ?
       ORDER BY is_active DESC, next_run_at ASC`
    )
    .all(restaurant.id);

  const staffTokens = db
    .prepare(
      `SELECT id, label, created_at, last_used_at
       FROM restaurant_staff_tokens
       WHERE restaurant_id = ?
         AND revoked_at IS NULL
       ORDER BY created_at DESC`
    )
    .all(restaurant.id);

  const welcomeTemplate = restaurant.welcome_template || DEFAULT_WELCOME_TEMPLATE;
  const promotionTemplate = restaurant.promotion_template || DEFAULT_PROMOTION_TEMPLATE;
  const defaultReward = restaurant.default_reward || "un detalle de bienvenida";

  let totalEstimatedNet30d = 0;
  let totalEstimatedCost30d = 0;
  let totalEstimatedRevenue30d = 0;

  const promoRows = promotions
    .map((promotion) => {
      const finance = estimatePromotionFinance({
        sentCount: promotion.sent_count,
        offerCostEur: promotion.offer_cost_eur,
        avgTicketEur: metricSettings.avgTicketEur,
        grossMarginPct: metricSettings.grossMarginPct,
        promoConversionPct: metricSettings.promoConversionPct,
        whatsappCostEur: metricSettings.whatsappCostEur,
      });

      const createdAtTime = new Date(`${promotion.created_at}Z`).getTime();
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      if (Number.isFinite(createdAtTime) && createdAtTime >= thirtyDaysAgo) {
        totalEstimatedNet30d += finance.estimatedNet;
        totalEstimatedCost30d += finance.estimatedCampaignCost;
        totalEstimatedRevenue30d += finance.estimatedRevenue;
      }

      return `
        <tr>
          <td>#${promotion.id}</td>
          <td>${escapeHtml(promotion.title)}</td>
          <td>${escapeHtml(promotion.message)}</td>
          <td>${promotion.sent_count}/${promotion.max_messages}</td>
          <td>${promotion.failed_count}</td>
          <td>${formatEuro(promotion.offer_cost_eur || 0)}</td>
          <td>${formatEuro(finance.estimatedNet)}</td>
          <td>${finance.roiPct.toFixed(1)}%</td>
          <td>${promotion.sent_at ? escapeHtml(promotion.sent_at) : "Pendiente"}</td>
          <td>
            ${
              isArchived
                ? '<button type="button" disabled>Archivado</button>'
                : `<form method="post" action="/app/promotions/${promotion.id}/dispatch" style="margin:0;">
                    <input type="hidden" name="returnTo" value="/app/restaurants/${encodeURIComponent(
                      restaurant.slug
                    )}" />
                    <button type="submit">Enviar ahora</button>
                  </form>`
            }
          </td>
        </tr>
      `
    })
    .join("");

  const scheduleRows = schedules
    .map(
      (schedule) => `
        <tr>
          <td>${escapeHtml(schedule.name)}</td>
          <td>${formatDayTime(schedule.day_of_week, schedule.hour, schedule.minute)}</td>
          <td>${escapeHtml(schedule.next_run_at || "-")}</td>
          <td>${escapeHtml(schedule.last_run_at || "-")}</td>
          <td>${schedule.is_active ? "Activa" : "Pausada"}</td>
          <td>
            ${
              isArchived
                ? '<button type="button" disabled>Archivado</button>'
                : `<form method="post" action="/app/restaurants/${encodeURIComponent(
                    restaurant.slug
                  )}/schedules/${schedule.id}/toggle" style="margin:0;">
                    <button type="submit">${schedule.is_active ? "Pausar" : "Activar"}</button>
                  </form>
                  <form method="post" action="/app/restaurants/${encodeURIComponent(
                    restaurant.slug
                  )}/schedules/${schedule.id}/run-now" style="margin-top:6px;">
                    <button type="submit">Ejecutar ahora</button>
                  </form>`
            }
          </td>
        </tr>
      `
    )
    .join("");

  let notice = "";
  if (req.query.dispatch) {
    notice = `Envio ejecutado: ${escapeHtml(req.query.sent || "0")} enviados / ${escapeHtml(
      req.query.failed || "0"
    )} fallidos / ${escapeHtml(req.query.skipped || "0")} omitidos`;
  } else if (req.query.templates === "saved") {
    notice = "Plantillas guardadas.";
  } else if (req.query.metrics === "saved") {
    notice = "Ajustes de metricas guardados.";
  } else if (req.query.schedule === "created") {
    notice = "Programacion creada.";
  } else if (req.query.schedule === "toggled") {
    notice = "Programacion actualizada.";
  } else if (req.query.schedule === "ran") {
    notice = "Programacion ejecutada.";
  } else if (req.query.token === "revoked") {
    notice = "Token staff revocado.";
  } else if (req.query.leadDeleted === "1") {
    notice = "Cliente eliminado correctamente (supresion RGPD).";
  }
  const legalWarning =
    req.query.leadDeleted === "0" ? "No se encontro ese telefono en este bar." : "";
  const archivedNotice = isArchived
    ? "Este bar esta archivado. No permite nuevas altas ni envios hasta reactivarlo."
    : "";
  const newToken = req.query.newToken ? String(req.query.newToken) : "";
  const publicBaseUrl = `${req.protocol}://${req.get("host")}`;
  const qrUrl = `/r/${restaurant.slug}?reward=${encodeURIComponent(defaultReward)}&source=mesa`;
  const redemptionRate =
    stats.total_leads > 0 ? (stats.redeemed_leads / stats.total_leads) * 100 : 0;
  const deliveryAttempt30d = activity30d.sent_30d + activity30d.failed_30d;
  const deliverySuccessRate30d =
    deliveryAttempt30d > 0 ? (activity30d.sent_30d / deliveryAttempt30d) * 100 : 0;
  const optoutRate30d =
    activity30d.new_leads_30d > 0
      ? (activity30d.optouts_30d / activity30d.new_leads_30d) * 100
      : 0;

  const tokenRows = staffTokens
    .map(
      (token) => `
        <tr>
          <td>${escapeHtml(token.label)}</td>
          <td>${escapeHtml(token.created_at)}</td>
          <td>${token.last_used_at ? escapeHtml(token.last_used_at) : "Nunca"}</td>
          <td>
            <form method="post" action="/app/restaurants/${encodeURIComponent(
              restaurant.slug
            )}/staff-tokens/${token.id}/revoke" style="margin:0;">
              <button type="submit">Revocar</button>
            </form>
          </td>
        </tr>
      `
    )
    .join("");

  return res.send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(restaurant.name)} | Control</title>
        <style>
          body { margin: 0; font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; }
          main { max-width: 1180px; margin: 24px auto; padding: 0 16px 30px; }
          .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
          .head-actions { display: flex; gap: 10px; align-items: center; }
          .card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 10px 22px rgba(0,0,0,.08); margin-bottom: 14px; }
          .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
          .stat { background: linear-gradient(160deg, #eff6ff, #dbeafe); border-radius: 10px; padding: 12px; }
          .stat strong { font-size: 1.35rem; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border-bottom: 1px solid #e2e8f0; text-align: left; padding: 9px; vertical-align: top; }
          input, textarea, select, button { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #cbd5e1; }
          button { margin-top: 8px; border: none; background: #0f172a; color: #fff; font-weight: 700; cursor: pointer; }
          .layout { display: grid; gap: 14px; grid-template-columns: 1fr; }
          @media (min-width: 980px) { .layout { grid-template-columns: 1fr 1.7fr; } }
          .ok { color: #166534; font-weight: 700; min-height: 20px; }
          .warn { color: #9a3412; font-weight: 700; min-height: 20px; }
          .linkbox { font-family: monospace; background: #f1f5f9; border-radius: 8px; padding: 8px; word-break: break-all; }
          .status-pill { border-radius: 999px; padding: 6px 10px; font-size: .85rem; font-weight: 700; }
          .status-pill.active { background: #dcfce7; color: #166534; }
          .status-pill.archived { background: #fee2e2; color: #991b1b; }
          .btn-outline { width: auto; border: 1px solid #cbd5e1; background: #fff; color: #0f172a; margin: 0; }
          .btn-outline.warn { color: #9a3412; border-color: #fdba74; }
          .subcard { margin-top: 18px; padding-top: 14px; border-top: 1px solid #e2e8f0; }
          .hint { color: #475569; font-size: .88rem; margin-top: 6px; }
          .token-box { margin-top: 8px; font-family: monospace; background: #ecfccb; color: #365314; border-radius: 8px; padding: 8px; word-break: break-all; }
        </style>
      </head>
      <body>
        <main>
          <div class="head">
            <h1>${escapeHtml(restaurant.name)} <small style="font-weight:400;color:#64748b;">(${escapeHtml(
              restaurant.slug
            )})</small></h1>
            <div class="head-actions">
              <span class="status-pill ${isArchived ? "archived" : "active"}">
                ${isArchived ? "Archivado" : "Activo"}
              </span>
              ${
                isArchived
                  ? `<form method="post" action="/app/restaurants/${encodeURIComponent(
                      restaurant.slug
                    )}/reactivate"><button class="btn-outline" type="submit">Reactivar bar</button></form>`
                  : `<form method="post" action="/app/restaurants/${encodeURIComponent(
                      restaurant.slug
                    )}/archive"><button class="btn-outline warn" type="submit">Archivar bar</button></form>`
              }
              <a href="/app">Volver al dashboard</a>
            </div>
          </div>

          <section class="card stats">
            <article class="stat">
              <div>Leads totales</div>
              <strong>${stats.total_leads}</strong>
            </article>
            <article class="stat">
              <div>Leads activos</div>
              <strong>${stats.active_leads}</strong>
            </article>
            <article class="stat">
              <div>Canjes confirmados</div>
              <strong>${stats.redeemed_leads}</strong>
            </article>
            <article class="stat">
              <div>Conversion total</div>
              <strong>${redemptionRate.toFixed(1)}%</strong>
            </article>
            <article class="stat">
              <div>Entregas 30 dias</div>
              <strong>${activity30d.sent_30d}</strong>
            </article>
            <article class="stat">
              <div>Exito entrega 30 dias</div>
              <strong>${deliverySuccessRate30d.toFixed(1)}%</strong>
            </article>
            <article class="stat">
              <div>Neto estimado 30 dias</div>
              <strong>${formatEuro(totalEstimatedNet30d)}</strong>
            </article>
            <article class="stat">
              <div>Coste estimado 30 dias</div>
              <strong>${formatEuro(totalEstimatedCost30d)}</strong>
            </article>
            <article class="stat">
              <div>Ingresos estimados 30 dias</div>
              <strong>${formatEuro(totalEstimatedRevenue30d)}</strong>
            </article>
            <article class="stat">
              <div>Bajas 30 dias</div>
              <strong>${optoutRate30d.toFixed(1)}%</strong>
            </article>
          </section>

          <section class="layout">
            <article class="card">
              <h2>Nueva promocion</h2>
              <div class="warn">${escapeHtml(archivedNotice)}</div>
              <form method="post" action="/app/restaurants/${encodeURIComponent(
                restaurant.slug
              )}/promotions">
                <label>Titulo</label>
                <input name="title" required placeholder="Ej: Happy hour express" ${
                  isArchived ? "disabled" : ""
                } />
                <label>Mensaje</label>
                <textarea name="message" rows="4" required placeholder="Ej: Hoy 2x1 en bebidas de 17:00 a 19:00" ${
                  isArchived ? "disabled" : ""
                }></textarea>
                <label>Valido desde (opcional)</label>
                <input name="validFrom" placeholder="2026-02-13 17:00" ${
                  isArchived ? "disabled" : ""
                } />
                <label>Valido hasta (opcional)</label>
                <input name="validTo" placeholder="2026-02-13 19:00" ${
                  isArchived ? "disabled" : ""
                } />
                <label>Maximo de mensajes</label>
                <input name="maxMessages" type="number" min="1" value="100" ${
                  isArchived ? "disabled" : ""
                } />
                <label>Coste oferta (EUR)</label>
                <input name="offerCostEur" type="number" min="0" step="0.01" value="0" ${
                  isArchived ? "disabled" : ""
                } />
                <button type="submit" ${isArchived ? "disabled" : ""}>Crear promocion</button>
              </form>

              <section class="subcard">
                <h3>Plantillas del bar</h3>
                <form method="post" action="/app/restaurants/${encodeURIComponent(
                  restaurant.slug
                )}/templates">
                  <label>Regalo por defecto (para URL QR)</label>
                  <input name="defaultReward" value="${escapeHtml(defaultReward)}" ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Mensaje bienvenida WhatsApp</label>
                  <textarea name="welcomeTemplate" rows="5" ${
                    isArchived ? "disabled" : ""
                  }>${escapeHtml(welcomeTemplate)}</textarea>
                  <label>Plantilla promociones WhatsApp</label>
                  <textarea name="promotionTemplate" rows="4" ${
                    isArchived ? "disabled" : ""
                  }>${escapeHtml(promotionTemplate)}</textarea>
                  <div class="hint">Variables: {restaurant_name}, {reward_label}, {claim_code}, {message}, {validity_line}</div>
                  <button type="submit" ${isArchived ? "disabled" : ""}>Guardar plantillas</button>
                </form>
              </section>

              <section class="subcard">
                <h3>Tokens staff de este bar</h3>
                <form method="post" action="/app/restaurants/${encodeURIComponent(
                  restaurant.slug
                )}/staff-tokens">
                  <label>Etiqueta del token</label>
                  <input name="label" placeholder="Ej: iPad barra" required ${
                    isArchived ? "disabled" : ""
                  } />
                  <button type="submit" ${isArchived ? "disabled" : ""}>Crear token staff</button>
                </form>
                ${
                  newToken
                    ? `<div class="token-box"><strong>Token nuevo (guardalo ahora):</strong><br/>${escapeHtml(
                        newToken
                      )}</div>`
                    : ""
                }
                <table style="margin-top:10px;">
                  <thead>
                    <tr><th>Etiqueta</th><th>Creado</th><th>Ultimo uso</th><th>Accion</th></tr>
                  </thead>
                  <tbody>
                    ${tokenRows || '<tr><td colspan="4">Sin tokens creados.</td></tr>'}
                  </tbody>
                </table>
              </section>

              <section class="subcard">
                <h3>Ajustes de negocio (ROI estimado)</h3>
                <form method="post" action="/app/restaurants/${encodeURIComponent(
                  restaurant.slug
                )}/metrics-settings">
                  <label>Ticket medio (EUR)</label>
                  <input name="avgTicketEur" type="number" min="0" step="0.01" value="${metricSettings.avgTicketEur.toFixed(
                    2
                  )}" ${isArchived ? "disabled" : ""} />
                  <label>Margen bruto (%)</label>
                  <input name="grossMarginPct" type="number" min="0" max="100" step="0.1" value="${metricSettings.grossMarginPct.toFixed(
                    1
                  )}" ${isArchived ? "disabled" : ""} />
                  <label>Conversion promo esperada (%)</label>
                  <input name="promoConversionPct" type="number" min="0" max="100" step="0.1" value="${metricSettings.promoConversionPct.toFixed(
                    1
                  )}" ${isArchived ? "disabled" : ""} />
                  <label>Coste WhatsApp por mensaje (EUR)</label>
                  <input name="whatsappCostEur" type="number" min="0" step="0.001" value="${metricSettings.whatsappCostEur.toFixed(
                    3
                  )}" ${isArchived ? "disabled" : ""} />
                  <div class="hint">Estas cifras alimentan el ROI estimado de cada promocion.</div>
                  <button type="submit" ${isArchived ? "disabled" : ""}>Guardar ajustes</button>
                </form>
              </section>

              <section class="subcard">
                <h3>Cumplimiento legal</h3>
                <div class="hint">
                  Version consentimiento activa: <strong>${escapeHtml(
                    CONSENT_VERSION
                  )}</strong>.
                  Politica: <a href="${escapeHtml(PRIVACY_URL)}" target="_blank" rel="noopener">${escapeHtml(
                    PRIVACY_URL
                  )}</a>
                </div>
                <div class="warn">${escapeHtml(legalWarning)}</div>
                <form method="post" action="/app/restaurants/${encodeURIComponent(
                  restaurant.slug
                )}/leads/delete">
                  <label>Telefono a suprimir (E.164)</label>
                  <input name="phone" type="tel" placeholder="+34600111222" ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Motivo (auditoria interna)</label>
                  <input name="reason" placeholder="Solicitud titular RGPD" ${
                    isArchived ? "disabled" : ""
                  } />
                  <button type="submit" ${isArchived ? "disabled" : ""}>Eliminar datos del cliente</button>
                </form>
              </section>

              <section class="subcard">
                <h3>Programacion automatica semanal</h3>
                <form method="post" action="/app/restaurants/${encodeURIComponent(
                  restaurant.slug
                )}/schedules">
                  <label>Nombre interno</label>
                  <input name="name" placeholder="Ej: Hora valle martes" required ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Titulo promocion</label>
                  <input name="title" placeholder="Ej: Martes sin cola" required ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Mensaje promocion</label>
                  <textarea name="message" rows="3" required ${
                    isArchived ? "disabled" : ""
                  }></textarea>
                  <label>Valido desde (opcional)</label>
                  <input name="validFrom" placeholder="2026-02-13 17:00" ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Valido hasta (opcional)</label>
                  <input name="validTo" placeholder="2026-02-13 19:00" ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Dia de semana</label>
                  <select name="dayOfWeek" ${isArchived ? "disabled" : ""}>
                    <option value="0">Domingo</option>
                    <option value="1">Lunes</option>
                    <option value="2">Martes</option>
                    <option value="3">Miercoles</option>
                    <option value="4">Jueves</option>
                    <option value="5">Viernes</option>
                    <option value="6">Sabado</option>
                  </select>
                  <label>Hora</label>
                  <input name="hour" type="number" min="0" max="23" value="17" ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Minuto</label>
                  <input name="minute" type="number" min="0" max="59" value="0" ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Maximo mensajes</label>
                  <input name="maxMessages" type="number" min="1" value="100" ${
                    isArchived ? "disabled" : ""
                  } />
                  <label>Coste oferta (EUR)</label>
                  <input name="offerCostEur" type="number" min="0" step="0.01" value="0" ${
                    isArchived ? "disabled" : ""
                  } />
                  <button type="submit" ${isArchived ? "disabled" : ""}>Crear programacion</button>
                </form>

                <table style="margin-top:10px;">
                  <thead>
                    <tr>
                      <th>Nombre</th><th>Cuando</th><th>Proxima</th><th>Ultima</th><th>Estado</th><th>Accion</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${scheduleRows || '<tr><td colspan="6">Sin programaciones.</td></tr>'}
                  </tbody>
                </table>
              </section>

              <h3 style="margin-top:22px;">Enlaces del bar</h3>
              <p style="margin-bottom:6px;">Landing QR:</p>
              <div class="linkbox">${escapeHtml(publicBaseUrl)}${escapeHtml(qrUrl)}</div>
              <p style="margin-bottom:6px; margin-top:14px;">Panel staff legado:</p>
              <div class="linkbox">${escapeHtml(publicBaseUrl)}/staff/${escapeHtml(
                restaurant.slug
              )}</div>
            </article>

            <article class="card">
              <h2>Promociones recientes</h2>
              <div class="ok">${escapeHtml(notice)}</div>
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Titulo</th>
                    <th>Mensaje</th>
                    <th>Enviados</th>
                    <th>Fallidos</th>
                    <th>Coste oferta</th>
                    <th>Neto estimado</th>
                    <th>ROI est.</th>
                    <th>Ultimo envio</th>
                    <th>Accion</th>
                  </tr>
                </thead>
                <tbody>
                  ${promoRows || '<tr><td colspan="10">No hay promociones.</td></tr>'}
                </tbody>
              </table>
            </article>
          </section>
        </main>
      </body>
    </html>
  `);
});

app.post("/app/restaurants/:slug/promotions", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes crear promociones en un bar archivado");
  }

  const created = createPromotion({
    restaurantId: restaurant.id,
    title: req.body.title,
    message: req.body.message,
    validFrom: req.body.validFrom,
    validTo: req.body.validTo,
    maxMessages: req.body.maxMessages,
    offerCostEur: req.body.offerCostEur,
  });

  if (created.error) {
    return res.status(400).send(created.error);
  }

  return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}`);
});

app.post("/app/restaurants/:slug/templates", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes modificar un bar archivado");
  }

  const defaultReward = String(req.body.defaultReward || "").trim();
  const welcomeTemplate = String(req.body.welcomeTemplate || "").trim();
  const promotionTemplate = String(req.body.promotionTemplate || "").trim();

  db.prepare(
    `UPDATE restaurants
     SET default_reward = ?, welcome_template = ?, promotion_template = ?
     WHERE id = ?`
  ).run(
    defaultReward || null,
    welcomeTemplate || null,
    promotionTemplate || null,
    restaurant.id
  );

  return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}?templates=saved`);
});

app.post("/app/restaurants/:slug/metrics-settings", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes modificar un bar archivado");
  }

  const avgTicketEur = Math.max(0, asNumber(req.body.avgTicketEur, 20));
  const grossMarginPct = Math.max(0, Math.min(100, asNumber(req.body.grossMarginPct, 70)));
  const promoConversionPct = Math.max(
    0,
    Math.min(100, asNumber(req.body.promoConversionPct, 8))
  );
  const whatsappCostEur = Math.max(0, asNumber(req.body.whatsappCostEur, 0.08));

  db.prepare(
    `UPDATE restaurants
     SET avg_ticket_eur = ?,
         gross_margin_pct = ?,
         promo_conversion_pct = ?,
         whatsapp_cost_eur = ?
     WHERE id = ?`
  ).run(avgTicketEur, grossMarginPct, promoConversionPct, whatsappCostEur, restaurant.id);

  return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}?metrics=saved`);
});

app.post("/app/restaurants/:slug/leads/delete", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes modificar un bar archivado");
  }

  const normalizedPhone = normalizePhone(req.body.phone, DEFAULT_COUNTRY_CODE);
  if (!normalizedPhone) {
    return res.status(400).send("Telefono invalido");
  }
  const reason = String(req.body.reason || "Solicitud titular RGPD")
    .trim()
    .slice(0, 255);

  const lead = db
    .prepare(
      "SELECT id FROM leads WHERE restaurant_id = ? AND phone_e164 = ? AND deleted_at IS NULL"
    )
    .get(restaurant.id, normalizedPhone);

  if (!lead) {
    return res.redirect(
      `/app/restaurants/${encodeURIComponent(restaurant.slug)}?leadDeleted=0`
    );
  }

  const deleteLeadTx = db.transaction((leadId, deleteReason) => {
    db.prepare("DELETE FROM promotion_deliveries WHERE lead_id = ?").run(leadId);
    db.prepare(
      "UPDATE leads SET deleted_at = CURRENT_TIMESTAMP, deleted_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(deleteReason, leadId);
    db.prepare(
      "UPDATE leads SET phone_e164 = ?, source_qr = NULL, reward_label = NULL, claim_code = NULL, claim_code_sent_at = NULL, claim_code_redeemed_at = NULL, consent_ip = NULL, consent_user_agent = NULL WHERE id = ?"
    ).run(`deleted_${leadId}_${Date.now()}`, leadId);
  });

  deleteLeadTx(lead.id, reason || "Solicitud titular RGPD");

  logger.warn("lead.deleted", {
    restaurantSlug: restaurant.slug,
    leadId: lead.id,
    reason,
    actorEmail: req.operator?.email || null,
  });

  return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}?leadDeleted=1`);
});

app.post("/app/restaurants/:slug/schedules", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes crear programaciones en un bar archivado");
  }

  const name = String(req.body.name || "").trim();
  const title = String(req.body.title || "").trim();
  const message = String(req.body.message || "").trim();
  const dayOfWeek = Math.max(0, Math.min(6, Math.trunc(asNumber(req.body.dayOfWeek, 0))));
  const hour = Math.max(0, Math.min(23, Math.trunc(asNumber(req.body.hour, 17))));
  const minute = Math.max(0, Math.min(59, Math.trunc(asNumber(req.body.minute, 0))));
  const maxMessages = Math.max(1, Math.trunc(asNumber(req.body.maxMessages, 100)));
  const offerCostEur = Math.max(0, asNumber(req.body.offerCostEur, 0));

  if (!name || !title || !message) {
    return res.status(400).send("name, title y message son obligatorios");
  }

  const nextRunAt = toSqlDatetime(computeNextRunAt(dayOfWeek, hour, minute, new Date()));

  db.prepare(
    `INSERT INTO promotion_schedules (
      restaurant_id, name, title, message, valid_from, valid_to,
      max_messages, offer_cost_eur, day_of_week, hour, minute, next_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    restaurant.id,
    name,
    title,
    message,
    req.body.validFrom || null,
    req.body.validTo || null,
    maxMessages,
    offerCostEur,
    dayOfWeek,
    hour,
    minute,
    nextRunAt
  );

  return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}?schedule=created`);
});

app.post("/app/restaurants/:slug/schedules/:scheduleId/toggle", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes modificar un bar archivado");
  }

  const scheduleId = Number(req.params.scheduleId);
  if (!Number.isInteger(scheduleId) || scheduleId < 1) {
    return res.status(400).send("Programacion invalida");
  }

  const schedule = db
    .prepare(
      "SELECT id, is_active, day_of_week, hour, minute FROM promotion_schedules WHERE id = ? AND restaurant_id = ?"
    )
    .get(scheduleId, restaurant.id);

  if (!schedule) {
    return res.status(404).send("Programacion no encontrada");
  }

  const nextIsActive = schedule.is_active ? 0 : 1;
  const nextRunAt = toSqlDatetime(
    computeNextRunAt(schedule.day_of_week, schedule.hour, schedule.minute, new Date())
  );

  db.prepare(
    `UPDATE promotion_schedules
     SET is_active = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(nextIsActive, nextRunAt, schedule.id);

  return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}?schedule=toggled`);
});

app.post("/app/restaurants/:slug/schedules/:scheduleId/run-now", requireAppAuth, async (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes ejecutar una programacion de un bar archivado");
  }

  const scheduleId = Number(req.params.scheduleId);
  if (!Number.isInteger(scheduleId) || scheduleId < 1) {
    return res.status(400).send("Programacion invalida");
  }

  const schedule = db
    .prepare(
      `SELECT
        id, title, message, valid_from, valid_to, max_messages, offer_cost_eur,
        day_of_week, hour, minute
       FROM promotion_schedules
       WHERE id = ? AND restaurant_id = ?`
    )
    .get(scheduleId, restaurant.id);

  if (!schedule) {
    return res.status(404).send("Programacion no encontrada");
  }

  const created = createPromotion({
    restaurantId: restaurant.id,
    title: schedule.title,
    message: schedule.message,
    validFrom: schedule.valid_from,
    validTo: schedule.valid_to,
    maxMessages: schedule.max_messages,
    offerCostEur: schedule.offer_cost_eur,
  });
  if (created.error) {
    return res.status(400).send(created.error);
  }

  await dispatchPromotion({
    promotionId: created.promotion.id,
    messageCooldownHours: MESSAGE_COOLDOWN_HOURS,
    weeklyMessageLimit: WEEKLY_MESSAGE_LIMIT,
  });

  const nextRunAt = toSqlDatetime(
    computeNextRunAt(schedule.day_of_week, schedule.hour, schedule.minute, new Date())
  );
  db.prepare(
    `UPDATE promotion_schedules
     SET last_run_at = CURRENT_TIMESTAMP, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(nextRunAt, schedule.id);

  return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}?schedule=ran`);
});

app.post("/app/restaurants/:slug/staff-tokens", requireAppAuth, (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  if (restaurant.is_archived) {
    return res.status(409).send("No puedes crear tokens en un bar archivado");
  }

  const label = String(req.body.label || "").trim();
  if (!label) {
    return res.status(400).send("Etiqueta de token obligatoria");
  }

  let rawToken = null;
  let created = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    rawToken = generateStaffToken();
    const tokenHash = hashStaffToken(rawToken);
    try {
      db.prepare(
        "INSERT INTO restaurant_staff_tokens (restaurant_id, label, token_hash) VALUES (?, ?, ?)"
      ).run(restaurant.id, label, tokenHash);
      created = true;
      break;
    } catch (error) {
      if (error.code !== "23505") {
        return res.status(500).send(error.message || "No se pudo crear token");
      }
    }
  }

  if (!created || !rawToken) {
    return res.status(500).send("No se pudo crear token");
  }

  return res.redirect(
    appendQuery(`/app/restaurants/${encodeURIComponent(restaurant.slug)}`, { newToken: rawToken })
  );
});

app.post(
  "/app/restaurants/:slug/staff-tokens/:tokenId/revoke",
  requireAppAuth,
  (req, res) => {
    const restaurant = getRestaurantBySlugAny(req.params.slug);
    if (!restaurant) {
      return res.status(404).send("Restaurant not found");
    }

    const tokenId = Number(req.params.tokenId);
    if (!Number.isInteger(tokenId) || tokenId < 1) {
      return res.status(400).send("Token invalido");
    }

    const result = db
      .prepare(
        `UPDATE restaurant_staff_tokens
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND restaurant_id = ?
           AND revoked_at IS NULL`
      )
      .run(tokenId, restaurant.id);

    if (result.changes === 0) {
      return res.status(404).send("Token no encontrado");
    }

    return res.redirect(`/app/restaurants/${encodeURIComponent(restaurant.slug)}?token=revoked`);
  }
);

app.post("/app/promotions/:promotionId/dispatch", requireAppAuth, async (req, res) => {
  const promotionId = Number(req.params.promotionId);
  const returnTo = safeReturnTo(req.body.returnTo);

  if (!Number.isInteger(promotionId) || promotionId < 1) {
    return res.status(400).send("Invalid promotion id");
  }

  const result = await dispatchPromotion({
    promotionId,
    messageCooldownHours: MESSAGE_COOLDOWN_HOURS,
    weeklyMessageLimit: WEEKLY_MESSAGE_LIMIT,
  });

  if (result.notFound) {
    return res.status(404).send("Promotion not found");
  }
  if (result.archivedRestaurant) {
    return res.status(409).send("No puedes enviar promociones de un bar archivado");
  }
  if (result.inProgress) {
    return res.status(409).send("Esta promocion ya se esta enviando");
  }

  return res.redirect(
    appendQuery(returnTo, {
      dispatch: 1,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
      eligible: result.eligible,
    })
  );
});

app.get("/r/:slug", (req, res) => {
  const restaurant = getRestaurantBySlug(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurante no encontrado");
  }

  const reward = req.query.reward || restaurant.default_reward || "un detalle de bienvenida";
  const sourceQr = req.query.source || "mesa";

  return res.send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(restaurant.name)} | Promociones WhatsApp</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; background: #f7f6f1; color: #1f1f1f; }
          .wrap { max-width: 520px; margin: 40px auto; padding: 20px; }
          .card { background: white; border-radius: 12px; padding: 22px; box-shadow: 0 10px 22px rgba(0,0,0,.08); }
          h1 { margin-top: 0; font-size: 1.4rem; }
          p { line-height: 1.45; }
          input, button { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 8px; border: 1px solid #ccc; }
          button { margin-top: 14px; border: none; background: #111; color: white; cursor: pointer; font-weight: 600; }
          label { display: block; margin-top: 12px; font-size: .95rem; }
          small { color: #555; display: block; margin-top: 12px; }
          .ok { margin-top: 14px; color: #0a7a35; font-weight: 600; }
          .err { margin-top: 14px; color: #b10000; font-weight: 600; }
        </style>
      </head>
      <body>
        <main class="wrap">
          <section class="card">
            <h1>${escapeHtml(restaurant.name)}</h1>
            <p>Escanea y deja tu WhatsApp para recibir <strong>${escapeHtml(
              reward
            )}</strong> y promociones puntuales.</p>
            <form id="leadForm">
              <input type="hidden" name="slug" value="${escapeHtml(restaurant.slug)}" />
              <input type="hidden" name="sourceQr" value="${escapeHtml(sourceQr)}" />
              <input type="hidden" name="rewardLabel" value="${escapeHtml(reward)}" />
              <label for="phone">Tu WhatsApp</label>
              <input id="phone" name="phone" type="tel" placeholder="+34 600 000 000" required />
              <label>
                <input type="checkbox" name="consent" required />
                Acepto recibir promociones ocasionales por WhatsApp (${escapeHtml(
                  CONSENT_VERSION
                )}).
              </label>
              <button type="submit">Quiero mi regalo</button>
            </form>
            <div id="response"></div>
            <small>
              Podras darte de baja respondiendo BAJA/STOP cuando recibas un mensaje.
              Consulta la <a href="${escapeHtml(PRIVACY_URL)}" target="_blank" rel="noopener">politica de privacidad</a>.
            </small>
          </section>
        </main>
        <script>
          const form = document.getElementById("leadForm");
          const responseEl = document.getElementById("response");
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            responseEl.className = "";
            responseEl.textContent = "Enviando...";
            const body = Object.fromEntries(new FormData(form).entries());
            try {
              const response = await fetch("/api/public/leads", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
              const payload = await response.json();
              if (!response.ok) {
                responseEl.className = "err";
                responseEl.textContent = payload.error || "No se pudo registrar.";
                return;
              }
              responseEl.className = "ok";
              if (payload.confirmationSent) {
                responseEl.textContent =
                  "Perfecto. Te hemos enviado por WhatsApp tu codigo para canjear el regalo.";
              } else {
                responseEl.textContent =
                  "Registro completado. Si no te llega WhatsApp, ensena este codigo al camarero: " +
                  payload.claimCode;
              }
              form.reset();
            } catch {
              responseEl.className = "err";
              responseEl.textContent = "Error de red.";
            }
          });
        </script>
      </body>
    </html>
  `);
});

app.post("/api/public/leads", async (req, res) => {
  const { slug, phone, sourceQr, rewardLabel, consent } = req.body;
  const restaurant = getRestaurantBySlug(slug);
  if (!restaurant) {
    return res.status(404).json({ error: "Restaurant not found" });
  }

  if (!isTruthy(consent)) {
    return res.status(400).json({ error: "Consent is required" });
  }

  const normalizedPhone = normalizePhone(phone, DEFAULT_COUNTRY_CODE);
  if (!normalizedPhone) {
    return res.status(400).json({ error: "Invalid WhatsApp number" });
  }

  const upsertLead = db.prepare(`
    INSERT INTO leads (
      restaurant_id, phone_e164, source_qr, reward_label,
      consent_version, consent_text, consent_ip, consent_user_agent,
      claim_code, claim_code_sent_at, claim_code_redeemed_at,
      consent_at, redeemed_at, updated_at
    )
    VALUES (
      @restaurantId, @phone, @sourceQr, @rewardLabel,
      @consentVersion, @consentText, @consentIp, @consentUserAgent,
      @claimCode, NULL, NULL,
      CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
    )
    ON CONFLICT(restaurant_id, phone_e164) DO UPDATE SET
      source_qr = excluded.source_qr,
      reward_label = excluded.reward_label,
      consent_version = excluded.consent_version,
      consent_text = excluded.consent_text,
      consent_ip = excluded.consent_ip,
      consent_user_agent = excluded.consent_user_agent,
      claim_code = excluded.claim_code,
      claim_code_sent_at = NULL,
      claim_code_redeemed_at = NULL,
      consent_at = CURRENT_TIMESTAMP,
      redeemed_at = NULL,
      opt_out_at = NULL,
      deleted_at = NULL,
      deleted_reason = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const claimCode = generateUniqueClaimCode(restaurant.id);
      upsertLead.run({
        restaurantId: restaurant.id,
        phone: normalizedPhone,
        sourceQr: sourceQr || "mesa",
        rewardLabel: rewardLabel || "detalle",
        consentVersion: CONSENT_VERSION,
        consentText: CONSENT_TEXT,
        consentIp: getClientIp(req),
        consentUserAgent: String(req.get("user-agent") || "").slice(0, 512),
        claimCode,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (error.code !== "23505") {
        break;
      }
    }
  }

  if (lastError) {
    return res
      .status(500)
      .json({ error: lastError.message || "Could not register lead with claim code" });
  }

  const lead = db
    .prepare(
      "SELECT id, phone_e164, claim_code, created_at FROM leads WHERE restaurant_id = ? AND phone_e164 = ? AND deleted_at IS NULL"
    )
    .get(restaurant.id, normalizedPhone);
  let confirmationSent = false;
  let confirmationError = null;

  if (WELCOME_CONFIRMATION_ENABLED) {
    const cleanRewardLabel = String(
      rewardLabel || restaurant.default_reward || "tu detalle de bienvenida"
    ).trim();
    const template = restaurant.welcome_template || DEFAULT_WELCOME_TEMPLATE;
    const confirmationBody = renderTemplate(template, {
      restaurant_name: restaurant.name,
      reward_label: cleanRewardLabel,
      claim_code: lead.claim_code,
      phone_e164: lead.phone_e164,
    });

    try {
      await sendWhatsAppMessage({
        to: normalizedPhone,
        body: confirmationBody,
      });
      db.prepare(
        "UPDATE leads SET claim_code_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(lead.id);
      confirmationSent = true;
    } catch (error) {
      confirmationError = error.message || "Failed to send confirmation";
    }
  }

  return res.status(201).json({
    lead,
    claimCode: lead.claim_code,
    confirmationSent,
    confirmationError,
  });
});

app.post("/api/public/optout", (req, res) => {
  const { slug, phone } = req.body;
  const restaurant = getRestaurantBySlugAny(slug);
  if (!restaurant) {
    return res.status(404).json({ error: "Restaurant not found" });
  }

  const normalizedPhone = normalizePhone(phone, DEFAULT_COUNTRY_CODE);
  if (!normalizedPhone) {
    return res.status(400).json({ error: "Invalid WhatsApp number" });
  }

  const result = db
    .prepare(
      "UPDATE leads SET opt_out_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE restaurant_id = ? AND phone_e164 = ? AND deleted_at IS NULL"
    )
    .run(restaurant.id, normalizedPhone);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Lead not found" });
  }

  return res.json({ ok: true });
});

function applyInboundOptCommand({ restaurantId = null, phoneE164, bodyText }) {
  if (!phoneE164) {
    return { ok: false, code: "invalid_phone" };
  }
  const cleanBody = String(bodyText || "").trim();
  const isStop = isStopCommand(cleanBody);
  const isStart = isStartCommand(cleanBody);
  if (!isStop && !isStart) {
    return { ok: true, ignored: true };
  }

  const filters = ["phone_e164 = ?", "deleted_at IS NULL"];
  const params = [phoneE164];
  if (restaurantId) {
    filters.push("restaurant_id = ?");
    params.push(restaurantId);
  }
  const whereClause = filters.join(" AND ");

  if (isStop) {
    const result = db
      .prepare(
        `UPDATE leads
         SET opt_out_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE ${whereClause}`
      )
      .run(...params);
    return { ok: true, action: "optout", affected: result.changes };
  }

  const result = db
    .prepare(
      `UPDATE leads
       SET opt_out_at = NULL,
           consent_at = CURRENT_TIMESTAMP,
           consent_version = ?,
           consent_text = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE ${whereClause}`
    )
    .run(CONSENT_VERSION, "Reactivado por mensaje START/ALTA", ...params);
  return { ok: true, action: "optin", affected: result.changes };
}

function handleTwilioInboundWebhook(req, res, targetRestaurant) {
  if (!validateTwilioSignature(req)) {
    logger.warn("twilio.webhook.invalid_signature", {
      path: req.originalUrl,
      ip: getClientIp(req),
    });
    return res.status(403).send("Forbidden");
  }

  const fromRaw = String(req.body.From || "").replace(/^whatsapp:/i, "");
  const bodyText = String(req.body.Body || "");
  const phoneE164 = normalizePhone(fromRaw, DEFAULT_COUNTRY_CODE);
  const restaurantId = targetRestaurant ? targetRestaurant.id : null;
  const result = applyInboundOptCommand({ restaurantId, phoneE164, bodyText });

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
        ? "Has sido dado de baja correctamente. No recibirás más promociones."
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

app.post("/webhooks/twilio/whatsapp/inbound", (req, res) => {
  return handleTwilioInboundWebhook(req, res, null);
});

app.post("/webhooks/twilio/whatsapp/:slug/inbound", (req, res) => {
  const restaurant = getRestaurantBySlugAny(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurant not found");
  }
  return handleTwilioInboundWebhook(req, res, restaurant);
});

app.get("/staff/:slug", (req, res) => {
  const restaurant = getRestaurantBySlug(req.params.slug);
  if (!restaurant) {
    return res.status(404).send("Restaurante no encontrado");
  }

  return res.send(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Staff | ${escapeHtml(restaurant.name)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; background: #f4f4f6; color: #111; }
          .wrap { max-width: 780px; margin: 30px auto; padding: 0 16px; }
          .grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
          @media (min-width: 860px) { .grid { grid-template-columns: 1fr 1fr; } }
          .card { background: white; border-radius: 12px; padding: 18px; box-shadow: 0 8px 20px rgba(0,0,0,.06); }
          h1 { margin: 0 0 16px; }
          input, textarea, button { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 10px; border-radius: 8px; border: 1px solid #c9c9c9; }
          button { border: none; background: #111; color: #fff; font-weight: 700; cursor: pointer; margin-top: 12px; }
          .result { margin-top: 12px; font-size: .92rem; }
        </style>
      </head>
      <body>
        <main class="wrap">
          <h1>Panel staff: ${escapeHtml(restaurant.name)}</h1>
          <div class="grid">
            <section class="card">
              <h2>Canjear regalo</h2>
              <input id="redeemToken" type="password" placeholder="Token staff del bar" />
              <input id="redeemCode" type="text" placeholder="Codigo WhatsApp (ej: 482193)" />
              <button id="redeemCodeBtn">Canjear por codigo</button>
              <div style="margin-top: 10px; font-size: .9rem; color: #555;">o por telefono:</div>
              <input id="redeemPhone" type="tel" placeholder="+34 600 000 000" />
              <button id="redeemBtn">Marcar canje</button>
              <div id="redeemResult" class="result"></div>
            </section>
            <section class="card">
              <h2>Crear promocion</h2>
              <input id="promoToken" type="password" placeholder="Token staff del bar" />
              <input id="promoTitle" type="text" placeholder="Ej: Happy hour express" />
              <textarea id="promoMessage" rows="4" placeholder="Ej: Hoy 2x1 en bebidas de 17:00 a 19:00"></textarea>
              <input id="promoValidFrom" type="text" placeholder="2026-02-13 17:00" />
              <input id="promoValidTo" type="text" placeholder="2026-02-13 19:00" />
              <input id="promoMax" type="number" min="1" value="100" />
              <input id="promoOfferCost" type="number" min="0" step="0.01" value="0" />
              <button id="promoBtn">Crear promocion</button>
              <div id="promoResult" class="result"></div>
            </section>
          </div>
        </main>
        <script>
          const slug = ${JSON.stringify(restaurant.slug)};

          function renderRedeemResult(payload) {
            if (payload.redeemedNow) {
              return "Canje confirmado.";
            }
            return "Este cliente ya habia canjeado su regalo.";
          }

          document.getElementById("redeemBtn").addEventListener("click", async () => {
            const result = document.getElementById("redeemResult");
            result.textContent = "Procesando...";
            const token = document.getElementById("redeemToken").value;
            const phone = document.getElementById("redeemPhone").value;
            const response = await fetch("/api/staff/redeem", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-staff-token": token },
              body: JSON.stringify({ slug, phone }),
            });
            const payload = await response.json();
            if (!response.ok) {
              result.textContent = payload.error || "Error";
              return;
            }
            result.textContent = renderRedeemResult(payload);
          });

          document.getElementById("redeemCodeBtn").addEventListener("click", async () => {
            const result = document.getElementById("redeemResult");
            result.textContent = "Procesando...";
            const token = document.getElementById("redeemToken").value;
            const code = document.getElementById("redeemCode").value;
            const response = await fetch("/api/staff/redeem", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-staff-token": token },
              body: JSON.stringify({ slug, code }),
            });
            const payload = await response.json();
            if (!response.ok) {
              result.textContent = payload.error || "Error";
              return;
            }
            result.textContent = renderRedeemResult(payload);
          });

          document.getElementById("promoBtn").addEventListener("click", async () => {
            const result = document.getElementById("promoResult");
            result.textContent = "Creando...";
            const token = document.getElementById("promoToken").value;
            const title = document.getElementById("promoTitle").value;
            const message = document.getElementById("promoMessage").value;
            const validFrom = document.getElementById("promoValidFrom").value;
            const validTo = document.getElementById("promoValidTo").value;
            const maxMessages = Number(document.getElementById("promoMax").value || 100);
            const offerCostEur = Number(document.getElementById("promoOfferCost").value || 0);
            const response = await fetch("/api/staff/promotions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-staff-token": token },
              body: JSON.stringify({
                slug,
                title,
                message,
                validFrom,
                validTo,
                maxMessages,
                offerCostEur,
              }),
            });
            const payload = await response.json();
            if (!response.ok) {
              result.textContent = payload.error || "Error";
              return;
            }
            result.textContent = "Promocion creada. ID: " + payload.promotion.id;
          });
        </script>
      </body>
    </html>
  `);
});

app.post("/api/staff/redeem", (req, res) => {
  const { slug, phone, code } = req.body;
  const restaurant = getRestaurantBySlug(slug);
  if (!restaurant) {
    return res.status(404).json({ error: "Restaurant not found" });
  }
  const providedToken = req.get("x-staff-token");
  if (!authenticateStaffTokenForRestaurant(restaurant.id, providedToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cleanCode = String(code || "").trim();
  let lead;

  if (cleanCode) {
    lead = db
      .prepare(
        "SELECT id, redeemed_at, phone_e164 FROM leads WHERE restaurant_id = ? AND claim_code = ? AND deleted_at IS NULL"
      )
      .get(restaurant.id, cleanCode);
    if (!lead) {
      return res.status(404).json({ error: "Claim code not found" });
    }
  } else {
    const normalizedPhone = normalizePhone(phone, DEFAULT_COUNTRY_CODE);
    if (!normalizedPhone) {
      return res.status(400).json({ error: "Invalid WhatsApp number" });
    }

    lead = db
      .prepare(
        "SELECT id, redeemed_at, phone_e164 FROM leads WHERE restaurant_id = ? AND phone_e164 = ? AND deleted_at IS NULL"
      )
      .get(restaurant.id, normalizedPhone);

    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }
  }

  if (lead.redeemed_at) {
    return res.json({ ok: true, redeemedNow: false, redeemedAt: lead.redeemed_at });
  }

  db.prepare(
    `UPDATE leads
     SET redeemed_at = CURRENT_TIMESTAMP,
         claim_code_redeemed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(lead.id);

  return res.json({ ok: true, redeemedNow: true });
});

app.post(
  "/api/staff/promotions",
  (req, res) => {
    const { slug } = req.body;
    const restaurant = getRestaurantBySlug(slug);
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found" });
    }
    const providedToken = req.get("x-staff-token");
    if (!authenticateStaffTokenForRestaurant(restaurant.id, providedToken)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const created = createPromotion({
      restaurantId: restaurant.id,
      title: req.body.title,
      message: req.body.message,
      validFrom: req.body.validFrom,
      validTo: req.body.validTo,
      maxMessages: req.body.maxMessages,
      offerCostEur: req.body.offerCostEur,
    });

    if (created.error) {
      return res.status(400).json({ error: created.error });
    }

    return res.status(201).json({ promotion: created.promotion });
  }
);

app.post(
  "/api/jobs/dispatch/:promotionId",
  requireToken("x-job-token", JOB_TOKEN),
  async (req, res) => {
    const promotionId = Number(req.params.promotionId);
    if (!Number.isInteger(promotionId) || promotionId < 1) {
      return res.status(400).json({ error: "Invalid promotion id" });
    }

    const result = await dispatchPromotion({
      promotionId,
      messageCooldownHours: MESSAGE_COOLDOWN_HOURS,
      weeklyMessageLimit: WEEKLY_MESSAGE_LIMIT,
    });

    if (result.notFound) {
      return res.status(404).json({ error: "Promotion not found" });
    }
    if (result.archivedRestaurant) {
      return res.status(409).json({ error: "Restaurant is archived" });
    }
    if (result.inProgress) {
      return res.status(409).json({ error: "Promotion dispatch already in progress" });
    }

    return res.json(result);
  }
);

app.post("/api/app/promotions/:promotionId/dispatch", requireAppAuth, async (req, res) => {
  const promotionId = Number(req.params.promotionId);
  if (!Number.isInteger(promotionId) || promotionId < 1) {
    return res.status(400).json({ error: "Invalid promotion id" });
  }

  const result = await dispatchPromotion({
    promotionId,
    messageCooldownHours: MESSAGE_COOLDOWN_HOURS,
    weeklyMessageLimit: WEEKLY_MESSAGE_LIMIT,
  });

  if (result.notFound) {
    return res.status(404).json({ error: "Promotion not found" });
  }
  if (result.archivedRestaurant) {
    return res.status(409).json({ error: "Restaurant is archived" });
  }
  if (result.inProgress) {
    return res.status(409).json({ error: "Promotion dispatch already in progress" });
  }

  return res.json(result);
});

app.use((error, req, res, _next) => {
  logger.error(
    "http.unhandled_error",
    {
      method: req.method,
      path: req.originalUrl,
      ip: getClientIp(req),
      message: error.message,
    },
    error
  );
  res.status(500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled_rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  logger.error("process.uncaught_exception", { message: error.message }, error);
});

app.listen(PORT, () => {
  logger.info("server.started", {
    port: PORT,
    nodeEnv: NODE_ENV,
    schedulerEnabled: SCHEDULER_ENABLED,
    backupEnabled: BACKUP_ENABLED,
  });
  // Keep startup line visible for manual local testing.
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});
