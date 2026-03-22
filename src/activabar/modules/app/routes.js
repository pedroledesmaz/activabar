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
  canManageAllRestaurants,
  canAccessRestaurant,
  listRestaurantManagers,
  createRestaurantManager,
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

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatInteger(value) {
  return new Intl.NumberFormat("es-ES").format(asNumber(value, 0));
}

function formatEuro(value) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(asNumber(value, 0));
}

function formatPercent(value) {
  return `${asNumber(value, 0).toFixed(1)}%`;
}

function estimatePromotionFinance({
  sentCount,
  offerCostEur,
  avgTicketEur,
  grossMarginPct,
  promoConversionPct,
  whatsappCostEur,
}) {
  const sent = Math.max(0, asNumber(sentCount, 0));
  const offerCost = Math.max(0, asNumber(offerCostEur, 0));
  const avgTicket = Math.max(0, asNumber(avgTicketEur, 20));
  const marginPct = Math.max(0, Math.min(100, asNumber(grossMarginPct, 70)));
  const conversionPct = Math.max(0, Math.min(100, asNumber(promoConversionPct, 8)));
  const messageCost = Math.max(0, asNumber(whatsappCostEur, 0.08));

  const estimatedOrders = sent * (conversionPct / 100);
  const estimatedRevenue = estimatedOrders * avgTicket;
  const estimatedGrossProfit = estimatedRevenue * (marginPct / 100);
  const estimatedCampaignCost = sent * messageCost + offerCost;
  const estimatedNet = estimatedGrossProfit - estimatedCampaignCost;
  const roiPct = estimatedCampaignCost > 0 ? (estimatedNet / estimatedCampaignCost) * 100 : 0;

  return {
    estimatedOrders,
    estimatedRevenue,
    estimatedGrossProfit,
    estimatedCampaignCost,
    estimatedNet,
    roiPct,
  };
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
          ${
            canManageAllRestaurants(operator)
              ? `<section class="card">
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
                </section>`
              : `<section class="card">
                  <p class="muted">Acceso</p>
                  <h2>Tus restaurantes</h2>
                  <p class="muted">Tu cuenta solo puede operar en los bares asignados.</p>
                </section>`
          }
          <section class="card">
            <p class="muted">Restaurantes</p>
            <h2>${restaurants.length}</h2>
            <p class="muted">${
              canManageAllRestaurants(operator)
                ? "Cada bar tiene ahora sus propias secciones."
                : "Solo ves los restaurantes a los que tienes acceso."
            }</p>
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
  const totalLeads = asNumber(summary.total_leads);
  const activeLeads = asNumber(summary.active_leads);
  const optedOutLeads = asNumber(summary.opted_out_leads);
  const redeemedLeads = asNumber(summary.redeemed_leads);
  const totalPromotions = asNumber(summary.total_promotions);
  const archivedPromotions = asNumber(summary.archived_promotions);
  const sent30d = asNumber(summary.sent_30d);
  const failed30d = asNumber(summary.failed_30d);
  const newLeads30d = asNumber(summary.new_leads_30d);
  const redeemed30d = asNumber(summary.redeemed_30d);
  const optouts30d = asNumber(summary.optouts_30d);
  const totalSentDeliveries = asNumber(summary.total_sent_deliveries);
  const totalFailedDeliveries = asNumber(summary.total_failed_deliveries);

  const deliveryAttempt30d = sent30d + failed30d;
  const conversionTotalPct = totalLeads > 0 ? (redeemedLeads / totalLeads) * 100 : 0;
  const conversion30dPct = sent30d > 0 ? (redeemed30d / sent30d) * 100 : 0;
  const deliveryRate30dPct = deliveryAttempt30d > 0 ? (sent30d / deliveryAttempt30d) * 100 : 0;
  const optOutRate30dPct = newLeads30d > 0 ? (optouts30d / newLeads30d) * 100 : 0;
  const activeBasePct = totalLeads > 0 ? (activeLeads / totalLeads) * 100 : 0;

  const metricSettings = {
    avgTicketEur: asNumber(restaurant.avg_ticket_eur, 20),
    grossMarginPct: asNumber(restaurant.gross_margin_pct, 70),
    promoConversionPct: asNumber(restaurant.promo_conversion_pct, 8),
    whatsappCostEur: asNumber(restaurant.whatsapp_cost_eur, 0.08),
  };

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let estimatedRevenue30d = 0;
  let estimatedCost30d = 0;
  let estimatedNet30d = 0;

  const promotionPerformance = [...recentPromotions]
    .sort((left, right) => {
      const leftTime = new Date(left.sent_at || left.created_at || 0).getTime();
      const rightTime = new Date(right.sent_at || right.created_at || 0).getTime();
      return rightTime - leftTime;
    })
    .map((promotion) => {
      const finance = estimatePromotionFinance({
        sentCount: promotion.sent_count,
        offerCostEur: promotion.offer_cost_eur,
        avgTicketEur: metricSettings.avgTicketEur,
        grossMarginPct: metricSettings.grossMarginPct,
        promoConversionPct: metricSettings.promoConversionPct,
        whatsappCostEur: metricSettings.whatsappCostEur,
      });
      const activityTime = new Date(promotion.sent_at || promotion.created_at || 0).getTime();
      if (Number.isFinite(activityTime) && activityTime >= thirtyDaysAgo) {
        estimatedRevenue30d += finance.estimatedRevenue;
        estimatedCost30d += finance.estimatedCampaignCost;
        estimatedNet30d += finance.estimatedNet;
      }
      return {
        ...promotion,
        finance,
      };
    });

  const roi30dPct = estimatedCost30d > 0 ? (estimatedNet30d / estimatedCost30d) * 100 : 0;
  const topPromotions = promotionPerformance.slice(0, 6);

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

  const promotionRows = topPromotions.length
    ? topPromotions
        .map(
          (promotion) => `
            <tr>
              <td>
                <strong>${escapeHtml(promotion.title)}</strong>
                <div class="muted">${escapeHtml(formatDateTime(promotion.sent_at || promotion.created_at))}</div>
              </td>
              <td>${escapeHtml(
                promotion.archived_at ? "Archivada" : isPromotionDraft(promotion) ? "Borrador" : "Activa"
              )}</td>
              <td>${escapeHtml(formatInteger(promotion.sent_count))}</td>
              <td>${escapeHtml(formatInteger(promotion.failed_count))}</td>
              <td>${escapeHtml(formatEuro(promotion.finance.estimatedCampaignCost))}</td>
              <td>${escapeHtml(formatEuro(promotion.finance.estimatedNet))}</td>
              <td>${escapeHtml(formatPercent(promotion.finance.roiPct))}</td>
            </tr>
          `
        )
        .join("")
    : `
        <tr>
          <td colspan="7" class="muted">Aun no hay promociones con actividad suficiente para analizar.</td>
        </tr>
      `;

  return `
    <div class="grid-4">
      <section class="metric">
        <p class="muted">Clientes captados</p>
        <div class="value">${escapeHtml(formatInteger(totalLeads))}</div>
        <p class="meta">${escapeHtml(formatInteger(activeLeads))} activos ahora</p>
      </section>
      <section class="metric">
        <p class="muted">Mensajes enviados</p>
        <div class="value">${escapeHtml(formatInteger(totalSentDeliveries))}</div>
        <p class="meta">${escapeHtml(formatInteger(sent30d))} en los ultimos 30 dias</p>
      </section>
      <section class="metric">
        <p class="muted">Canjes registrados</p>
        <div class="value">${escapeHtml(formatInteger(redeemedLeads))}</div>
        <p class="meta">${escapeHtml(formatInteger(redeemed30d))} en 30 dias</p>
      </section>
      <section class="metric">
        <p class="muted">Conversion total</p>
        <div class="value">${escapeHtml(formatPercent(conversionTotalPct))}</div>
        <p class="meta">canjes sobre base captada</p>
      </section>
    </div>
    <div class="grid-4">
      <section class="metric">
        <p class="muted">Leads nuevos 30d</p>
        <div class="value">${escapeHtml(formatInteger(newLeads30d))}</div>
        <p class="meta">${escapeHtml(formatPercent(activeBasePct))} de la base sigue activa</p>
      </section>
      <section class="metric">
        <p class="muted">Bajas 30d</p>
        <div class="value">${escapeHtml(formatInteger(optouts30d))}</div>
        <p class="meta">${escapeHtml(formatPercent(optOutRate30dPct))} sobre nuevas altas</p>
      </section>
      <section class="metric">
        <p class="muted">Neto estimado 30d</p>
        <div class="value">${escapeHtml(formatEuro(estimatedNet30d))}</div>
        <p class="meta">${escapeHtml(formatEuro(estimatedRevenue30d))} ingresos estimados</p>
      </section>
      <section class="metric">
        <p class="muted">ROI estimado 30d</p>
        <div class="value">${escapeHtml(formatPercent(roi30dPct))}</div>
        <p class="meta">${escapeHtml(formatPercent(conversion30dPct))} conversion de envios 30d</p>
      </section>
    </div>
    <div class="grid-2">
      <section class="card">
        <p class="muted">Lectura rapida</p>
        <h2>Como va el bar</h2>
        <p class="muted">
          Tienes ${escapeHtml(formatInteger(totalPromotions))} promociones activas y ${escapeHtml(
            formatInteger(archivedPromotions)
          )} archivadas. La entregabilidad de los ultimos 30 dias va en ${escapeHtml(
            formatPercent(deliveryRate30dPct)
          )} y llevas ${escapeHtml(formatInteger(totalFailedDeliveries))} fallidos acumulados.
        </p>
        <p class="muted">
          Con la configuracion actual, cada campana estima ticket medio de ${escapeHtml(
            formatEuro(metricSettings.avgTicketEur)
          )}, margen bruto del ${escapeHtml(formatPercent(metricSettings.grossMarginPct))} y coste de WhatsApp de ${escapeHtml(
            formatEuro(metricSettings.whatsappCostEur)
          )} por envio.
        </p>
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
        <h2>Promociones y rendimiento</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campana</th>
                <th>Estado</th>
                <th>Enviados</th>
                <th>Fallidos</th>
                <th>Coste est.</th>
                <th>Neto est.</th>
                <th>ROI est.</th>
              </tr>
            </thead>
            <tbody>
              ${promotionRows}
            </tbody>
          </table>
        </div>
      </section>
      <section class="grid">
        <h2>Leads recientes</h2>
        <div class="actions">
          <span class="pill">Activos ${escapeHtml(formatInteger(activeLeads))}</span>
          <span class="pill">Bajas ${escapeHtml(formatInteger(optedOutLeads))}</span>
          <span class="pill">Canjes ${escapeHtml(formatInteger(redeemedLeads))}</span>
        </div>
        ${recentLeadItems}
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

function renderSettingsSection({ restaurant, operator, managers }) {
  const managerItems = managers.length
    ? managers
        .map(
          (manager) => `
            <article class="restaurant">
              <h3>${escapeHtml(manager.email)}</h3>
              <p class="muted">Rol: ${escapeHtml(manager.role)}</p>
              <p class="muted">Activo: ${escapeHtml(Number(manager.is_active) === 1 ? "Si" : "No")}</p>
              <p class="muted">Asignado: ${escapeHtml(formatDateTime(manager.created_at))}</p>
            </article>
          `
        )
        .join("")
    : `<div class="restaurant"><p>No hay managers asignados a este bar.</p></div>`;

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
    ${
      canManageAllRestaurants(operator)
        ? `<div class="grid-2">
            <section class="card">
              <p class="muted">Accesos del bar</p>
              <h2>Crear manager</h2>
              <form method="post" action="${restaurantBasePath(restaurant.slug)}/managers" class="grid">
                <div>
                  <label for="managerEmail">Email</label>
                  <input id="managerEmail" name="email" type="email" required />
                </div>
                <div>
                  <label for="managerPassword">Password inicial</label>
                  <input id="managerPassword" name="password" type="password" required />
                </div>
                <button type="submit">Crear manager</button>
              </form>
            </section>
            <section class="grid">
              <h2>Managers asignados</h2>
              ${managerItems}
            </section>
          </div>`
        : ""
    }
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

function filterRestaurantsForOperator(restaurants, operator) {
  if (canManageAllRestaurants(operator)) {
    return restaurants;
  }
  const ids = operator.restaurant_ids || operator.restaurantIds || [];
  return restaurants.filter((restaurant) => ids.includes(Number(restaurant.id)));
}

async function loadRestaurantOrRedirect(slug, operator, res) {
  const restaurant = await getRestaurantBySlug(slug);
  if (!restaurant) {
    res.redirect("/app?error=Restaurante%20no%20encontrado.");
    return null;
  }
  if (!canAccessRestaurant(operator, restaurant.id)) {
    res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
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
    const restaurants = filterRestaurantsForOperator(
      await listRestaurants(),
      req.auth
    );
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
    if (!canManageAllRestaurants(req.auth)) {
      return res.redirect("/app?error=Solo%20el%20admin%20puede%20crear%20restaurantes.");
    }
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
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, req.auth, res);
    if (!restaurant) return undefined;

    const [summary, leads, promotions] = await Promise.all([
      getRestaurantSummary(restaurant.id),
      listLeadsByRestaurant(restaurant.id, 5),
      listPromotionsByRestaurant(restaurant.id, 200),
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
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, req.auth, res);
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
    if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
      return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
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
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, req.auth, res);
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
    if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
      return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
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
      const restaurant = await loadRestaurantOrRedirect(req.params.slug, req.auth, res);
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
      if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
        return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
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
      const restaurant = await getRestaurantBySlug(req.params.slug);
      if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
        return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
      }
      const promotion = await getPromotionById(Number.parseInt(req.params.promotionId, 10));
      if (!promotion || promotion.restaurant_id !== restaurant.id) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=Promocion%20no%20encontrada.`
        );
      }
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
      const restaurant = await getRestaurantBySlug(req.params.slug);
      if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
        return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
      }
      const promotion = await getPromotionById(Number.parseInt(req.params.promotionId, 10));
      if (!promotion || promotion.restaurant_id !== restaurant.id) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=Promocion%20no%20encontrada.`
        );
      }
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
      const restaurant = await getRestaurantBySlug(req.params.slug);
      if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
        return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
      }
      const promotion = await getPromotionById(Number.parseInt(req.params.promotionId, 10));
      if (!promotion || promotion.restaurant_id !== restaurant.id) {
        return res.redirect(
          `${restaurantSectionPath(restaurant.slug, "promotions")}?error=Promocion%20no%20encontrada.`
        );
      }
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
      if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
        return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
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
    const restaurant = await loadRestaurantOrRedirect(req.params.slug, req.auth, res);
    if (!restaurant) return undefined;
    const managers = canManageAllRestaurants(req.auth)
      ? await listRestaurantManagers(restaurant.id)
      : [];

    return res.type("html").send(
      renderRestaurantShell({
        operator: req.auth,
        restaurant,
        activeSection: "settings",
        errorMessage: String(req.query.error || "").trim(),
        successMessage: String(req.query.success || "").trim(),
        content: renderSettingsSection({
          restaurant,
          operator: req.auth,
          managers,
        }),
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.post("/app/restaurants/:slug/settings", requireWebAuth, async (req, res) => {
  try {
    const restaurant = await getRestaurantBySlug(req.params.slug);
    if (!restaurant || !canAccessRestaurant(req.auth, restaurant.id)) {
      return res.redirect("/app?error=No%20tienes%20acceso%20a%20ese%20restaurante.");
    }
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

router.post("/app/restaurants/:slug/managers", requireWebAuth, async (req, res) => {
  try {
    if (!canManageAllRestaurants(req.auth)) {
      return res.redirect("/app?error=Solo%20el%20admin%20puede%20crear%20managers.");
    }
    const restaurant = await getRestaurantBySlug(req.params.slug);
    if (!restaurant) {
      return res.redirect("/app?error=Restaurante%20no%20encontrado.");
    }
    const result = await createRestaurantManager({
      restaurantId: restaurant.id,
      email: req.body.email,
      password: req.body.password,
    });
    return res.redirect(
      `${restaurantSectionPath(restaurant.slug, "settings")}?success=${encodeURIComponent(
        result.created
          ? `Manager creado: ${result.email}`
          : `Manager actualizado/asignado: ${result.email}`
      )}`
    );
  } catch (error) {
    return res.redirect(
      `${restaurantSectionPath(req.params.slug, "settings")}?error=${encodeURIComponent(
        error.statusCode ? error.message : "No se pudo crear el manager."
      )}`
    );
  }
});

module.exports = router;
