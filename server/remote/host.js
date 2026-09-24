// Коннектор на сервере: HTTP-сервер за шлюзом (gateway). Шлюз принимает запросы из
// интернета, проверяет токены OAuth и вход владельца и передаёт сюда запросы своего
// пути (например, /bybit) с заголовками:
//   X-Gateway-Secret — общий секрет шлюза и коннектора (без него запрос отклоняется);
//   X-Gateway-Auth   — token (приложение с токеном OAuth: доступ к MCP) или owner
//                      (владелец вошёл в браузере: страницы настроек);
//   X-Gateway-Grant  — какой выданный доступ использует приложение.
// Адреса относительно пути коннектора:
//   '' и /mcp  — MCP (Streamable HTTP), только с токеном;
//   /settings  — настройки (manifest.json → user_config), только владелец;
//   маршруты и WebSocket самого коннектора (app.routes, app.upgrades).
// Настройки хранятся в settings.json папки данных. После сохранения коннектор
// пересоздаётся с новыми настройками — как Claude Desktop перезапускает расширение.

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { newNonce, pageHeaders, renderMessagePage, renderSettingsPage } from './page.js';
import { readBody, serveMcp } from './transport.js';

const FORM_LIMIT = 64 * 1024;
const RELOAD_GRACE_MS = 5000;

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function text(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(`${body}\n`);
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

// Маршрут по префиксу пути: '/accounts' подходит для '/accounts' и '/accounts/…'.
function routeMatch(table, rest) {
  for (const [prefix, handler] of Object.entries(table ?? {})) {
    const p = prefix.replace(/\/+$/, '');
    if (rest === p || rest.startsWith(`${p}/`)) return { prefix: p, handler };
  }
  return null;
}

export class RemoteHost {
  // createApp(env) → { mcp, problems?, routes?, upgrades?, close() }:
  //   routes   — { '/accounts': (req, res, ctx) => … } страницы только для владельца;
  //   upgrades — { '/alerts': (req, socket, head, ctx) => … } WebSocket с токеном в адресе;
  //   ctx.rest — остаток пути после префикса ('' или '/…').
  constructor({ title, publicUrl, gatewaySecret, settings, createApp, logger, fieldOptions = {}, intro = '', links = [], footer = '' }) {
    this.title = title;
    this.publicUrl = new URL(publicUrl);
    this.base = this.publicUrl.pathname.replace(/\/+$/, '');
    this.origin = this.publicUrl.origin;
    this.gatewaySecret = gatewaySecret;
    this.settings = settings;
    this.createApp = createApp;
    this.logger = logger;
    this.fieldOptions = fieldOptions;
    this.intro = intro;
    this.links = links;
    this.footer = footer;
    this.app = null;
    this.switching = null;
    this.server = null;
  }

  get mcpUrl() {
    return `${this.origin}${this.base}`;
  }

  // Коннектор не поднялся с сохранёнными настройками — HTTP-сервер всё равно работает:
  // страница настроек доступна, чтобы исправить их; MCP отвечает 503.
  async build() {
    try {
      this.app = await this.createApp(this.settings.env());
      this.failure = null;
    } catch (err) {
      this.app = null;
      this.failure = err?.message ?? String(err);
      this.logger.error(`коннектор не запустился с текущими настройками: ${err?.stack ?? err}`);
    }
  }

  async start({ host = '127.0.0.1', port = 8080 } = {}) {
    this.settings.load();
    await this.build();
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err) => {
        this.logger.error(`HTTP ${req.method} ${this.safePath(req)}: ${err?.stack ?? err}`);
        text(res, 500, 'Internal error');
      });
    });
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.server.on('clientError', (err, socket) => socket.destroy());
    // Долгие ответы (SSE, подписки) не должны обрываться таймаутом самого сервера.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.server.keepAliveTimeout = 65_000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host, port }, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    return this.server.address();
  }

  // Приложение для нового запроса: во время пересоздания запросы ждут.
  async current() {
    while (this.switching) await this.switching;
    return this.app;
  }

  // Новые настройки: старое приложение закрывается (начатые вызовы получают несколько
  // секунд), новое создаётся из settings.json.
  async reload() {
    while (this.switching) await this.switching;
    const old = this.app;
    this.switching = (async () => {
      try {
        await Promise.race([old?.close?.(), new Promise((r) => setTimeout(r, RELOAD_GRACE_MS))]);
      } catch (err) {
        this.logger.error(`остановка перед перезапуском: ${err?.message ?? err}`);
      }
      await this.build();
    })();
    try {
      await this.switching;
    } finally {
      this.switching = null;
    }
    if (this.app) this.logger.info('настройки изменены: коннектор перезапущен');
  }

  async stop() {
    await this.current();
    this.server?.closeAllConnections?.();
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.app?.close?.();
  }

  // Путь для журнала: токены в адресах WebSocket не записываются.
  safePath(req) {
    const path = String(req.url ?? '').split('?')[0];
    return path.replace(/\/([A-Za-z0-9_-]{16,})(?=\/|$)/g, '/…');
  }

  // Запрос со своей страницы. Origin: null браузер присылает, например, при строгой
  // политике реферера — тогда решает Sec-Fetch-Site.
  sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin && origin !== 'null') return origin === this.origin;
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  checkSecret(req) {
    return sameSecret(req.headers['x-gateway-secret'], this.gatewaySecret);
  }

  // Путь запроса относительно пути коннектора или null, если запрос не к нему.
  rest(req) {
    const path = String(req.url ?? '').split('?')[0];
    if (path === this.base) return '';
    if (path.startsWith(`${this.base}/`)) return path.slice(this.base.length);
    return null;
  }

  async onRequest(req, res) {
    const rest = this.rest(req);
    if (rest === null) return text(res, 404, 'Not found');
    if (!this.checkSecret(req)) {
      this.logger.warn(`запрос без секрета шлюза: ${req.method} ${this.safePath(req)}`);
      return text(res, 403, 'Forbidden: requests must come through the gateway');
    }
    const auth = req.headers['x-gateway-auth'];
    if (rest === '' || rest === '/' || rest === '/mcp' || rest === '/mcp/') {
      if (auth !== 'token') return text(res, 401, 'Unauthorized');
      const app = await this.current();
      if (!app) return text(res, 503, 'The connector failed to start with its current settings: the owner can fix them on the settings page');
      return serveMcp(req, res, { mcp: app.mcp, group: String(req.headers['x-gateway-grant'] ?? ''), logger: this.logger });
    }
    if (auth !== 'owner') return text(res, 401, 'Unauthorized: sign in on the gateway first');
    // Страницы меняют настройки и аккаунты: запрос с чужой страницы не пропускаем.
    if (!['GET', 'HEAD'].includes(req.method) && !this.sameOrigin(req)) {
      return text(res, 403, 'Forbidden: cross-origin request');
    }
    if (rest === '/settings') return this.settingsPage(req, res);
    const app = await this.current();
    if (!app) return this.message(res, 503, this.title, `Коннектор не запустился с текущими настройками: ${this.failure}. Исправьте их на странице настроек.`, [{ href: `${this.base}/settings`, text: 'Настройки' }]);
    const route = routeMatch(app.routes, rest);
    if (route) return route.handler(req, res, { rest: rest.slice(route.prefix.length), host: this });
    return text(res, 404, 'Not found');
  }

  onUpgrade(req, socket, head) {
    // Первым делом — обработчик ошибок: без него сброс соединения клиентом роняет процесс.
    socket.on('error', () => {});
    const rest = this.rest(req);
    if (rest === null) return rejectUpgrade(socket, 404, 'Not found');
    if (!this.checkSecret(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    this.current()
      .then((app) => {
        const route = app ? routeMatch(app.upgrades, rest) : null;
        if (!route) return rejectUpgrade(socket, 404, 'Not found');
        return route.handler(req, socket, head, { rest: rest.slice(route.prefix.length), host: this });
      })
      .catch((err) => {
        this.logger.error(`WebSocket ${this.safePath(req)}: ${err?.stack ?? err}`);
        rejectUpgrade(socket, 500, 'Internal error');
      });
  }

  async settingsPage(req, res) {
    const nonce = newNonce();
    const render = (extra = {}) =>
      renderSettingsPage({
        nonce,
        title: this.title,
        fields: this.settings.fields,
        values: this.settings.values,
        fieldOptions: this.fieldOptions,
        problems: this.app ? (this.app.problems ?? []) : [`Коннектор не запустился с этими настройками: ${this.failure}`],
        links: this.links,
        intro: this.intro,
        footer: this.footer,
        ...extra,
      });
    if (req.method === 'GET' || req.method === 'HEAD') {
      const saved = new URL(req.url, this.origin).searchParams.get('saved') === '1';
      res.writeHead(200, pageHeaders(nonce));
      return res.end(req.method === 'HEAD' ? undefined : render({ notice: saved ? 'Настройки сохранены, коннектор перезапущен.' : null }));
    }
    if (req.method !== 'POST') return text(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    if (type !== 'application/x-www-form-urlencoded') return text(res, 415, 'Expected a form');
    const form = new URLSearchParams(await readBody(req, FORM_LIMIT));
    const { values, errors } = this.settings.parseForm(form);
    if (errors.length) {
      res.writeHead(400, pageHeaders(nonce));
      return res.end(render({ errors }));
    }
    this.settings.save(values);
    await this.reload();
    if (!this.app) {
      res.writeHead(500, pageHeaders(nonce));
      // Настройки сохранены, но коннектор с ними не поднялся: причина — в предупреждениях.
      return res.end(render());
    }
    res.writeHead(303, { Location: `${this.base}/settings?saved=1`, 'Cache-Control': 'no-store' });
    return res.end();
  }

  // Простая страница с сообщением (для маршрутов коннектора).
  message(res, status, title, message, links = []) {
    const nonce = newNonce();
    res.writeHead(status, pageHeaders(nonce));
    res.end(renderMessagePage({ nonce, title, text: message, links }));
  }
}

