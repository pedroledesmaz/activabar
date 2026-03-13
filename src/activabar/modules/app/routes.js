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
const {
  listRestaurants,
  getRestaurantBySlug,
  getRestaurantSummary,
  createRestaurant,
  updateRestaurantSettings,
} = require("../restaurants/service");
const { listLeadsByRestaurant, createLead } = require("../leads/service");
const {
  listPromotionsByRestaurant,
  createPromotion,
  getPromotionById,
  updatePromotion,
  duplicatePromotion,
  archivePromotion,
  deletePromotion,
  isPromotionDraft,
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

function formatNumber(value, fallback = "No disponible") {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : fallback;
}

function restaurantBasePath(slug) {
  return `/app/restaurants/${encodeURIComponent(slug)}`;
}

function restaurantSectionPath(slug, section) {
  if (!section || section === "summary") {
    return restaurantBasePath(slug);
  }
  return `${restaurantBasePath(slug)}/${section}`;
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
              <p><a href="${restaurantBasePath(
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
            <p class="muted">Cada bar tiene ahora sus propias secciones.</p>
          </section>
        </div>
        <section class="grid">
          ${restaurantItems}
        </section>
      </section>
    `,
  });
}

function renderRestaurantShell({
  operator,
  restaurant,
  activeSection,
  errorMessage,
  successMessage,
  content,
}) {
  const errorBanner = errorMessage
    ? `<div class="banner error">${escapeHtml(errorMessage)}</div>`
    : "";
  const successBanner = successMessage
    ? `<div class="banner ok">${escapeHtml(successMessage)}</div>`
    : "";

  const tabs = [
    { id: "summary", label: "Resumen" },
    { id: "leads", label: "Leads" },
    { id: "promotions", label: "Promociones" },
    { id: "settings", label: "Configuracion" },
  ]
    .map(
      (tab) => `
        <a class="tab ${tab.id === activeSection ? "active" : ""}" href="${restaurantSectionPath(
          restaurant.slug,
          tab.id
        )}">${escapeHtml(tab.label)}</a>
      `
    )
    .join("");

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
        <nav class="tabs">
          ${tabs}
        </nav>
        ${errorBanner}
        ${successBanner}
        ${content}
      </section>
    `,
  });
}

function renderSummarySection({ restaurant, summary, recentLeads, recentPromotions }) {
  const recentLeadItems = recentLeads.length
    ? recentLeads
        .map(
          (lead) => `
            <article class="restaurant">
              <h3>${escapeHtml(lead.phone_e164)}</h3>
              <p class="muted">Estado: ${escapeHtml(lead.opt_out_at ? "Baja activa" : "Activo")}</p>
              <p class="muted">Alta: ${escapeHtml(formatDateTime(lead.created_at))}</p>
            </article>
          `
        )
        .join("")
    : `<div class="restaurant"><p>Aun no hay leads recientes.</p></div>`;

  const recentPromotionItems = recentPromotions.length
    ? recentPromotions
        .slice(0, 4)
        .map(
          (promotion) => `
            <article class="restaurant">
              <h3>${escapeHtml(promotion.title)}</h3>
              <p class="muted">Enviados: ${escapeHtml(promotion.sent_count)} | Fallidos: ${escapeHtml(
                promotion.failed_count
              )}</p>
              <p class="muted">Estado: ${escapeHtml(
                promotion.archived_at ? "Archivada" : isPromotionDraft(promotion) ? "Borrador" : "Activa"
              )}</p>
            </article>
          `
        )
        .join("")
    : `<div class="restaurant"><p>Aun no hay promociones recientes.</p></div>`;

  return `
    <div class="grid-3">
      <section class="metric">
        <p class="muted">Leads totales</p>
        <h2>${escapeHtml(summary.total_leads || 0)}</h2>
      </section>
      <section class="metric">
        <p class="muted">Leads activos</p>
        <h2>${escapeHtml(summary.active_leads || 0)}</h2>
      </section>
      <section class="metric">
        <p class="muted">Bajas</p>
        <h2>${escapeHtml(summary.opted_out_leads || 0)}</h2>
      </section>
      <section class="metric">
        <p class="muted">Promociones activas</p>
        <h2>${escapeHtml(summary.total_promotions || 0)}</h2>
      </section>
      <section class="metric">
        <p class="muted">Promociones archivadas</p>
        <h2>${escapeHtml(summary.archived_promotions || 0)}</h2>
      </section>
      <section class="metric">
        <p class="muted">Mensajes enviados</p>
        <h2>${escapeHtml(summary.total_sent_deliveries || 0)}</h2>
      </section>
    </div>
    <div class="grid-2">
      <section class="card">
        <p class="muted">Configuracion base</p>
        <h2>${escapeHtml(restaurant.default_reward || "Sin recompensa base")}</h2>
        <p class="muted">Ticket medio: ${escapeHtml(formatNumber(restaurant.avg_ticket_eur))}</p>
        <p class="muted">Margen bruto: ${escapeHtml(formatNumber(restaurant.gross_margin_pct))}%</p>
        <p class="muted">Conversion promo: ${escapeHtml(formatNumber(restaurant.promo_conversion_pct))}%</p>
      </section>
      <section class="card">
        <p class="muted">Accesos rapidos</p>
        <div class="actions">
          <a class="tab active" href="${restaurantSectionPath(restaurant.slug, "leads")}">Gestionar leads</a>
          <a class="tab active" href="${restaurantSectionPath(
            restaurant.slug,
            "promotions"
          )}">Gestionar promociones</a>
          <a class="tab active" href="${restaurantSectionPath(
            restaurant.slug,
            "settings"
          )}">Editar configuracion</a>
        </div>
      </section>
    </div>
    <div class="grid-2">
      <section class="grid">
        <h2>Leads recientes</h2>
        ${recentLeadItems}
      </section>
      <section class="grid">
        <h2>Promociones recientes</h2>
        ${recentPromotionItems}
      </section>
    </div>
  `;
}

function renderLeadsSection({ restaurant, leads }) {
  const leadItems = leads.length
    ? leads
        .map(
          (lead) => `
            <article class="restaurant">
              <h3>${escapeHtml(lead.phone_e164)}</h3>
              <p class="muted">Codigo: <code>${escapeHtml(lead.claim_code || "-")}</code></p>
              <p class="muted">Recompensa: ${escapeHtml(lead.reward_label || "-")}</p>
              <p class="muted">Origen: ${escapeHtml(lead.source_qr || "-")}</p>
              <p class="muted">Estado: ${escapeHtml(lead.opt_out_at ? "Baja activa" : "Activo")}</p>
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

  return `
    <div class="grid-2">
      <section class="card">
        <p class="muted">Nuevo lead</p>
        <h2>Alta manual</h2>
        <form method="post" action="${restaurantBasePath(restaurant.slug)}/leads" class="grid">
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
        <p class="muted">Vista operativa</p>
        <h2>${leads.length}</h2>
        <p class="muted">Listado completo de leads del bar con su estado actual.</p>
      </section>
    </div>
    <section class="grid">
      <h2>Leads</h2>
      ${leadItems}
    </section>
  `;
}

function promotionActionButtons({ restaurant, promotion }) {
  const base = `${restaurantBasePath(restaurant.slug)}/promotions/${promotion.id}`;
  const canEdit = isPromotionDraft(promotion);
  return `
    <div class="actions">
      ${
        !promotion.archived_at
          ? `<form method="post" action="${base}/dispatch" class="inline">
              <button type="submit" class="secondary small">Enviar ahora</button>
            </form>`
          : ""
      }
      ${
        canEdit
          ? `<a class="tab" href="${base}/edit">Editar</a>
             <form method="post" action="${base}/delete" class="inline">
               <button type="submit" class="secondary small">Borrar</button>
             </form>`
          : ""
      }
      ${
        !promotion.archived_at && !canEdit
          ? `<form method="post" action="${base}/archive" class="inline">
               <button type="submit" class="secondary small">Archivar</button>
             </form>`
          : ""
      }
      <form method="post" action="${base}/duplicate" class="inline">
        <button type="submit" class="secondary small">Duplicar</button>
      </form>
    </div>
  `;
}

function renderPromotionsSection({ restaurant, promotions }) {
  const activePromotions = promotions.filter((promotion) => !promotion.archived_at);
  const archivedPromotions = promotions.filter((promotion) => promotion.archived_at);

  const renderPromotionList = (items, emptyLabel) =>
    items.length
      ? items
          .map(
            (promotion) => `
              <article class="restaurant">
                <h3>${escapeHtml(promotion.title)}</h3>
                <p class="muted">${escapeHtml(promotion.message)}</p>
                <p class="muted">Estado: ${escapeHtml(
                  promotion.archived_at ? "Archivada" : isPromotionDraft(promotion) ? "Borrador" : "Activa"
                )}</p>
                <p class="muted">Enviados: ${escapeHtml(promotion.sent_count)} | Fallidos: ${escapeHtml(
                  promotion.failed_count
                )}</p>
                <p class="muted">Elegibles ahora: ${escapeHtml(promotion.eligible_now || 0)}</p>
                <p class="muted">Maximo: ${escapeHtml(promotion.max_messages)} | Coste oferta: ${escapeHtml(
                  promotion.offer_cost_eur
                )} EUR</p>
                <p class="muted">Creada: ${escapeHtml(formatDateTime(promotion.created_at))}</p>
                <p class="muted">Ultimo envio: ${escapeHtml(formatDateTime(promotion.sent_at))}</p>
                ${
                  promotion.archived_at
                    ? `<p class="muted">Archivada: ${escapeHtml(formatDateTime(promotion.archived_at))}</p>`
                    : ""
                }
                ${promotionActionButtons({ restaurant, promotion })}
              </article>
            `
          )
          .join("")
      : `<div class="restaurant"><p>${escapeHtml(emptyLabel)}</p></div>`;

  return `
    <div class="grid-2">
      <section class="card">
        <p class="muted">Nueva promocion</p>
        <h2>Campana manual</h2>
        <form method="post" action="${restaurantBasePath(restaurant.slug)}/promotions" class="grid">
          <div>
            <label for="title">Titulo</label>
            <input id="title" name="title" required />
          </div>
          <div>
            <label for="message">Mensaje</label>
            <textarea id="message" name="message" required></textarea>
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
      <section class="card">
        <p class="muted">Reglas del panel</p>
        <h2>Gestion de promociones</h2>
        <p class="muted">Las promociones no enviadas se pueden editar o borrar.</p>
        <p class="muted">Las promociones ya enviadas se pueden duplicar o archivar para mantener trazabilidad.</p>
      </section>
    </div>
    <section class="grid">
      <h2>Promociones activas y borradores</h2>
      ${renderPromotionList(activePromotions, "Aun no hay promociones activas.")}
    </section>
    <section class="grid">
      <h2>Promociones archivadas</h2>
      ${renderPromotionList(archivedPromotions, "No hay promociones archivadas.")}
    </section>
  `;
}

function renderPromotionEditSection({ restaurant, promotion }) {
  return `
    <section class="card">
      <p class="muted">Edicion</p>
      <h2>Editar promocion</h2>
      <form method="post" action="${restaurantBasePath(restaurant.slug)}/promotions/${promotion.id}/update" class="grid">
        <div>
          <label for="title">Titulo</label>
          <input id="title" name="title" value="${escapeHtml(promotion.title)}" required />
        </div>
        <div>
          <label for="message">Mensaje</label>
          <textarea id="message" name="message" required>${escapeHtml(promotion.message)}</textarea>
        </div>
        <div class="grid-2">
          <div>
            <label for="validFrom">Valida desde</label>
            <input id="validFrom" name="validFrom" value="${escapeHtml(
              promotion.valid_from || ""
            )}" />
          </div>
          <div>
            <label for="validTo">Valida hasta</label>
            <input id="validTo" name="validTo" value="${escapeHtml(promotion.valid_to || "")}" />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <label for="maxMessages">Maximo mensajes</label>
            <input id="maxMessages" name="maxMessages" value="${escapeHtml(
              promotion.max_messages
            )}" />
          </div>
          <div>
            <label for="offerCostEur">Coste oferta EUR</label>
            <input id="offerCostEur" name="offerCostEur" value="${escapeHtml(
              promotion.offer_cost_eur
            )}" />
          </div>
        </div>
        <div class="actions">
          <button type="submit">Guardar cambios</button>
          <a class="tab" href="${restaurantSectionPath(restaurant.slug, "promotions")}">Cancelar</a>
        </div>
      </form>
    </section>
  `;
}

function renderSettingsSection({ restaurant }) {
  return `
    <div class="grid-2">
      <section class="card">
        <p class="muted">Configuracion del restaurante</p>
        <h2>Editar bar</h2>
        <form method="post" action="${restaurantBasePath(restaurant.slug)}/settings" class="grid">
          <div>
            <label for="name">Nombre</label>
            <input id="name" name="name" value="${escapeHtml(restaurant.name)}" required />
          </div>
          <div>
            <label for="defaultReward">Recompensa base</label>
            <input id="defaultReward" name="defaultReward" value="${escapeHtml(
              restaurant.default_reward || ""
            )}" />
          </div>
          <div>
            <label for="welcomeTemplate">Plantilla bienvenida</label>
            <textarea id="welcomeTemplate" name="welcomeTemplate">${escapeHtml(
              restaurant.welcome_template || ""
            )}</textarea>
          </div>
          <div>
            <label for="promotionTemplate">Plantilla promocion</label>
            <textarea id="promotionTemplate" name="promotionTemplate">${escapeHtml(
              restaurant.promotion_template || ""
            )}</textarea>
          </div>
          <div class="grid-2">
            <div>
              <label for="avgTicketEur">Ticket medio EUR</label>
              <input id="avgTicketEur" name="avgTicketEur" value="${escapeHtml(
                restaurant.avg_ticket_eur ?? ""
              )}" />
            </div>
            <div>
              <label for="grossMarginPct">Margen bruto %</label>
              <input id="grossMarginPct" name="grossMarginPct" value="${escapeHtml(
                restaurant.gross_margin_pct ?? ""
              )}" />
            </div>
          </div>
          <div class="grid-2">
            <div>
              <label for="promoConversionPct">Conversion promo %</label>
              <input id="promoConversionPct" name="promoConversionPct" value="${escapeHtml(
                restaurant.promo_conversion_pct ?? ""
              )}" />
            </div>
            <div>
              <label for="whatsappCostEur">Coste WhatsApp EUR</label>
              <input id="whatsappCostEur" name="whatsappCostEur" value="${escapeHtml(
                restaurant.whatsapp_cost_eur ?? ""
              )}" />
            </div>
          </div>
          <button type="submit">Guardar configuracion</button>
        </form>
      </section>
      <section class="card">
        <p class="muted">Variables utiles</p>
        <h2>Plantillas</h2>
        <p class="muted"><code>{restaurant_name}</code>, <code>{reward_label}</code>, <code>{claim_code}</code></p>
        <p class="muted"><code>{message}</code>, <code>{validity_line}</code>, <code>{valid_from}</code>, <code>{valid_to}</code></p>
      </section>
    </div>
  `;
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

async function loadRestaurantOrRedirect(slug, res) {
  const restaurant = await getRestaurantBySlug(slug);
  if (!restaurant) {
    res.redirect("/app?error=Restaurante%20no%20encontrado.");
    return null;
  }
  return restaurant;
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
      return res.type("html").status(401).send(renderLoginPage("Credenciales invalidas."));
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
    return res.type("html").send(
      renderAppPage({
        operator: req.auth,
        restaurants,
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
    return res.redirect(
      `/app?error=${encodeURIComponent(
        error.statusCode ? error.message : "No se pudo crear el restaurante."
      )}`
    );
  }
});

router.get("/app/restaurants/:slug", requireWebAuth, async (req, res, next) => {
  try {
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, res);
    if (!restaurant) return undefined;

    const [summary, leads, promotions] = await Promise.all([
      getRestaurantSummary(restaurant.id),
      listLeadsByRestaurant(restaurant.id, 5),
      listPromotionsByRestaurant(restaurant.id, 5),
    ]);

    return res.type("html").send(
      renderRestaurantShell({
        operator: req.auth,
        restaurant,
        activeSection: "summary",
        errorMessage: String(req.query.error || "").trim(),
        successMessage: String(req.query.success || "").trim(),
        content: renderSummarySection({
          restaurant,
          summary,
          recentLeads: leads,
          recentPromotions: promotions,
        }),
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.get("/app/restaurants/:slug/leads", requireWebAuth, async (req, res, next) => {
  try {
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, res);
    if (!restaurant) return undefined;
    const leads = await listLeadsByRestaurant(restaurant.id, 200);

    return res.type("html").send(
      renderRestaurantShell({
        operator: req.auth,
        restaurant,
        activeSection: "leads",
        errorMessage: String(req.query.error || "").trim(),
        successMessage: String(req.query.success || "").trim(),
        content: renderLeadsSection({ restaurant, leads }),
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.post("/app/restaurants/:slug/leads", requireWebAuth, async (req, res) => {
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

    if (result.confirmationError) {
      return res.redirect(
        `${restaurantSectionPath(restaurant.slug, "leads")}?error=${encodeURIComponent(
          result.confirmationError
        )}`
      );
    }

    return res.redirect(
      `${restaurantSectionPath(restaurant.slug, "leads")}?success=${encodeURIComponent(success)}`
    );
  } catch (error) {
    return res.redirect(
      `${restaurantSectionPath(req.params.slug, "leads")}?error=${encodeURIComponent(
        error.statusCode ? error.message : "No se pudo crear el lead."
      )}`
    );
  }
});

router.get("/app/restaurants/:slug/promotions", requireWebAuth, async (req, res, next) => {
  try {
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, res);
    if (!restaurant) return undefined;
    const promotions = await listPromotionsByRestaurant(restaurant.id, 200);
    const promotionsWithEligibility = await Promise.all(
      promotions.map(async (promotion) => ({
        ...promotion,
        eligible_now: promotion.archived_at
          ? 0
          : await countEligibleLeadsForPromotion({ promotionId: promotion.id }),
      }))
    );

    return res.type("html").send(
      renderRestaurantShell({
        operator: req.auth,
        restaurant,
        activeSection: "promotions",
        errorMessage: String(req.query.error || "").trim(),
        successMessage: String(req.query.success || "").trim(),
        content: renderPromotionsSection({
          restaurant,
          promotions: promotionsWithEligibility,
        }),
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.post("/app/restaurants/:slug/promotions", requireWebAuth, async (req, res) => {
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
      `${restaurantSectionPath(restaurant.slug, "promotions")}?success=${encodeURIComponent(
        `Promocion creada: ${promotion.title}`
      )}`
    );
  } catch (error) {
    return res.redirect(
      `${restaurantSectionPath(req.params.slug, "promotions")}?error=${encodeURIComponent(
        error.statusCode ? error.message : "No se pudo crear la promocion."
      )}`
    );
  }
});

router.get(
  "/app/restaurants/:slug/promotions/:promotionId/edit",
  requireWebAuth,
  async (req, res, next) => {
    try {
      const restaurant = await loadRestaurantOrRedirect(req.params.slug, res);
      if (!restaurant) return undefined;
      const promotion = await getPromotionById(Number.parseInt(req.params.promotionId, 10));
      if (!promotion || promotion.restaurant_id !== restaurant.id) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=Promocion%20no%20encontrada.`
        );
      }

      if (!isPromotionDraft(promotion)) {
        return res.redirect(
          `${restaurantSectionPath(
            restaurant.slug,
            "promotions"
          )}?error=Solo%20puedes%20editar%20promociones%20no%20enviadas.`
        );
      }

      return res.type("html").send(
        renderRestaurantShell({
          operator: req.auth,
          restaurant,
          activeSection: "promotions",
          errorMessage: String(req.query.error || "").trim(),
          successMessage: String(req.query.success || "").trim(),
          content: renderPromotionEditSection({ restaurant, promotion }),
        })
      );
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/app/restaurants/:slug/promotions/:promotionId/update",
  requireWebAuth,
  async (req, res) => {
    try {
      const restaurant = await getRestaurantBySlug(req.params.slug);
      if (!restaurant) {
        return res.redirect("/app?error=Restaurante%20no%20encontrado.");
      }

      const promotion = await getPromotionById(Number.parseInt(req.params.promotionId, 10));
      if (!promotion || promotion.restaurant_id !== restaurant.id) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=Promocion%20no%20encontrada.`
        );
      }

      const updated = await updatePromotion({
        promotionId: promotion.id,
        title: req.body.title,
        message: req.body.message,
        validFrom: req.body.validFrom,
        validTo: req.body.validTo,
        maxMessages: req.body.maxMessages,
        offerCostEur: req.body.offerCostEur,
      });

      return res.redirect(
        `${restaurantSectionPath(restaurant.slug, "promotions")}?success=${encodeURIComponent(
          `Promocion actualizada: ${updated.title}`
        )}`
      );
    } catch (error) {
      return res.redirect(
        `${restaurantSectionPath(req.params.slug, "promotions")}?error=${encodeURIComponent(
          error.statusCode ? error.message : "No se pudo actualizar la promocion."
        )}`
      );
    }
  }
);

router.post(
  "/app/restaurants/:slug/promotions/:promotionId/duplicate",
  requireWebAuth,
  async (req, res) => {
    try {
      const duplicated = await duplicatePromotion(Number.parseInt(req.params.promotionId, 10));
      return res.redirect(
        `${restaurantSectionPath(req.params.slug, "promotions")}?success=${encodeURIComponent(
          `Promocion duplicada: ${duplicated.title}`
        )}`
      );
    } catch (error) {
      return res.redirect(
        `${restaurantSectionPath(req.params.slug, "promotions")}?error=${encodeURIComponent(
          error.statusCode ? error.message : "No se pudo duplicar la promocion."
        )}`
      );
    }
  }
);

router.post(
  "/app/restaurants/:slug/promotions/:promotionId/archive",
  requireWebAuth,
  async (req, res) => {
    try {
      await archivePromotion(Number.parseInt(req.params.promotionId, 10));
      return res.redirect(
        `${restaurantSectionPath(req.params.slug, "promotions")}?success=Promocion%20archivada.`
      );
    } catch (error) {
      return res.redirect(
        `${restaurantSectionPath(req.params.slug, "promotions")}?error=${encodeURIComponent(
          error.statusCode ? error.message : "No se pudo archivar la promocion."
        )}`
      );
    }
  }
);

router.post(
  "/app/restaurants/:slug/promotions/:promotionId/delete",
  requireWebAuth,
  async (req, res) => {
    try {
      await deletePromotion(Number.parseInt(req.params.promotionId, 10));
      return res.redirect(
        `${restaurantSectionPath(req.params.slug, "promotions")}?success=Promocion%20borrada.`
      );
    } catch (error) {
      return res.redirect(
        `${restaurantSectionPath(req.params.slug, "promotions")}?error=${encodeURIComponent(
          error.statusCode ? error.message : "No se pudo borrar la promocion."
        )}`
      );
    }
  }
);

router.post(
  "/app/restaurants/:slug/promotions/:promotionId/dispatch",
  requireWebAuth,
  async (req, res, next) => {
    try {
      const restaurant = await getRestaurantBySlug(req.params.slug);
      if (!restaurant) {
        return res.redirect("/app?error=Restaurante%20no%20encontrado.");
      }

      const promotionId = Number.parseInt(req.params.promotionId, 10);
      const promotion = await getPromotionById(promotionId);
      if (!promotion || promotion.restaurant_id !== restaurant.id) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=Promocion%20no%20encontrada.`
        );
      }

      const result = await dispatchPromotion({ promotionId });
      if (result.notFound) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=Promocion%20no%20encontrada.`
        );
      }
      if (result.archivedRestaurant) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=${encodeURIComponent(
            "No puedes enviar promociones de un restaurante archivado."
          )}`
        );
      }
      if (result.archivedPromotion) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=${encodeURIComponent(
            "No puedes enviar una promocion archivada."
          )}`
        );
      }
      if (result.inProgress) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=${encodeURIComponent(
            "Esta promocion ya se esta enviando."
          )}`
        );
      }

      return res.redirect(
        `${restaurantSectionPath(restaurant.slug, "promotions")}?success=${encodeURIComponent(
          `Envio completado. Elegibles ${result.eligible}, enviados ${result.sent}, fallidos ${result.failed}, omitidos ${result.skipped}.`
        )}`
      );
    } catch (error) {
      return next(error);
    }
  }
);

router.get("/app/restaurants/:slug/settings", requireWebAuth, async (req, res, next) => {
  try {
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, res);
    if (!restaurant) return undefined;

    return res.type("html").send(
      renderRestaurantShell({
        operator: req.auth,
        restaurant,
        activeSection: "settings",
        errorMessage: String(req.query.error || "").trim(),
        successMessage: String(req.query.success || "").trim(),
        content: renderSettingsSection({ restaurant }),
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.post("/app/restaurants/:slug/settings", requireWebAuth, async (req, res) => {
  try {
    await updateRestaurantSettings(req.params.slug, req.body || {});
    return res.redirect(
      `${restaurantSectionPath(req.params.slug, "settings")}?success=Configuracion%20guardada.`
    );
  } catch (error) {
    return res.redirect(
      `${restaurantSectionPath(req.params.slug, "settings")}?error=${encodeURIComponent(
        error.statusCode ? error.message : "No se pudo guardar la configuracion."
      )}`
    );
  }
});

module.exports = router;
