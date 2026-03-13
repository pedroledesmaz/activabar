const env = require("../../config/env");
const db = require("../../lib/db");
const logger = require("../../lib/logger");
const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
} = require("../../../auth");

function buildCookie(token) {
  const maxAgeSeconds = Math.max(1, env.sessionTtlDays * 24 * 60 * 60);
  const parts = [
    `${env.sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (env.nodeEnv === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function buildClearedCookie() {
  const parts = [
    `${env.sessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];

  if (env.nodeEnv === "production") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

async function findOperatorByEmail(email) {
  return db.one(
    `SELECT id, email, password_hash, role, is_active
     FROM operators
     WHERE email = $1`,
    [String(email || "").trim().toLowerCase()]
  );
}

async function findActiveSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  return db.one(
    `SELECT
        sessions.id,
        sessions.operator_id,
        sessions.expires_at,
        operators.email,
        operators.role,
        operators.is_active
     FROM sessions
     JOIN operators ON operators.id = sessions.operator_id
     WHERE sessions.token_hash = $1
       AND sessions.revoked_at IS NULL
       AND sessions.expires_at > CURRENT_TIMESTAMP
       AND operators.is_active = 1`,
    [tokenHash]
  );
}

async function login(email, password) {
  const operator = await findOperatorByEmail(email);
  if (!operator || operator.is_active !== 1) {
    return null;
  }

  if (!verifyPassword(password, operator.password_hash)) {
    return null;
  }

  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  await db.query(
    `INSERT INTO sessions (operator_id, token_hash, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + ($3 * INTERVAL '1 day'))`,
    [operator.id, tokenHash, env.sessionTtlDays]
  );

  return {
    token,
    operator: {
      id: operator.id,
      email: operator.email,
      role: operator.role,
    },
  };
}

async function logout(token) {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  await db.query(
    `UPDATE sessions
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE token_hash = $1
       AND revoked_at IS NULL`,
    [tokenHash]
  );
}

async function upsertAdmin(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const passwordHash = hashPassword(password);
  const existing = await db.one(
    "SELECT id, email FROM operators WHERE email = $1",
    [normalizedEmail]
  );

  if (existing) {
    await db.query(
      "UPDATE operators SET password_hash = $1, is_active = 1 WHERE id = $2",
      [passwordHash, existing.id]
    );
    return { created: false, email: existing.email };
  }

  const inserted = await db.one(
    `INSERT INTO operators (email, password_hash, role, is_active)
     VALUES ($1, $2, 'admin', 1)
     RETURNING email`,
    [normalizedEmail, passwordHash]
  );
  return { created: true, email: inserted.email };
}

async function bootstrapAdmin() {
  if (env.bootstrapAdminEmail && env.bootstrapAdminPassword) {
    const result = await upsertAdmin(
      env.bootstrapAdminEmail,
      env.bootstrapAdminPassword
    );
    logger.info("auth.bootstrap_admin", result);
    return;
  }

  if (env.nodeEnv === "production") {
    logger.warn("auth.bootstrap_admin.skipped", {
      reason: "ADMIN_EMAIL or ADMIN_PASSWORD not configured",
    });
    return;
  }

  const result = await upsertAdmin("admin@local.test", "admin12345");
  logger.warn("auth.bootstrap_admin.local_default", result);
}

module.exports = {
  buildCookie,
  buildClearedCookie,
  findActiveSessionByToken,
  login,
  logout,
  upsertAdmin,
  bootstrapAdmin,
};
