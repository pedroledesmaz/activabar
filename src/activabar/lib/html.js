function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage({ title, body }) {
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0f1c;
        --panel: #10192d;
        --panel-2: #152340;
        --border: #2a3b66;
        --text: #eef4ff;
        --muted: #9ab0d6;
        --accent: #5dd4a2;
        --danger: #ff6b6b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(93, 212, 162, 0.16), transparent 28%),
          linear-gradient(180deg, #09101d 0%, #0a0f1c 100%);
        color: var(--text);
      }
      .shell {
        width: min(960px, calc(100vw - 32px));
        margin: 40px auto;
      }
      .card {
        background: rgba(16, 25, 45, 0.92);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
      }
      h1, h2, h3, p { margin-top: 0; }
      .muted { color: var(--muted); }
      .grid {
        display: grid;
        gap: 16px;
      }
      .grid-2 {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }
      label {
        display: block;
        margin-bottom: 8px;
        font-size: 14px;
        color: var(--muted);
      }
      input {
        width: 100%;
        border: 1px solid var(--border);
        background: var(--panel-2);
        color: var(--text);
        border-radius: 12px;
        padding: 14px 16px;
        font-size: 15px;
      }
      button {
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: #052017;
        padding: 12px 18px;
        font-weight: 700;
        cursor: pointer;
      }
      .secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
      }
      .banner {
        margin-bottom: 18px;
        border-radius: 14px;
        padding: 14px 16px;
        font-size: 14px;
      }
      .banner.error {
        background: rgba(255, 107, 107, 0.12);
        border: 1px solid rgba(255, 107, 107, 0.4);
        color: #ffd1d1;
      }
      .banner.ok {
        background: rgba(93, 212, 162, 0.12);
        border: 1px solid rgba(93, 212, 162, 0.4);
        color: #cffff0;
      }
      .restaurant {
        padding: 18px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(21, 35, 64, 0.7);
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
      }
      form.inline { margin: 0; }
      a {
        color: inherit;
      }
      code {
        background: rgba(255, 255, 255, 0.06);
        border-radius: 8px;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      ${body}
    </main>
  </body>
</html>`;
}

module.exports = {
  escapeHtml,
  renderPage,
};
