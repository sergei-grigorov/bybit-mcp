// Коннектор на сервере: настройки из manifest.json, MCP по HTTP за шлюзом (обе эпохи),
// страница настроек, WebSocket оповещений по публичному адресу.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createServer } from '../server/index.js';
import { McpServer, META, MODERN_PROTOCOL_VERSIONS } from '../server/mcp.js';
import { RemoteHost } from '../server/remote/host.js';
import { SettingsStore } from '../server/remote/settings.js';
import { decodeHeaderValue } from '../server/remote/transport.js';
import { silentLogger } from './helpers.js';
import { rawConnect, serverFrames, until } from './ws-client.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const SECRET = 's'.repeat(40);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bybit-remote-'));

function modernMeta(version = MODERN_PROTOCOL_VERSIONS[0]) {
  return { [META.protocolVersion]: version, [META.clientCapabilities]: {}, [META.clientInfo]: { name: 't', version: '1' } };
}

// Хост с игрушечным MCP-сервером: slow — инструмент, который ждёт отмены или ms.
async function startHost({ tools, settingsFile = path.join(tempDir(), 'settings.json'), onCreate = () => {} } = {}) {
  const settings = new SettingsStore({ file: settingsFile, manifest });
  let created = 0;
  const host = new RemoteHost({
    title: 'Test',
    publicUrl: 'http://127.0.0.1:1/bybit',
    gatewaySecret: SECRET,
    settings,
    logger: silentLogger,
    createApp: async (env) => {
      created++;
      onCreate(env);
      return {
        mcp: new McpServer({ info: { name: 'toy', version: '0' }, instructions: 'x', tools: tools ?? [], logger: silentLogger }),
        problems: [],
        close: async () => {},
      };
    },
  });
  const addr = await host.start({ host: '127.0.0.1', port: 0 });
  // Публичный адрес совпадает с адресом хоста: так проверки Origin проходят как за шлюзом.
  host.origin = `http://127.0.0.1:${addr.port}`;
  const base = `http://127.0.0.1:${addr.port}/bybit`;
  return { host, base, settings, created: () => created, close: () => host.stop() };
}

const H = { 'X-Gateway-Secret': SECRET, 'X-Gateway-Auth': 'token', 'X-Gateway-Grant': 'g1', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { ...H, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // не JSON: текст отказа или поток SSE
  }
  return { status: res.status, headers: res.headers, text, json };
}

test('настройки: поля и значения по умолчанию из манифеста, секреты не стираются пустым полем', () => {
  const dir = tempDir();
  const s = new SettingsStore({ file: path.join(dir, 'settings.json'), manifest });
  s.load();
  let env = s.env({}, { BYBIT_TIMEOUT_MS: '2000', BYBIT_DEMO_API_KEY: 'from-process-env' });
  assert.equal(env.BYBIT_RECV_WINDOW, '5000', 'значение по умолчанию из манифеста');
  assert.equal(env.BYBIT_MAINNET_ALLOW_TRADING, 'false');
  assert.equal(env.BYBIT_DEFAULT_ENV, 'auto');
  assert.equal(env.BYBIT_TIMEOUT_MS, '2000', 'прочие переменные процесса сохраняются');
  assert.equal(env.BYBIT_DEMO_API_KEY, undefined, 'поля настроек задаются только страницей');

  const first = s.parseForm(new URLSearchParams({ demo_api_key: 'KEY', demo_api_secret: 'SECRET', recv_window: '6000', mainnet_allow_trading: 'on' }));
  assert.deepEqual(first.errors, []);
  s.save(first.values);
  assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  env = s.env();
  assert.equal(env.BYBIT_DEMO_API_KEY, 'KEY');
  assert.equal(env.BYBIT_RECV_WINDOW, '6000');
  assert.equal(env.BYBIT_MAINNET_ALLOW_TRADING, 'true');

  // Пустое секретное поле — прежнее значение; снятый флажок — false; clear — стереть.
  const second = s.parseForm(new URLSearchParams({ demo_api_key: '', demo_api_secret: '', 'clear:demo_api_secret': 'on', recv_window: '' }));
  assert.equal(second.values.demo_api_key, 'KEY');
  assert.equal(second.values.demo_api_secret, undefined);
  assert.equal(second.values.mainnet_allow_trading, false);
  assert.equal(second.values.recv_window, undefined, 'пусто — значение по умолчанию');
  const bad = s.parseForm(new URLSearchParams({ recv_window: '10' }));
  assert.match(bad.errors[0], /recv_window/);

  const reloaded = new SettingsStore({ file: path.join(dir, 'settings.json'), manifest });
  assert.equal(reloaded.load().demo_api_key, 'KEY');
});

test('HTTP: секрет шлюза, доступ только с токеном, прежняя эпоха без сессии', async () => {
  const h = await startHost({ tools: [{ name: 'echo', inputSchema: { type: 'object' }, handler: async (a) => JSON.stringify(a) }] });
  try {
    assert.equal((await post(h.base, {}, { 'X-Gateway-Secret': 'wrong' })).status, 403);
    assert.equal((await post(h.base, {}, { 'X-Gateway-Auth': 'owner' })).status, 401);
    const init = await post(h.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, '2025-11-25');
    assert.equal(init.headers.get('mcp-session-id'), null, 'сессия не выдаётся');
    assert.equal((await post(h.base, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const get = await fetch(h.base, { headers: H });
    assert.equal(get.status, 405);
    const call = await post(`${h.base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }, { 'MCP-Protocol-Version': '2025-11-25' });
    assert.equal(call.json.result.content[0].text, '{"a":1}');
    assert.equal((await post(h.base, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);
    assert.equal((await post(h.base, 'not json')).status, 400);
    assert.equal((await post(h.base, '{}', { 'Content-Type': 'text/plain' })).status, 415);
    // Неизвестный метод в прежней эпохе — 200 с ошибкой (404 значил бы «сессия истекла»).
    const unknown = await post(h.base, { jsonrpc: '2.0', id: 4, method: 'nope' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.error.code, -32601);
  } finally {
    await h.close();
  }
});

test('HTTP: современная эпоха — заголовки сверяются с _meta, ошибки конверта — 400, неизвестный метод — 404', async () => {
  const h = await startHost();
  try {
    const hdr = { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' };
    const d = await post(h.base, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta() } }, hdr);
    assert.equal(d.status, 200);
    assert.deepEqual(d.json.result.supportedVersions, MODERN_PROTOCOL_VERSIONS);
    const mismatch = await post(h.base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta() } }, { 'MCP-Protocol-Version': '2025-11-25' });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.error.code, -32020);
    const noHeader = await post(h.base, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: modernMeta() } });
    assert.equal(noHeader.json.error.code, -32020);
    const method = await post(h.base, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: modernMeta() } }, { ...hdr, 'Mcp-Method': 'tools/call' });
    assert.equal(method.json.error.code, -32020);
    const version = await post(h.base, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: modernMeta('2099-01-01') } }, { 'MCP-Protocol-Version': '2099-01-01' });
    assert.equal(version.status, 400);
    assert.equal(version.json.error.code, -32022);
    const noMeta = await post(h.base, { jsonrpc: '2.0', id: 6, method: 'server/discover', params: {} }, hdr);
    assert.equal(noMeta.status, 400);
    assert.equal(noMeta.json.error.code, -32602);
    const ping = await post(h.base, { jsonrpc: '2.0', id: 7, method: 'ping', params: { _meta: modernMeta() } }, { 'MCP-Protocol-Version': '2026-07-28' });
    assert.equal(ping.status, 404);
    assert.equal(ping.json.error.code, -32601);
    assert.equal(decodeHeaderValue(`=?base64?${Buffer.from('имя').toString('base64')}?=`), 'имя');
  } finally {
    await h.close();
  }
});

test('HTTP: долгий вызов уходит потоком SSE с пингами; обрыв ответа отменяет вызов', async () => {
  let aborted = false;
  const tools = [
    {
      name: 'slow',
      inputSchema: { type: 'object' },
      handler: (args, { signal }) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve('done'), args.ms);
          signal.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(t);
            resolve('aborted');
          });
        }),
    },
  ];
  const h = await startHost({ tools });
  try {
    const res = await fetch(h.base, {
      method: 'POST',
      headers: { ...H, 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: { ms: 50 } } }),
    });
    assert.equal(res.headers.get('content-type'), 'application/json', 'быстрый ответ — JSON');
    await res.text();

    // Современная эпоха: клиент закрыл ответ — вызов отменён.
    const ctl = new AbortController();
    const pending = fetch(h.base, {
      method: 'POST',
      signal: ctl.signal,
      headers: { ...H, 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: { ms: 5000 }, _meta: modernMeta() } }),
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    ctl.abort();
    await pending;
    await until(() => aborted, 2000);
  } finally {
    await h.close();
  }
});

test('HTTP: переход на SSE, если ответ задерживается', async () => {
  const { serveMcp } = await import('../server/remote/transport.js');
  const http = await import('node:http');
  const mcp = new McpServer({
    info: { name: 'toy', version: '0' },
    instructions: 'x',
    logger: silentLogger,
    tools: [{ name: 'wait', inputSchema: { type: 'object' }, handler: () => new Promise((r) => setTimeout(() => r('late'), 250)) }],
  });
  const server = http.createServer((req, res) => serveMcp(req, res, { mcp, jsonWaitMs: 50, keepAliveMs: 60 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wait', arguments: {} } }),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const text = await res.text();
    assert.match(text, /^:\n\n/, 'поток начинается с комментария');
    assert.ok((text.match(/^:$/gm) ?? []).length >= 2, 'пинги, пока ответ не готов');
    const data = text.split('\n').find((l) => l.startsWith('data: '));
    assert.equal(JSON.parse(data.slice(6)).result.content[0].text, 'late');
  } finally {
    server.close();
  }
});

test('HTTP: subscriptions/listen — поток с подтверждением, закрытие при остановке', async () => {
  const h = await startHost();
  try {
    const res = await fetch(h.base, {
      method: 'POST',
      headers: { ...H, 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'L1', method: 'subscriptions/listen', params: { _meta: modernMeta(), notifications: { toolsListChanged: true } } }),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('acknowledged')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /notifications\/subscriptions\/acknowledged/);
    // Перезапуск с новыми настройками закрывает подписку ответом.
    const app = await h.host.current();
    app.mcp.closeSubscriptions();
    for (let c = await reader.read(); !c.done; c = await reader.read()) text += new TextDecoder().decode(c.value);
    assert.match(text, /"resultType":"complete"/);
  } finally {
    await h.close();
  }
});

test('страница настроек: только владельцу, чужой Origin — отказ, сохранение перезапускает коннектор', async () => {
  const seenEnv = [];
  const h = await startHost({ onCreate: (env) => seenEnv.push(env) });
  const O = { 'X-Gateway-Secret': SECRET, 'X-Gateway-Auth': 'owner' };
  try {
    assert.equal((await fetch(`${h.base}/settings`, { headers: { ...O, 'X-Gateway-Auth': 'token' } })).status, 401);
    const page = await fetch(`${h.base}/settings`, { headers: O });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await page.text();
    assert.match(html, /Демо-счёт: API Key/);
    const submit = (body, origin = h.host.origin) =>
      fetch(`${h.base}/settings`, { method: 'POST', redirect: 'manual', headers: { ...O, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    assert.equal((await submit({ recv_window: '6000' }, 'https://evil.example')).status, 403);
    assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'с no-referrer браузер пришлёт Origin: null');
    const nullOrigin = (site) =>
      fetch(`${h.base}/settings`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...O, Origin: 'null', ...(site ? { 'Sec-Fetch-Site': site } : {}), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'recv_window=6000',
      });
    assert.equal((await nullOrigin()).status, 403);
    assert.equal((await nullOrigin('same-origin')).status, 303);
    const bad = await submit({ recv_window: '5' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /не сохранены/);
    const saved = await submit({ recv_window: '7000', demo_api_key: 'K', demo_api_secret: 'S' });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/bybit/settings?saved=1');
    assert.equal(h.created(), 3, 'коннектор пересоздаётся при каждом сохранении');
    assert.equal(seenEnv.at(-1).BYBIT_RECV_WINDOW, '7000');
    const after = await (await fetch(`${h.base}/settings?saved=1`, { headers: O })).text();
    assert.match(after, /Настройки сохранены/);
    assert.ok(!after.includes('"S"') && !after.includes('value="S"'), 'секрет в страницу не попадает');
    assert.match(after, /задано/);
  } finally {
    await h.close();
  }
});

test('оповещения на сервере: публичный адрес wss, WebSocket через общий HTTP-сервер', async () => {
  const dir = tempDir();
  const settings = new SettingsStore({ file: path.join(dir, 'settings.json'), manifest });
  let alertsRef;
  const host = new RemoteHost({
    title: 'Bybit',
    publicUrl: 'http://127.0.0.1:1/bybit',
    gatewaySecret: SECRET,
    settings,
    logger: silentLogger,
    createApp: async (env) => {
      const { server, alerts } = createServer({ env, fetchImpl: async () => new Response('{}'), alertOptions: { publicUrl: 'https://agent.example.com/bybit' } });
      alertsRef = alerts;
      return {
        mcp: server,
        upgrades: { '/alerts': (req, socket, head, { rest }) => alerts.acceptUpgrade(req, socket, head, `/alerts${rest}`) },
        close: () => alerts.close(),
      };
    },
  });
  const { port } = await host.start({ host: '127.0.0.1', port: 0 });
  try {
    assert.equal(alertsRef.server.url('/alerts/abc'), 'wss://agent.example.com/bybit/alerts/abc');
    // Неизвестный токен: соединение принято и закрыто кодом 4004 с причиной.
    const c = await rawConnect(port, { path: '/bybit/alerts/unknown-token-123', headers: { Host: 'agent.example.com', 'X-Gateway-Secret': SECRET } });
    assert.equal(c.status, 101);
    await until(() => serverFrames(c.data).some((f) => f.opcode === 8));
    const close = serverFrames(c.data).find((f) => f.opcode === 8);
    assert.equal(close.payload.readUInt16BE(0), 4004);
    c.socket.destroy();
    const wrongHost = await rawConnect(port, { path: '/bybit/alerts/x', headers: { Host: `127.0.0.1:${port}`, 'X-Gateway-Secret': SECRET } });
    assert.equal(wrongHost.status, 403);
    const noSecret = await rawConnect(port, { path: '/bybit/alerts/x', headers: { Host: 'agent.example.com' } });
    assert.equal(noSecret.status, 403);
    const browser = await rawConnect(port, { path: '/bybit/alerts/x', headers: { Host: 'agent.example.com', 'X-Gateway-Secret': SECRET, Origin: 'https://evil.example' } });
    assert.equal(browser.status, 403);
    for (const s of [wrongHost, noSecret, browser]) s.socket.destroy();
  } finally {
    await host.stop();
  }
});

test('коннектор не запустился с настройками: страница настроек работает, MCP — 503, исправление возвращает его', async () => {
  const dir = tempDir();
  const settings = new SettingsStore({ file: path.join(dir, 'settings.json'), manifest });
  settings.save({ referer: 'boom' });
  const host = new RemoteHost({
    title: 'Test',
    publicUrl: 'http://127.0.0.1:1/bybit',
    gatewaySecret: SECRET,
    settings,
    logger: silentLogger,
    createApp: async (env) => {
      if (env.BYBIT_REFERER === 'boom') throw new Error('сломанная настройка');
      return { mcp: new McpServer({ info: { name: 'toy', version: '0' }, instructions: 'x', tools: [], logger: silentLogger }), close: async () => {} };
    },
  });
  const { port } = await host.start({ host: '127.0.0.1', port: 0 });
  host.origin = `http://127.0.0.1:${port}`;
  const base = `http://127.0.0.1:${port}/bybit`;
  const O = { 'X-Gateway-Secret': SECRET, 'X-Gateway-Auth': 'owner' };
  try {
    assert.equal((await post(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 503);
    const page = await (await fetch(`${base}/settings`, { headers: O })).text();
    assert.match(page, /не запустился с этими настройками: сломанная настройка/);
    const submit = (body) =>
      fetch(`${base}/settings`, { method: 'POST', redirect: 'manual', headers: { ...O, Origin: host.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    const still = await submit({ referer: 'boom' });
    assert.equal(still.status, 500);
    assert.match(await still.text(), /не запустился с этими настройками: сломанная настройка/);
    assert.equal((await submit({ referer: '' })).status, 303);
    assert.equal((await post(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 200);
  } finally {
    await host.stop();
  }
});
