const { Pool } = require("pg");
const env = require("../config/env");

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function many(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

async function tx(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scoped = {
      query(text, params = []) {
        return client.query(text, params);
      },
      async one(text, params = []) {
        const result = await client.query(text, params);
        return result.rows[0] || null;
      },
      async many(text, params = []) {
        const result = await client.query(text, params);
        return result.rows;
      },
    };
    const result = await work(scoped);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function healthcheck() {
  await query("SELECT 1");
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  one,
  many,
  tx,
  healthcheck,
  close,
};
