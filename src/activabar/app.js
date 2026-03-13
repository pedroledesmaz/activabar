const express = require("express");
const logger = require("./lib/logger");
const { requestContext } = require("./middleware/request-context");
const appRoutes = require("./modules/app/routes");
const healthRoutes = require("./modules/health/routes");
const authRoutes = require("./modules/auth/routes");
const restaurantRoutes = require("./modules/restaurants/routes");
const twilioWebhookRoutes = require("./modules/webhooks/twilio");

function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(requestContext);

  app.use("/", appRoutes);

  app.use("/health", healthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/restaurants", restaurantRoutes);
  app.use("/webhooks", twilioWebhookRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: "Route not found." });
  });

  app.use((error, req, res, _next) => {
    logger.error(
      "http.unhandled_error",
      {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
      },
      error
    );

    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Internal server error.",
      requestId: req.requestId,
    });
  });

  return app;
}

module.exports = { createApp };
