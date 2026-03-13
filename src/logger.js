const fs = require("fs");
const path = require("path");

const LOG_FILE = process.env.LOG_FILE || "./data/logs/app.log";
const ALERT_WEBHOOK_URL = String(process.env.ALERT_WEBHOOK_URL || "").trim();
const APP_NAME = String(process.env.APP_NAME || "whatsapp-restaurant-mvp").trim();

const LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ALERT_MIN_LEVEL = String(process.env.ALERT_MIN_LEVEL || "error")
  .trim()
  .toLowerCase();

function ensureDirForFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return absolutePath;
}

function shouldAlert(level) {
  const target = LEVEL_ORDER[ALERT_MIN_LEVEL] || LEVEL_ORDER.error;
  const current = LEVEL_ORDER[level] || LEVEL_ORDER.info;
  return current >= target;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
  };
}

async function sendWebhookAlert(entry) {
  if (!ALERT_WEBHOOK_URL || !shouldAlert(entry.level)) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `[${entry.app}] ${entry.level.toUpperCase()} ${entry.event}`,
        app: entry.app,
        level: entry.level,
        event: entry.event,
        data: entry.data,
        ts: entry.ts,
      }),
    });
  } catch (_error) {
    // Do not throw from alerts to avoid breaking request flow.
  }
}

function writeLine(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  process.stdout.write(line);
  try {
    const file = ensureDirForFile(LOG_FILE);
    fs.appendFileSync(file, line, "utf8");
  } catch (_error) {
    // Ignore file logging failure; stdout still has the event.
  }
}

function log(level, event, data = {}, error = null) {
  const entry = {
    ts: new Date().toISOString(),
    app: APP_NAME,
    level,
    event,
    data,
    error: serializeError(error),
  };
  writeLine(entry);
  sendWebhookAlert(entry).catch(() => {});
}

function debug(event, data) {
  log("debug", event, data);
}

function info(event, data) {
  log("info", event, data);
}

function warn(event, data, error = null) {
  log("warn", event, data, error);
}

function error(event, data, err = null) {
  log("error", event, data, err);
}

module.exports = {
  debug,
  info,
  warn,
  error,
};
