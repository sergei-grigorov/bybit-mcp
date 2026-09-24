// MCP по HTTP (Streamable HTTP) для коннектора на сервере. Обе эпохи протокола на
// одном адресе и без сессий:
//   • 2026-07-28: каждый запрос — отдельный POST с версией протокола в params._meta и
//     в заголовке MCP-Protocol-Version; GET и DELETE — 405; закрытие ответа клиентом —
//     отмена запроса; subscriptions/listen — поток SSE;
//   • 2025-11-25 и раньше: initialize, затем запросы с заголовком MCP-Protocol-Version;
//     сессия не выдаётся (сервер её не требует), поток GET не предлагается (405).
// Быстрый ответ уходит одним JSON. Если ответ задерживается, открывается поток SSE с
// комментариями-пингами, чтобы прокси по дороге не закрыли соединение по таймауту, и
// ответ приходит в нём. Клиент обязан принимать оба вида.

import { randomUUID } from 'node:crypto';

import {
  INVALID_REQUEST,
  LEGACY_PROTOCOL_VERSIONS,
  META,
  METHOD_NOT_FOUND,
  MODERN_PROTOCOL_VERSIONS,
  PARSE_ERROR,
  requestEra,
} from '../mcp.js';

// Заголовки запроса не совпадают с его телом (MCP-Protocol-Version, Mcp-Method, Mcp-Name).
export const HEADER_MISMATCH = -32020;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const JSON_WAIT_MS = 10_000;
const KEEPALIVE_MS = 20_000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function accepted(res) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(202, { 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Значение заголовка Mcp-Name может прийти в виде «=?base64?…?=» (не-ASCII имена).
export function decodeHeaderValue(value) {
  const m = /^=\?base64\?(.*)\?=$/i.exec(value);
  if (!m) return value;
  try {
    return Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return value;
  }
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Проверка заголовков запроса современной эпохи: заголовок MCP-Protocol-Version обязан
// повторять версию из _meta. Запрос без версии в _meta и версию, которую сервер не
// знает, разбирает сам McpServer (-32602 и -32022 со списком поддерживаемых версий).
function checkModernHeaders(req, message) {
  const version = message.params?._meta?.[META.protocolVersion];
  if (typeof version !== 'string' || !version) return null;
  const headerVersion = header(req, 'mcp-protocol-version');
  if (!headerVersion) return 'Missing MCP-Protocol-Version header';
  if (headerVersion !== version) return `MCP-Protocol-Version header (${headerVersion}) does not match _meta (${version})`;
  if (!MODERN_PROTOCOL_VERSIONS.includes(version)) return null;
  const method = header(req, 'mcp-method');
  if (method !== undefined && method !== message.method) return `Mcp-Method header (${method}) does not match the method (${message.method})`;
  const name = header(req, 'mcp-name');
  if (name !== undefined && ['tools/call', 'prompts/get', 'resources/read'].includes(message.method)) {
    const expected = message.method === 'resources/read' ? message.params?.uri : message.params?.name;
    if (decodeHeaderValue(name) !== expected) return 'Mcp-Name header does not match the request';
  }
  return null;
}

// Ответ на один запрос: JSON, пока не пришлось открыть поток SSE.
class Reply {
  constructor(res, keepAliveMs) {
    this.res = res;
    this.keepAliveMs = keepAliveMs;
    this.sse = false;
    this.timer = null;
  }

  get closed() {
    return this.res.destroyed || this.res.writableEnded;
  }

  stream() {
    if (this.sse || this.closed) return;
    this.sse = true;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders?.();
    this.res.write(':\n\n');
    this.timer = setInterval(() => {
      if (!this.closed) this.res.write(':\n\n');
    }, this.keepAliveMs);
    this.timer.unref?.();
  }

  event(message) {
    this.stream();
    if (!this.closed) this.res.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  finish(message, status = 200) {
    clearInterval(this.timer);
    if (this.closed) return;
    if (this.sse) {
      if (message) this.res.write(`data: ${JSON.stringify(message)}\n\n`);
      this.res.end();
    } else if (message) {
      sendJson(this.res, status, message);
    } else {
      accepted(this.res);
    }
  }
}

// Статус HTTP для ответа с ошибкой: ошибки конверта (2026-07-28) — 400, неизвестный
// метод в современной эпохе — 404; остальное — 200 с ошибкой JSON-RPC внутри
// (в прежней эпохе 404 означал бы «сессия истекла»).
function statusOf(reply, era) {
  if (!reply?.error) return 200;
  if (reply.httpStatus) return reply.httpStatus;
  if (era === 'modern' && reply.error.code === METHOD_NOT_FOUND) return 404;
  return 200;
}

// group — клиент (например, выданный шлюзом доступ): уведомление notifications/cancelled
// отменяет только его запросы.
export async function serveMcp(req, res, { mcp, group = '', logger, maxBodyBytes = MAX_BODY_BYTES, jsonWaitMs = JSON_WAIT_MS, keepAliveMs = KEEPALIVE_MS }) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'POST', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.method !== 'POST') {
    req.resume();
    return sendJson(res, 405, rpcError(null, -32000, 'Method not allowed: this MCP endpoint accepts POST only (no SSE stream on GET)'), { Allow: 'POST' });
  }
  const type = String(header(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    req.resume();
    return sendJson(res, 415, rpcError(null, -32000, 'Content-Type must be application/json'));
  }
  let text;
  try {
    text = await readBody(req, maxBodyBytes);
  } catch (err) {
    return sendJson(res, err.status ?? 400, rpcError(null, -32000, err.message));
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return sendJson(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'));
  }

  // Пачка — только у клиентов 2025-03-26.
  if (Array.isArray(message)) {
    if (!message.length) return sendJson(res, 400, rpcError(null, INVALID_REQUEST, 'Empty batch'));
    const ctx = { scope: randomUUID(), group };
    const replies = (await Promise.all(message.map((m) => mcp.handle(m, ctx)))).filter(Boolean);
    return replies.length ? sendJson(res, 200, replies) : accepted(res);
  }
  if (!isPlainObject(message) || message.jsonrpc !== '2.0') return sendJson(res, 400, rpcError(message?.id, INVALID_REQUEST, 'Invalid Request'));
  // Ответ клиента на наш запрос (мы запросов не шлём) или уведомление — 202 без тела.
  if (message.method === undefined) return accepted(res);
  if (message.id === undefined) {
    await mcp.handle(message, { scope: randomUUID(), group });
    return accepted(res);
  }

  const era = requestEra(message.method, message.params);
  if (era === 'modern') {
    const problem = checkModernHeaders(req, message);
    if (problem) return sendJson(res, 400, rpcError(message.id, HEADER_MISMATCH, problem));
  } else {
    const v = header(req, 'mcp-protocol-version');
    if (v !== undefined && ![...LEGACY_PROTOCOL_VERSIONS, ...MODERN_PROTOCOL_VERSIONS].includes(v)) {
      return sendJson(res, 400, rpcError(message.id, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${v}`, { supported: LEGACY_PROTOCOL_VERSIONS }));
    }
  }

  const reply = new Reply(res, keepAliveMs);
  const ctx = { scope: randomUUID(), group, emit: (m) => reply.event(m) };
  let finished = false;
  // В современной эпохе закрытие ответа клиентом — отмена запроса. В прежней обрыв
  // соединения отменой не считается: вызов доработает, ответ пропадёт.
  res.on('close', () => {
    if (finished || res.writableEnded) return;
    clearInterval(reply.timer);
    if (era === 'modern') mcp.cancel(message.id, ctx);
  });
  if (message.method === 'subscriptions/listen' && era === 'modern') reply.stream();
  const waiting = setTimeout(() => reply.stream(), jsonWaitMs);
  waiting.unref?.();
  let out;
  try {
    out = await mcp.handle(message, ctx);
  } catch (err) {
    logger?.error(`MCP ${message.method}: ${err?.stack ?? err}`);
    out = rpcError(message.id, -32603, 'Internal error');
  } finally {
    clearTimeout(waiting);
    finished = true;
  }
  reply.finish(out, statusOf(out, era));
}
