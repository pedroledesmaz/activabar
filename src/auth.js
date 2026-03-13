const crypto = require("crypto");

const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
};

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;

  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [rawKey, ...rawValue] = pair.trim().split("=");
    if (!rawKey) continue;
    out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join("=") || "");
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto
    .scryptSync(password, salt, 64, SCRYPT_PARAMS)
    .toString("hex");
  return `scrypt:${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith("scrypt:")) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 3) return false;

  const [, salt, digestHex] = parts;
  const digest = Buffer.from(digestHex, "hex");
  const candidate = crypto.scryptSync(password, salt, digest.length, SCRYPT_PARAMS);
  if (candidate.length !== digest.length) return false;
  return crypto.timingSafeEqual(candidate, digest);
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  parseCookies,
};

