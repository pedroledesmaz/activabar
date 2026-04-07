const env = require("./config/env");
const logger = require("./lib/logger");
const db = require("./lib/db");
const { applySchema } = require("./lib/schema");
const { createApp } = require("./app");
const { bootstrapAdmin } = require("./modules/auth/service");

async function start() {
  const skipSchema = String(process.env.ACTIVABAR_SKIP_SCHEMA || "").trim().toLowerCase() === "true";
  const skipBootstrap = String(process.env.ACTIVABAR_SKIP_BOOTSTRAP_ADMIN || "").trim().toLowerCase() === "true";

  if (!skipSchema) {
    await applySchema();
  } else {
    logger.warn("server.schema_skipped", { reason: "ACTIVABAR_SKIP_SCHEMA=true" });
  }

  if (!skipBootstrap) {
    await bootstrapAdmin();
  } else {
    logger.warn("server.bootstrap_skipped", { reason: "ACTIVABAR_SKIP_BOOTSTRAP_ADMIN=true" });
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info("server.started", {
      port: env.port,
      service: env.appName,
      nodeEnv: env.nodeEnv,
    });
  });

  async function shutdown(signal) {
    logger.info("server.stopping", { signal });
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      logger.error("server.stop_failed", { signal: "SIGINT" }, error);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      logger.error("server.stop_failed", { signal: "SIGTERM" }, error);
      process.exit(1);
    });
  });
}

start().catch((error) => {
  logger.error("server.start_failed", {}, error);
  process.exit(1);
});
