const fs = require("fs");
const path = require("path");
const env = require("../config/env");

function ensureDirForFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });
  return absolutePath;
}

function write(level, event, data = {}, error = null) {
  const entry = {
    ts: new Date().toISOString(),
    app: env.appName,
    level,
    event,
    data,
    error: error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: error.code,
        }
      : null,
  };

  const line = `${JSON.stringify(entry)}\n`;
  process.stdout.write(line);

  try {
    fs.appendFileSync(ensureDirForFile(env.logFile), line, "utf8");
  } catch (_error) {
    // Keep stdout logging even if file logging fails.
  }
}

module.exports = {
  info(event, data) {
    write("info", event, data);
  },
  warn(event, data, error) {
    write("warn", event, data, error);
  },
  error(event, data, error) {
    write("error", event, data, error);
  },
};
