# Plataforma v0.5 - QR + WhatsApp para restaurantes

## Activabar vNext

Hay una base nueva y modular en `src/activabar/` para reconstruir el producto sin seguir ampliando el `server.js` legacy.

Arranque:

```bash
npm install
cp .env.example .env
npm run create-admin:activabar -- "admin@tuempresa.com" "TuPasswordSegura123"
npm run start:activabar
```

Endpoints iniciales:

- `GET /health`
- `GET /health/full`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/restaurants`
- `POST /api/restaurants`
- `GET /api/restaurants/:slug`

Por defecto usa la misma PostgreSQL que el proyecto actual, pero con servidor nuevo, rutas nuevas y sesiones aisladas mediante `ACTIVABAR_SESSION_COOKIE_NAME`.

## Despliegue cloud (Render)

El repo ya incluye un blueprint listo en `render.yaml` para desplegar:

- un web service `activabar-api`
- una PostgreSQL gestionada `activabar-db`
- enlace automático de `DATABASE_URL` desde la base al servicio

Pasos:

```bash
git push
```

Luego en Render:

1. Crear un nuevo Blueprint desde el repositorio.
2. Usar `render.yaml`.
3. Introducir `ADMIN_EMAIL` y `ADMIN_PASSWORD` en la creación inicial.
4. Esperar a que Render cree la base y despliegue el servicio.
5. Verificar `https://TU-SERVICIO.onrender.com/health/full`.

Notas:

- `DATABASE_SSL=true` ya queda configurado para producción.
- `PORT` lo inyecta Render; Activabar lo toma automáticamente.
- Si cambias `ADMIN_EMAIL` o `ADMIN_PASSWORD` después de crear el Blueprint, hazlo desde el panel de Render, no solo en `render.yaml`.

Esta version ya incluye:

- Login web y dashboard multi-bar (`/app`)
- Tokens staff por bar
- Plantillas personalizables por bar (welcome + promo)
- Programacion automatica semanal de campañas
- KPI de negocio + ROI estimado por promocion
- Base de datos PostgreSQL
- Backups logicos automaticos
- Restauracion de backup (`npm run restore`)
- Logs estructurados + alertas por webhook
- Salud extendida (`/health/full`)
- Cumplimiento legal base:
  - consentimiento versionado con IP/UA/origen QR
  - baja por palabra BAJA/STOP (webhook Twilio)
  - politica de privacidad (`/privacy`)
  - supresion de datos desde panel del bar
- Exportacion CSV de PostgreSQL

## 1) Arranque rapido

```bash
npm install
cp .env.example .env
npm run create-admin -- "admin@tuempresa.com" "TuPasswordSegura123"
npm run seed -- "Bar Central" bar-central
npm start
```

Accesos:

- Login: `http://localhost:3000/login`
- Dashboard: `http://localhost:3000/app`

Si no configuras admin en `.env`, en local se crea automaticamente:

- `admin@local.test`
- `admin12345`

## 2) Scripts utiles

```bash
npm run create-admin -- "admin@tuempresa.com" "TuPasswordSegura123"
npm run backup
npm run restore -- ./data/backups/auto_YYYY-MM-DDTHH-MM-SS-sssZ
npm run export:postgres
```

## 3) Operacion diaria

1. Entra en `/app`.
2. Crea bar.
3. Crea token staff del bar.
4. Ajusta plantillas y parametros de negocio (ticket medio, margen, conversion esperada, coste WhatsApp).
5. Crea campañas manuales o programaciones semanales.
6. Revisa KPI y ROI estimado en el panel del bar.

## 4) Programacion automatica

En cada bar puedes crear reglas semanales con:

- dia (`0-6`)
- hora y minuto
- titulo/mensaje
- maximo de mensajes
- coste de oferta

El scheduler corre en segundo plano y cuando llega la hora:

1. crea promocion,
2. la envia,
3. agenda la siguiente ejecucion (+7 dias).

## 5) KPI y ROI (estimado)

El panel calcula:

- leads totales/activos
- conversion global a canje
- entregas y tasa de exito 30 dias
- bajas 30 dias
- neto/coste/ingresos estimados 30 dias
- ROI estimado por promocion

Formula de ROI estimado:

- pedidos estimados = enviados * conversion esperada
- ingresos estimados = pedidos estimados * ticket medio
- beneficio bruto estimado = ingresos * margen bruto
- coste campaña = mensajes * coste_whatsapp + coste_oferta
- neto estimado = beneficio_bruto - coste_campaña
- ROI% = neto / coste_campaña * 100

## 6) Backups y restauracion

Con `BACKUP_ENABLED=true`:

- se crea backup al arrancar,
- se repite cada `BACKUP_INTERVAL_HOURS`,
- se guardan como snapshots JSON en `BACKUP_DIR`,
- se purgan segun `BACKUP_RETENTION_DAYS`.

Prueba de restauracion:

1. para el servidor,
2. restaura: `npm run restore -- ./data/backups/TU_BACKUP`,
3. arranca servidor y valida `GET /health/full`.

`restore` guarda un snapshot previo automatico en `BACKUP_DIR`.

## 7) Cumplimiento legal (minimo viable)

- En landing se pide consentimiento explicito y se guarda:
  - fecha (`consent_at`)
  - version (`consent_version`)
  - texto (`consent_text`)
  - origen QR (`source_qr`)
  - IP/UA (`consent_ip`, `consent_user_agent`)
- Baja automatica:
  - promociones incluyen "Responde BAJA"
  - endpoint interno: `POST /api/public/optout`
  - Twilio inbound:
    - global: `POST /webhooks/twilio/whatsapp/inbound`
    - por bar: `POST /webhooks/twilio/whatsapp/:slug/inbound`
- Politica de privacidad publica: `GET /privacy`
- Supresion de datos por solicitud:
  - panel bar -> seccion "Cumplimiento legal"
  - anonimizacion + bloqueo operativo del lead

## 8) Logs, monitoreo y alertas

- Cada request se registra en JSONL.
- Health checks:
  - `GET /health`
  - `GET /health/full` (incluye test de DB)
- Alertas webhook en errores:
  - `ALERT_WEBHOOK_URL` (Slack/Discord/tu endpoint)
  - `ALERT_MIN_LEVEL` (`warn`/`error`)

Logs por defecto:

- archivo: `./data/logs/app.log`
- stdout: para cloud logs

## 9) Produccion cloud (checklist)

1. desplegar en un servicio 24/7 (Render/Railway/Fly)
2. dominio propio + HTTPS obligatorio
3. configurar `.env` de produccion (`DATABASE_URL`, `DATABASE_SSL=true`, `NODE_ENV=production`, `WHATSAPP_PROVIDER=twilio`)
4. crear admin con password fuerte
5. configurar webhook Twilio inbound:
   - `https://TU_DOMINIO/webhooks/twilio/whatsapp/inbound`
6. activar monitor externo (UptimeRobot/BetterStack) a:
   - `https://TU_DOMINIO/health/full`
7. probar flujo completo:
   - alta QR -> mensaje bienvenida
   - BAJA por WhatsApp -> no recibe campañas
   - restauracion backup valida

## 10) PostgreSQL y exportacion

Incluido:

- esquema base: `migrations/postgres_schema.sql`
- inicializacion automatica al arrancar
- backup logico/restauracion con `npm run backup` y `npm run restore`
- export CSV: `npm run export:postgres`

El export crea carpeta en `exports/` con CSV por tabla + `postgres_schema.sql` + `README.txt`.

## 11) Variables clave (`.env`)

- Base de datos: `DATABASE_URL`, `DATABASE_SSL`
- WhatsApp: `WHATSAPP_PROVIDER`, `TWILIO_*`
- Frecuencia mensajes: `MESSAGE_COOLDOWN_HOURS`, `WEEKLY_MESSAGE_LIMIT`
- Scheduler: `SCHEDULER_ENABLED`, `SCHEDULER_POLL_SECONDS`
- Backup: `BACKUP_ENABLED`, `BACKUP_DIR`, `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION_DAYS`
- Logging/alertas: `LOG_FILE`, `ALERT_WEBHOOK_URL`, `ALERT_MIN_LEVEL`
- Legal: `CONSENT_VERSION`, `PRIVACY_URL`, `DATA_CONTROLLER_*`
- Sesion/admin: `SESSION_*`, `ADMIN_*`
- Seguridad webhook: `TWILIO_WEBHOOK_VALIDATE_SIGNATURE`

## 12) iPhone en red local

`localhost` en iPhone no apunta al Mac.

```bash
ipconfig getifaddr en0
```

Luego abre `http://TU_IP_LOCAL:3000` en el iPhone (misma Wi-Fi).
