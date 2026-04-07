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

async function getAccessibleRestaurantIds(operatorId) {
  const rows = await db.many(
    `SELECT restaurant_id
     FROM operator_restaurant_access
     WHERE operator_id = $1
     ORDER BY restaurant_id ASC`,
    [operatorId]
  );
  return rows.map((row) => Number(row.restaurant_id));
}

async function findActiveSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  const session = await db.one(
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
  if (!session) return null;

  const restaurantIds =
    session.role === "admin"
      ? []
      : await getAccessibleRestaurantIds(session.operator_id);

  return {
    ...session,
    restaurant_ids: restaurantIds,
  };
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

  const restaurantIds =
    operator.role === "admin" ? [] : await getAccessibleRestaurantIds(operator.id);

  return {
    token,
    operator: {
      id: operator.id,
      email: operator.email,
      role: operator.role,
      restaurantIds,
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

function canManageAllRestaurants(operator) {
  return operator?.role === "admin";
}

function canAccessRestaurant(operator, restaurantId) {
  if (!operator) return false;
  if (canManageAllRestaurants(operator)) return true;
  return Array.isArray(operator.restaurant_ids)
    ? operator.restaurant_ids.includes(Number(restaurantId))
    : Array.isArray(operator.restaurantIds)
      ? operator.restaurantIds.includes(Number(restaurantId))
      : false;
}

async function listRestaurantManagers(restaurantId) {
  return db.many(
    `SELECT
        operators.id,
        operators.email,
        operators.role,
        operators.is_active,
        operator_restaurant_access.created_at
     FROM operator_restaurant_access
     JOIN operators ON operators.id = operator_restaurant_access.operator_id
     WHERE operator_restaurant_access.restaurant_id = $1
     ORDER BY operators.email ASC`,
    [restaurantId]
  );
}

async function listAdminOperators() {
  return db.many(
    `SELECT id, email, role, is_active, created_at
     FROM operators
     WHERE role = 'admin'
     ORDER BY created_at ASC, email ASC`
  );
}

async function createAdminOperator({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const cleanPassword = String(password || "");
  if (!normalizedEmail || !cleanPassword) {
    const error = new Error("Email y password son obligatorios.");
    error.statusCode = 400;
    throw error;
  }

  return db.tx(async (tx) => {
    const existing = await tx.one(
      `SELECT id, email, role
       FROM operators
       WHERE email = $1`,
      [normalizedEmail]
    );

    const passwordHash = hashPassword(cleanPassword);
    let operatorId;
    let created = false;
    let promoted = false;

    if (existing) {
      operatorId = existing.id;
      promoted = existing.role !== "admin";
      await tx.query(
        `UPDATE operators
         SET password_hash = $1,
             role = 'admin',
             is_active = 1
         WHERE id = $2`,
        [passwordHash, operatorId]
      );
    } else {
      const inserted = await tx.one(
        `INSERT INTO operators (email, password_hash, role, is_active)
         VALUES ($1, $2, 'admin', 1)
         RETURNING id`,
        [normalizedEmail, passwordHash]
      );
      operatorId = inserted.id;
      created = true;
    }

    await tx.query(
      `DELETE FROM operator_restaurant_access
       WHERE operator_id = $1`,
      [operatorId]
    );

    return {
      created,
      promoted,
      email: normalizedEmail,
      operatorId,
    };
  });
}

async function createRestaurantManager({ restaurantId, email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const cleanPassword = String(password || "");
  if (!normalizedEmail || !cleanPassword) {
    const error = new Error("Email y password son obligatorios.");
    error.statusCode = 400;
    throw error;
  }

  return db.tx(async (tx) => {
    const existing = await tx.one(
      `SELECT id, email, role
       FROM operators
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (existing && existing.role === "admin") {
      const error = new Error("Ese email ya pertenece a un admin global.");
      error.statusCode = 409;
      throw error;
    }

    const passwordHash = hashPassword(cleanPassword);
    let operatorId;
    let created = false;

    if (existing) {
      operatorId = existing.id;
      await tx.query(
        `UPDATE operators
         SET password_hash = $1,
             role = 'manager',
             is_active = 1
         WHERE id = $2`,
        [passwordHash, operatorId]
      );
    } else {
      const inserted = await tx.one(
        `INSERT INTO operators (email, password_hash, role, is_active)
         VALUES ($1, $2, 'manager', 1)
         RETURNING id`,
        [normalizedEmail, passwordHash]
      );
      operatorId = inserted.id;
      created = true;
    }

    await tx.query(
      `DELETE FROM operator_restaurant_access
       WHERE operator_id = $1`,
      [operatorId]
    );

    await tx.query(
      `INSERT INTO operator_restaurant_access (operator_id, restaurant_id)
       VALUES ($1, $2)
       ON CONFLICT (operator_id, restaurant_id) DO NOTHING`,
      [operatorId, restaurantId]
    );

    return {
      created,
      email: normalizedEmail,
      operatorId,
      restaurantId,
    };
  });
}

async function deleteRestaurantManager({ restaurantId, operatorId }) {
  const cleanRestaurantId = Number(restaurantId);
  const cleanOperatorId = Number(operatorId);
  if (!Number.isInteger(cleanRestaurantId) || !Number.isInteger(cleanOperatorId)) {
    const error = new Error("Manager no válido.");
    error.statusCode = 400;
    throw error;
  }

  return db.tx(async (tx) => {
    const existing = await tx.one(
      `SELECT operators.id, operators.email, operators.role
       FROM operator_restaurant_access
       JOIN operators ON operators.id = operator_restaurant_access.operator_id
       WHERE operator_restaurant_access.restaurant_id = $1
         AND operator_restaurant_access.operator_id = $2`,
      [cleanRestaurantId, cleanOperatorId]
    );

    if (!existing) {
      const error = new Error("Manager no encontrado en este bar.");
      error.statusCode = 404;
      throw error;
    }

    if (existing.role !== "manager") {
      const error = new Error("Solo se pueden borrar cuentas manager.");
      error.statusCode = 400;
      throw error;
    }

    await tx.query(
      `DELETE FROM operator_restaurant_access
       WHERE operator_id = $1`,
      [cleanOperatorId]
    );

    await tx.query(
      `UPDATE operators
       SET is_active = 0
       WHERE id = $1`,
      [cleanOperatorId]
    );

    await tx.query(
      `UPDATE sessions
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE operator_id = $1
         AND revoked_at IS NULL`,
      [cleanOperatorId]
    );

    return {
      email: existing.email,
      operatorId: cleanOperatorId,
    };
  });
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
  canManageAllRestaurants,
  canAccessRestaurant,
  listAdminOperators,
  createAdminOperator,
  listRestaurantManagers,
  createRestaurantManager,
  deleteRestaurantManager,
  bootstrapAdmin,
};
