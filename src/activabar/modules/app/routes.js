const express = require("express");
const env = require("../../config/env");
const { parseCookies } = require("../../../auth");
const { appendSetCookie } = require("../../lib/http");
const { escapeHtml, renderPage } = require("../../lib/html");
const db = require("../../lib/db");
const {
  buildCookie,
  buildClearedCookie,
  findActiveSessionByToken,
  login,
  logout,
} = require("../auth/service");
const {
  listRestaurants,
  getRestaurantBySlug,
  getRestaurantSummary,
  createRestaurant,
} = require("../restaurants/service");
const { listLeadsByRestaurant, createLead } = require("../leads/service");
const {
  listPromotionsByRestaurant,
  createPromotion,
  countEligibleLeadsForPromotion,
  dispatchPromotion,
} = require("../promotions/service");

const router = express.Router();

function formatDateTime(value) {
  if (!value) return "No disponible";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

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
              <p class="muted">Creado: ${escapeHtml(formatDateTime(restaurant.created_at))}</p>
              <p><a href="/app/restaurants/${encodeURIComponent(
                restaurant.slug
              )}" style="color: var(--accent); text-decoration: none; font-weight: 700;">Abrir restaurante</a></p>
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

function renderRestaurantPage({
  operator,
  restaurant,
  summary,
  leads,
  promotions,
  errorMessage,
  successMessage,
}) {
  const errorBanner = errorMessage
    ? `<div class="banner error">${escapeHtml(errorMessage)}</div>`
    : "";
  const successBanner = successMessage
    ? `<div class="banner ok">${escapeHtml(successMessage)}</div>`
    : "";

  const leadItems = leads.length
    ? leads
        .map(
          (lead) => `
            <article class="restaurant">
              <h3>${escapeHtml(lead.phone_e164)}</h3>
              <p class="muted">Codigo: <code>${escapeHtml(lead.claim_code || "-")}</code></p>
              <p class="muted">Recompensa: ${escapeHtml(lead.reward_label || "-")}</p>
              <p class="muted">Origen: ${escapeHtml(lead.source_qr || "-")}</p>
              <p class="muted">Estado: ${escapeHtml(
                lead.opt_out_at ? "Baja activa" : "Activo"
              )}</p>
              <p class="muted">Alta: ${escapeHtml(formatDateTime(lead.created_at))}</p>
              <p class="muted">Bienvenida enviada: ${escapeHtml(formatDateTime(lead.claim_code_sent_at))}</p>
              ${
                lead.opt_out_at
                  ? `<p class="muted">Baja: ${escapeHtml(formatDateTime(lead.opt_out_at))}</p>`
                  : ""
              }
            </article>
          `
        )
        .join("")
    : `<div class="restaurant"><p>Aun no hay leads en este restaurante.</p></div>`;

  const promotionItems = promotions.length
    ? promotions
        .map(
          (promotion) => `
            <article class="restaurant">
              <h3>${escapeHtml(promotion.title)}</h3>
              <p class="muted">${escapeHtml(promotion.message)}</p>
              <p class="muted">Enviados: ${escapeHtml(promotion.sent_count)} | Fallidos: ${escapeHtml(
                promotion.failed_count
              )}</p>
              <p class="muted">Elegibles ahora: ${escapeHtml(promotion.eligible_now || 0)}</p>
              <p class="muted">Maximo: ${escapeHtml(promotion.max_messages)} | Coste oferta: ${escapeHtml(
                promotion.offer_cost_eur
              )} EUR</p>
              <p class="muted">Creada: ${escapeHtml(formatDateTime(promotion.created_at))}</p>
              <p class="muted">Ultimo envio: ${escapeHtml(formatDateTime(promotion.sent_at))}</p>
              <form method="post" action="/app/promotions/${promotion.id}/dispatch" class="inline">
                <button type="submit" class="secondary">Enviar ahora</button>
              </form>
            </article>
          `
        )
        .join("")
    : `<div class="restaurant"><p>Aun no hay promociones en este restaurante.</p></div>`;

  return renderPage({
    title: `Activabar | ${restaurant.name}`,
    body: `
      <section class="card grid">
        <div class="toolbar">
          <div>
            <p class="muted"><a href="/app" style="color: var(--muted); text-decoration: none;">Volver al panel</a></p>
            <h1>${escapeHtml(restaurant.name)}</h1>
            <p class="muted">Operador: ${escapeHtml(operator.email)} | Slug: <code>${escapeHtml(
              restaurant.slug
            )}</code></p>
          </div>
          <form method="post" action="/logout" class="inline">
            <button type="submit" class="secondary">Cerrar sesion</button>
          </form>
        </div>
        ${errorBanner}
        ${successBanner}
        <div class="grid-2">
          <section class="card">
            <p class="muted">Resumen</p>
            <h2>${escapeHtml(summary.total_leads || 0)}</h2>
            <p class="muted">Leads totales</p>
            <p class="muted">Activos: ${escapeHtml(summary.active_leads || 0)}</p>
            <p class="muted">Bajas: ${escapeHtml(summary.opted_out_leads || 0)}</p>
            <p class="muted">Promociones: ${escapeHtml(summary.total_promotions || 0)}</p>
            <p class="muted">Mensajes enviados: ${escapeHtml(summary.total_sent_deliveries || 0)}</p>
          </section>
          <section class="card">
            <p class="muted">Configuracion</p>
            <h2>${escapeHtml(restaurant.default_reward || "Sin recompensa base")}</h2>
            <p class="muted">Slug: <code>${escapeHtml(restaurant.slug)}</code></p>
            <p class="muted">Creado: ${escapeHtml(formatDateTime(restaurant.created_at))}</p>
            <p class="muted">Define aqui la operativa inicial del restaurante.</p>
          </section>
        </div>
        <div class="grid-2">
          <section class="card">
            <p class="muted">Nuevo lead</p>
            <h2>Alta manual</h2>
            <form method="post" action="/app/restaurants/${encodeURIComponent(
              restaurant.slug
            )}/leads" class="grid">
              <div>
                <label for="phone">WhatsApp</label>
                <input id="phone" name="phone" placeholder="+34600111222" required />
              </div>
              <div>
                <label for="sourceQr">Origen</label>
                <input id="sourceQr" name="sourceQr" placeholder="barra o mesa-7" />
              </div>
              <div>
                <label for="rewardLabel">Recompensa</label>
                <input id="rewardLabel" name="rewardLabel" placeholder="Cafe gratis" />
              </div>
              <label style="display:flex; gap:10px; align-items:center; color:var(--text);">
                <input type="checkbox" name="sendWelcome" value="on" style="width:auto;" />
                Enviar WhatsApp de bienvenida ahora
              </label>
              <button type="submit">Crear lead</button>
            </form>
          </section>
          <section class="card">
            <p class="muted">Nueva promocion</p>
            <h2>Campana manual</h2>
            <form method="post" action="/app/restaurants/${encodeURIComponent(
              restaurant.slug
            )}/promotions" class="grid">
              <div>
                <label for="title">Titulo</label>
                <input id="title" name="title" required />
              </div>
              <div>
                <label for="message">Mensaje</label>
                <input id="message" name="message" required />
              </div>
              <div class="grid-2">
                <div>
                  <label for="validFrom">Valida desde</label>
                  <input id="validFrom" name="validFrom" placeholder="hoy 18:00" />
                </div>
                <div>
                  <label for="validTo">Valida hasta</label>
                  <input id="validTo" name="validTo" placeholder="domingo" />
                </div>
              </div>
              <div class="grid-2">
                <div>
                  <label for="maxMessages">Maximo mensajes</label>
                  <input id="maxMessages" name="maxMessages" value="100" />
                </div>
                <div>
                  <label for="offerCostEur">Coste oferta EUR</label>
                  <input id="offerCostEur" name="offerCostEur" value="0" />
                </div>
              </div>
              <button type="submit">Crear promocion</button>
            </form>
          </section>
        </div>
        <section class="grid">
          <h2>Leads</h2>
          ${leadItems}
        </section>
        <section class="grid">
          <h2>Promociones</h2>
          ${promotionItems}
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

router.get("/app/restaurants/:slug", requireWebAuth, async (req, res, next) => {
  try {
    const restaurant = await getRestaurantBySlug(req.params.slug);
    if (!restaurant) {
      return res.redirect("/app?error=Restaurante%20no%20encontrado.");
    }

    const [summary, leads, promotions] = await Promise.all([
      getRestaurantSummary(restaurant.id),
      listLeadsByRestaurant(restaurant.id),
      listPromotionsByRestaurant(restaurant.id),
    ]);

    const promotionsWithEligibility = await Promise.all(
      promotions.map(async (promotion) => ({
        ...promotion,
        eligible_now: await countEligibleLeadsForPromotion({ promotionId: promotion.id }),
      }))
    );

    return res.type("html").send(
      renderRestaurantPage({
        operator: req.auth,
        restaurant,
        summary,
        leads,
        promotions: promotionsWithEligibility,
        errorMessage: String(req.query.error || "").trim(),
        successMessage: String(req.query.success || "").trim(),
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

router.post("/app/restaurants/:slug/leads", requireWebAuth, async (req, res, next) => {
  try {
    const restaurant = await getRestaurantBySlug(req.params.slug);
    if (!restaurant) {
      return res.redirect("/app?error=Restaurante%20no%20encontrado.");
    }

    const result = await createLead({
      restaurant,
      phone: req.body.phone,
      sourceQr: req.body.sourceQr,
      rewardLabel: req.body.rewardLabel,
      sendWelcome: req.body.sendWelcome === "on",
    });

    const success = result.remainsOptedOut
      ? `Lead actualizado: ${result.lead.phone_e164}. Sigue dado de baja hasta que envie START o ALTA.`
      : result.confirmationSent
        ? `Lead creado y WhatsApp enviado a ${result.lead.phone_e164}`
        : `Lead creado: ${result.lead.phone_e164}`;
    const redirectUrl = `/app/restaurants/${encodeURIComponent(
      restaurant.slug
    )}?success=${encodeURIComponent(success)}`;

    if (result.confirmationError) {
      return res.redirect(
        `/app/restaurants/${encodeURIComponent(
          restaurant.slug
        )}?error=${encodeURIComponent(result.confirmationError)}`
      );
    }

    return res.redirect(redirectUrl);
  } catch (error) {
    const message = error.statusCode ? error.message : "No se pudo crear el lead.";
    return res.redirect(
      `/app/restaurants/${encodeURIComponent(
        req.params.slug
      )}?error=${encodeURIComponent(message)}`
    );
  }
});

router.post(
  "/app/restaurants/:slug/promotions",
  requireWebAuth,
  async (req, res, next) => {
    try {
      const restaurant = await getRestaurantBySlug(req.params.slug);
      if (!restaurant) {
        return res.redirect("/app?error=Restaurante%20no%20encontrado.");
      }

      const promotion = await createPromotion({
        restaurantId: restaurant.id,
        title: req.body.title,
        message: req.body.message,
        validFrom: req.body.validFrom,
        validTo: req.body.validTo,
        maxMessages: req.body.maxMessages,
        offerCostEur: req.body.offerCostEur,
      });

      return res.redirect(
        `/app/restaurants/${encodeURIComponent(
          restaurant.slug
        )}?success=${encodeURIComponent(`Promocion creada: ${promotion.title}`)}`
      );
    } catch (error) {
      const message = error.statusCode
        ? error.message
        : "No se pudo crear la promocion.";
      return res.redirect(
        `/app/restaurants/${encodeURIComponent(
          req.params.slug
        )}?error=${encodeURIComponent(message)}`
      );
    }
  }
);

router.post("/app/promotions/:promotionId/dispatch", requireWebAuth, async (req, res, next) => {
  try {
    const promotionId = Number.parseInt(req.params.promotionId, 10);
    if (!Number.isInteger(promotionId) || promotionId < 1) {
      return res.redirect("/app?error=Promocion%20invalida.");
    }

    const result = await dispatchPromotion({ promotionId });
    if (result.notFound) {
      return res.redirect("/app?error=Promocion%20no%20encontrada.");
    }

    const promotion = await db.one(
      `SELECT r.slug
       FROM promotions p
       JOIN restaurants r ON r.id = p.restaurant_id
       WHERE p.id = $1`,
      [promotionId]
    );

    if (!promotion) {
      return res.redirect("/app?error=Promocion%20sin%20restaurante.");
    }

    if (result.archivedRestaurant) {
      return res.redirect(
        `/app/restaurants/${encodeURIComponent(
          promotion.slug
        )}?error=${encodeURIComponent("No puedes enviar promociones de un restaurante archivado.")}`
      );
    }

    if (result.inProgress) {
      return res.redirect(
        `/app/restaurants/${encodeURIComponent(
          promotion.slug
        )}?error=${encodeURIComponent("Esta promocion ya se esta enviando.")}`
      );
    }

    return res.redirect(
      `/app/restaurants/${encodeURIComponent(
        promotion.slug
      )}?success=${encodeURIComponent(
        `Envio completado. Elegibles ${result.eligible}, enviados ${result.sent}, fallidos ${result.failed}, omitidos ${result.skipped}.`
      )}`
    );
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
