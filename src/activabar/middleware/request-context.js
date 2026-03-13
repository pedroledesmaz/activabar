const crypto = require("crypto");
const logger = require("../lib/logger");

function requestContext(req, res, next) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  req.requestId = requestId;

  res.on("finish", () => {
    logger.info("http.request", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
}

module.exports = { requestContext };
