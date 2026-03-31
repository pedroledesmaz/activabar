const db = require("../../lib/db");

async function createDemoRequest({
  name,
  businessName,
  email,
  phone,
  city,
  locationsCount,
  message,
  source = "landing",
}) {
  return db.one(
    `INSERT INTO demo_requests (
       name,
       business_name,
       email,
       phone,
       city,
       locations_count,
       message,
       source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      name,
      businessName,
      email,
      phone,
      city || null,
      Number.isFinite(locationsCount) ? locationsCount : null,
      message || null,
      source,
    ]
  );
}

module.exports = {
  createDemoRequest,
};
