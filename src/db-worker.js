const fs = require("fs");
const path = require("path");
const { parentPort } = require("worker_threads");
const { Pool, types } = require("pg");

types.setTypeParser(20, (value) => Number(value));

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DATABASE_SSL = String(process.env.DATABASE_SSL || "").trim().toLowerCase();
const useSsl =
  DATABASE_SSL === "true" ||
  DATABASE_SSL === "1" ||
  DATABASE_SSL === "require" ||
  DATABASE_SSL === "on";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

const transactionClients = new Map();
let responsePort = null;

function sendResponse(signalBuffer, payload) {
  const signal = new Int32Array(signalBuffer);
  responsePort.postMessage(payload);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

function serializeError(error) {
  return {
    message: error.message || "Unknown database error",
    code: error.code || null,
    detail: error.detail || null,
    constraint: error.constraint || null,
  };
}

function translateSql(sql, params) {
  const text = String(sql || "");
  const namedValues = [];
  const positionalValues = Array.isArray(params) ? params : [];
  const namedParams =
    params && typeof params === "object" && !Array.isArray(params) ? params : null;
  let positionalIndex = 0;
  const namedIndexes = new Map();

  const translated = text.replace(/\?|@([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, namedKey) => {
    if (match === "?") {
      namedValues.push(positionalValues[positionalIndex]);
      positionalIndex += 1;
      return `$${namedValues.length}`;
    }

    if (!namedParams) {
      throw new Error(`Missing named params for placeholder @${namedKey}`);
    }

    if (!namedIndexes.has(namedKey)) {
      namedValues.push(namedParams[namedKey]);
      namedIndexes.set(namedKey, namedValues.length);
    }

    return `$${namedIndexes.get(namedKey)}`;
  });

  return {
    sql: translated,
    values: namedValues,
  };
}

function isInsertStatement(sql) {
  return /^\s*insert\b/i.test(sql);
}

function hasReturningClause(sql) {
  return /\breturning\b/i.test(sql);
}

function withReturningId(sql) {
  if (!isInsertStatement(sql) || hasReturningClause(sql)) {
    return sql;
  }
  return `${sql.trim()} RETURNING id`;
}

async function getClient(transactionId) {
  if (!transactionId) return pool;
  const client = transactionClients.get(transactionId);
  if (!client) {
    throw new Error(`Unknown transaction: ${transactionId}`);
  }
  return client;
}

async function executeQuery({ sql, params, mode, transactionId }) {
  const client = await getClient(transactionId);
  const sourceSql = mode === "run" ? withReturningId(sql) : sql;
  const translated = translateSql(sourceSql, params);
  const result = await client.query(translated.sql, translated.values);

  if (mode === "get") {
    return result.rows[0];
  }

  if (mode === "all") {
    return result.rows;
  }

  return {
    changes: result.rowCount,
    lastInsertRowid:
      result.rows && result.rows[0] && Object.prototype.hasOwnProperty.call(result.rows[0], "id")
        ? result.rows[0].id
        : null,
  };
}

async function initDb() {
  const schemaPath = path.join(__dirname, "..", "migrations", "postgres_schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);
}

async function beginTransaction(transactionId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    transactionClients.set(transactionId, client);
  } catch (error) {
    client.release();
    throw error;
  }
}

async function finishTransaction(transactionId, action) {
  const client = transactionClients.get(transactionId);
  if (!client) {
    throw new Error(`Unknown transaction: ${transactionId}`);
  }

  try {
    await client.query(action);
  } finally {
    transactionClients.delete(transactionId);
    client.release();
  }
}

parentPort.on("message", async (message) => {
  if (message.type === "attach-port") {
    responsePort = message.port;
    return;
  }

  if (!responsePort) {
    throw new Error("Database worker response port not initialized.");
  }

  const { id, signal } = message;

  try {
    let result;

    if (message.type === "query") {
      result = await executeQuery(message);
    } else if (message.type === "exec") {
      const client = await getClient(message.transactionId);
      result = await client.query(String(message.sql || ""));
    } else if (message.type === "init-db") {
      result = await initDb();
    } else if (message.type === "begin-transaction") {
      result = await beginTransaction(message.transactionId);
    } else if (message.type === "commit-transaction") {
      result = await finishTransaction(message.transactionId, "COMMIT");
    } else if (message.type === "rollback-transaction") {
      result = await finishTransaction(message.transactionId, "ROLLBACK");
    } else {
      throw new Error(`Unsupported database worker message: ${message.type}`);
    }

    sendResponse(signal, {
      id,
      ok: true,
      result,
    });
  } catch (error) {
    sendResponse(signal, {
      id,
      ok: false,
      error: serializeError(error),
    });
  }
});
