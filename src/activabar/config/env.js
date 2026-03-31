require("dotenv").config();

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "on";
}

function getRequired(name, fallback) {
  const value = String(process.env[name] || fallback || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
  appName: String(
    process.env.ACTIVABAR_APP_NAME || process.env.APP_NAME || "activabar"
  ).trim(),
  nodeEnv: String(process.env.NODE_ENV || "development").trim(),
  port: parseInteger(process.env.ACTIVABAR_PORT || process.env.PORT, 3000),
  databaseUrl: getRequired("DATABASE_URL"),
  databaseSsl: parseBoolean(process.env.DATABASE_SSL, false),
  sessionCookieName: String(
    process.env.ACTIVABAR_SESSION_COOKIE_NAME || "activabar_session"
  ).trim(),
  sessionTtlDays: parseInteger(process.env.SESSION_TTL_DAYS, 30),
  defaultCountryCode: String(
    process.env.ACTIVABAR_DEFAULT_COUNTRY_CODE ||
      process.env.DEFAULT_COUNTRY_CODE ||
      "+34"
  ).trim(),
  messageCooldownHours: parseInteger(process.env.MESSAGE_COOLDOWN_HOURS, 72),
  weeklyMessageLimit: parseInteger(process.env.WEEKLY_MESSAGE_LIMIT, 2),
  welcomeConfirmationEnabled: parseBoolean(
    process.env.WELCOME_CONFIRMATION_ENABLED,
    true
  ),
  welcomeCodeLength: Math.min(
    10,
    Math.max(4, parseInteger(process.env.WELCOME_CODE_LENGTH, 6))
  ),
  twilioWebhookValidateSignature: parseBoolean(
    process.env.TWILIO_WEBHOOK_VALIDATE_SIGNATURE,
    false
  ),
  smtpHost: String(process.env.SMTP_HOST || "").trim(),
  smtpPort: parseInteger(process.env.SMTP_PORT, 0),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE, false),
  smtpUser: String(process.env.SMTP_USER || "").trim(),
  smtpPass: String(process.env.SMTP_PASS || "").trim(),
  smtpFrom: String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim(),
  demoNotificationTo: String(process.env.DEMO_NOTIFICATION_TO || "").trim(),
  logFile: String(
    process.env.ACTIVABAR_LOG_FILE || "./data/logs/activabar.log"
  ).trim(),
  bootstrapAdminEmail: String(process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
  bootstrapAdminPassword: String(process.env.ADMIN_PASSWORD || "").trim(),
};

module.exports = env;
