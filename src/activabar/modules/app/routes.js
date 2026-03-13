const express = require("express");
const env = require("../../config/env");
const { parseCookies } = require("../../../auth");
const { appendSetCookie } = require("../../lib/http");
const { escapeHtml, renderPage } = require("../../lib/html");
const {
  buildCookie,
  buildClearedCookie,
  findActiveSessionByToken,
  login,
  logout,
} = require("../auth/service");
const { listRestaurants, createRestaurant } = require("../restaurants/service");

const router = express.Router();

function renderLoginPage(errorMessage = "") {
  const alert = errorMessage
    ? `<div class="banner error">${escapeHtml(errorMessage)}</div>`
    : "";

  return renderPage({
    title: "Activabar | Login",
    body: `
      <section class="card" style="max-width: 520px; margin: 80px auto;">
        <p class="muted">Activabar</p>
        <h1>Entrar al panel</h1>
        <p class="muted">Accede con el admin que configuraste en Render.</p>
        ${alert}
        <form method="post" action="/login" class="grid">
          <div>
            <label for="email">Email</label>
            <input id="email" name="email" type="email" required />
          </div>
          <div>
            <label for="password">Contrasena</label>
            <input id="password" name="password" type="password" required />
          </div>
          <button type="submit">Entrar</button>
        </form>
      </section>
    `,
  });
}

function renderAppPage({ operator, restaurants, errorMessage, successMessage }) {
  const errorBanner = errorMessage
    ? `<div class="banner error">${escapeHtml(errorMessage)}</div>`
    : "";
  const successBanner = successMessage
    ? `<div class="banner ok">${escapeHtml(successMessage)}</div>`
    : "";

  const restaurantItems = restaurants.length
    ? restaurants
        .map(
          (restaurant) => `
            <article class="restaurant">
              <h3>${escapeHtml(restaurant.name)}</h3>
              <p class="muted">Slug: <code>${escapeHtml(restaurant.slug)}</code></p>
              <p class="muted">Recompensa: ${escapeHtml(
                restaurant.default_reward || "Sin definir"
              )}</p>
            </article>
          `
        )
        .join("")
    : `<div class="restaurant"><p>Aun no hay restaurantes. Crea el primero con el formulario.</p></div>`;

  return renderPage({
    title: "Activabar | Panel",
    body: `
      <section class="card grid">
        <div class="toolbar">
          <div>
            <p class="muted">Panel</p>
            <h1>Activabar</h1>
            <p class="muted">Conectado como ${escapeHtml(operator.email)}</p>
          </div>
          <form method="post" action="/logout" class="inline">
            <button type="submit" class="secondary">Cerrar sesion</button>
          </form>
        </div>
        ${errorBanner}
        ${successBanner}
        <div class="grid-2">
          <section class="card">
            <p class="muted">Nuevo restaurante</p>
            <h2>Crear restaurante</h2>
            <form method="post" action="/app/restaurants" class="grid">
              <div>
                <label for="name">Nombre</label>
                <input id="name" name="name" required />
              </div>
              <div>
                <label for="slug">Slug</label>
                <input id="slug" name="slug" placeholder="se-autogenera-si-lo-dejas-vacio" />
              </div>
              <div>
                <label for="defaultReward">Recompensa inicial</label>
                <input id="defaultReward" name="defaultReward" placeholder="Cafe gratis o 2x1" />
              </div>
              <button type="submit">Crear restaurante</button>
            </form>
          </section>
          <section class="card">
            <p class="muted">Restaurantes</p>
            <h2>${restaurants.length}</h2>
            <p class="muted">Los locales creados apareceran aqui.</p>
          </section>
        </div>
        <section class="grid">
          ${restaurantItems}
        </section>
      </section>
    `,
  });
}

async function getWebSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[env.sessionCookieName];
  if (!token) return null;
  return findActiveSessionByToken(token);
}

async function requireWebAuth(req, res, next) {
  try {
    const session = await getWebSession(req);
    if (!session) {
      return res.redirect("/login");
    }
    req.auth = session;
    return next();
  } catch (error) {
    return next(error);
  }
}

router.get("/", async (req, res, next) => {
  try {
    const session = await getWebSession(req);
    if (session) {
      return res.redirect("/app");
    }
    return res.redirect("/login");
  } catch (error) {
    return next(error);
  }
});

router.get("/login", (req, res) => {
  const errorMessage = String(req.query.error || "").trim();
  res.type("html").send(renderLoginPage(errorMessage));
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.type("html").status(400).send(renderLoginPage("Falta email o contrasena."));
    }

    const session = await login(email, password);
    if (!session) {
      return res
        .type("html")
        .status(401)
        .send(renderLoginPage("Credenciales invalidas."));
    }

    appendSetCookie(res, buildCookie(session.token));
    return res.redirect("/app");
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    await logout(cookies[env.sessionCookieName]);
    appendSetCookie(res, buildClearedCookie());
    return res.redirect("/login");
  } catch (error) {
    return next(error);
  }
});

router.get("/app", requireWebAuth, async (req, res, next) => {
  try {
    const restaurants = await listRestaurants();
    const errorMessage = String(req.query.error || "").trim();
    const successMessage = String(req.query.success || "").trim();
    return res
      .type("html")
      .send(
        renderAppPage({
          operator: req.auth,
          restaurants,
          errorMessage,
          successMessage,
        })
      );
  } catch (error) {
    return next(error);
  }
});

router.post("/app/restaurants", requireWebAuth, async (req, res, next) => {
  try {
    const restaurant = await createRestaurant(req.body || {});
    return res.redirect(
      `/app?success=${encodeURIComponent(`Restaurante creado: ${restaurant.name}`)}`
    );
  } catch (error) {
    const message = error.statusCode ? error.message : "No se pudo crear el restaurante.";
    return res.redirect(`/app?error=${encodeURIComponent(message)}`);
  }
});

module.exports = router;
