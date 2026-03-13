const path = require("path");
const { MessageChannel, Worker, receiveMessageOnPort } = require("worker_threads");

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run with PostgreSQL.");
}

const workerPath = path.join(__dirname, "db-worker.js");
const worker = new Worker(workerPath, {
  env: {
    ...process.env,
    DATABASE_URL,
  },
});
worker.unref();

const { port1, port2 } = new MessageChannel();
worker.postMessage({ type: "attach-port", port: port2 }, [port2]);
port1.unref();

let requestId = 0;
const transactionStack = [];

function receiveWorkerMessage(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const packet = receiveMessageOnPort(port1);
    if (packet) return packet.message;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error("Timed out waiting for PostgreSQL worker response.");
}

function callWorker(message, timeoutMs = 30000) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const id = ++requestId;

  worker.postMessage({
    ...message,
    id,
    signal: signal.buffer,
  });

  const waitResult = Atomics.wait(signal, 0, 0, timeoutMs);
  if (waitResult === "timed-out") {
    throw new Error("Timed out waiting for PostgreSQL worker.");
  }

  const response = receiveWorkerMessage(timeoutMs);
  if (!response || response.id !== id) {
    throw new Error("Invalid response from PostgreSQL worker.");
  }

  if (!response.ok) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    error.detail = response.error.detail;
    error.constraint = response.error.constraint;
    throw error;
  }

  return response.result;
}

function normalizeArgs(args) {
  if (args.length === 0) return null;
  if (args.length === 1) return args[0];
  return args;
}

function prepare(sql) {
  return {
    get(...args) {
      return callWorker({
        type: "query",
        mode: "get",
        sql,
        params: normalizeArgs(args),
        transactionId: transactionStack[transactionStack.length - 1] || null,
      });
    },
    all(...args) {
      return callWorker({
        type: "query",
        mode: "all",
        sql,
        params: normalizeArgs(args),
        transactionId: transactionStack[transactionStack.length - 1] || null,
      });
    },
    run(...args) {
      return callWorker({
        type: "query",
        mode: "run",
        sql,
        params: normalizeArgs(args),
        transactionId: transactionStack[transactionStack.length - 1] || null,
      });
    },
  };
}

function exec(sql) {
  return callWorker({
    type: "exec",
    sql,
    transactionId: transactionStack[transactionStack.length - 1] || null,
  });
}

function transaction(fn) {
  return (...args) => {
    const transactionId = `tx_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    callWorker({
      type: "begin-transaction",
      transactionId,
    });

    try {
      transactionStack.push(transactionId);
      const result = fn(...args);
      transactionStack.pop();
      callWorker({
        type: "commit-transaction",
        transactionId,
      });
      return result;
    } catch (error) {
      if (transactionStack[transactionStack.length - 1] === transactionId) {
        transactionStack.pop();
      }
      try {
        callWorker({
          type: "rollback-transaction",
          transactionId,
        });
      } catch (_rollbackError) {
        // Ignore rollback failures and rethrow the original error.
      }
      throw error;
    }
  };
}

function initDb() {
  return callWorker({
    type: "init-db",
  });
}

const db = { prepare, exec, transaction };

module.exports = { db, initDb };
