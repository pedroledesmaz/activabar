const express = require("express");
const { requireAuth } = require("../../middleware/require-auth");
const {
  listRestaurants,
  getRestaurantBySlug,
  createRestaurant,
} = require("./service");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (_req, res, next) => {
  try {
    const restaurants = await listRestaurants();
    res.json({ ok: true, restaurants });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const restaurant = await createRestaurant(req.body || {});
    res.status(201).json({ ok: true, restaurant });
  } catch (error) {
    next(error);
  }
});

router.get("/:slug", async (req, res, next) => {
  try {
    const restaurant = await getRestaurantBySlug(req.params.slug);
    if (!restaurant) {
      return res.status(404).json({ error: "Restaurant not found." });
    }

    return res.json({ ok: true, restaurant });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
