// Минимальный MCP-сервер (Model Context Protocol) поверх stdio: JSON-RPC 2.0,
// одно сообщение на строку. Поддерживается то, что нужно коннектору с
// инструментами: список и вызов инструментов, отмена запросов.
//
// Сервер понимает обе эпохи протокола:
//   • современную (2026-07-28): рукопожатия нет, каждый запрос несёт версию протокола
//     и возможности клиента в params._meta, сервер обязан отвечать на server/discover,
//     у каждого результата есть resultType, у списков — ttlMs и cacheScope;
//   • прежнюю (2025-11-25 и раньше): сеанс начинается с initialize.
// Клиент, знающий обе (так устроен Claude Desktop), сначала шлёт server/discover
// и переходит на initialize, только если сервер его не понял.

import { createInterface } from 'node:readline';

export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'];
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const NO_RESPONSE = Symbol('no-response');

// Список инструментов зависит от настроек, а настройки меняются только с перезапуском
// сервера. Кешировать ответ клиенту незачем: запрос к локальному процессу ничего не
// стоит, а устаревший список после смены настроек сбил бы модель с толку.
const LIST_TTL_MS = 0;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(expected, v) {
  const t = typeOf(v);
  return [].concat(expected).some((e) => e === t || (e === 'number' && t === 'integer'));
}

function checkSchema(schema, v, path, problems) {
  if (!schema) return;
  if (schema.type && !matchesType(schema.type, v)) {
    problems.push(`${path}: expected ${[].concat(schema.type).join(' or ')}, got ${typeOf(v)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(v)) {
    problems.push(`${path}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) problems.push(`${path}: must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) problems.push(`${path}: must be ≤ ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) problems.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) problems.push(`${path}: at most ${schema.maxItems} items`);
    if (schema.items) v.forEach((item, i) => checkSchema(schema.items, item, `${path}[${i}]`, problems));
  }
  if (typeOf(v) === 'object' && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(v, key) || v[key] === undefined) problems.push(`${path}.${key}: required`);
    }
    for (const [key, val] of Object.entries(v)) {
      const sub = schema.properties[key];
      if (!sub) {
        if (schema.additionalProperties === false) problems.push(`${path}.${key}: unknown argument`);
        continue;
      }
      checkSchema(sub, val, `${path}.${key}`, problems);
    }
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Ключи, которые при присваивании меняют прототип объекта, запрещены на любой глубине.
export function findUnsafeKey(value, path = 'arguments') {
  if (value === null || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) return `${path}.${key}`;
    const nested = findUnsafeKey(child, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

// Модели иногда присылают null вместо пропуска, "5" вместо 5 и "true" вместо true —
// на верхнем уровне аргументов это безопасно поправить.
export function normalizeArgs(schema, args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === null || UNSAFE_KEYS.has(key)) continue;
    const types = [].concat(schema?.properties?.[key]?.type ?? []);
    if (typeof value === 'string' && !types.includes('string')) {
      const t = value.trim();
      if ((types.includes('integer') && /^-?\d+$/.test(t)) || (types.includes('number') && t !== '' && Number.isFinite(Number(t)))) {
        out[key] = Number(t);
        continue;
      }
      if (types.includes('boolean') && /^(true|false)$/i.test(t)) {
        out[key] = t.toLowerCase() === 'true';
        continue;
      }
      if ((types.includes('object') || types.includes('array')) && /^[[{]/.test(t)) {
        try {
          out[key] = JSON.parse(t);
          continue;
        } catch {
          // оставим как есть — проверка схемы объяснит ошибку
        }
      }
    }
    out[key] = value;
  }
  return out;
}

export function validateArgs(schema, args) {
  const problems = [];
  checkSchema(schema, args, 'arguments', problems);
  return problems;
}

// Эпоха запроса: initialize — всегда прежняя; запрос с версией протокола в _meta —
// современная, если версия не из прежних (их список отдаёт и ошибка -32022);
// server/discover есть только в современной (без _meta он неполон).
export function requestEra(method, params) {
  if (method === 'initialize') return 'legacy';
  if (isPlainObject(params?._meta) && Object.hasOwn(params._meta, META.protocolVersion)) {
    return LEGACY_PROTOCOL_VERSIONS.includes(params._meta[META.protocolVersion]) ? 'legacy' : 'modern';
  }
  return method === 'server/discover' ? 'modern' : 'legacy';
}

// Обязательные поля _meta современного запроса.
function checkEnvelope(params) {
  const meta = isPlainObject(params?._meta) ? params._meta : {};
  const requested = meta[META.protocolVersion];
  if (typeof requested !== 'string' || !requested) {
    throw new RpcError(INVALID_PARAMS, `Missing required _meta field ${META.protocolVersion}`);
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(requested)) {
    throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS],
      requested,
    });
  }
  if (!isPlainObject(meta[META.clientCapabilities])) {
    throw new RpcError(INVALID_PARAMS, `Missing required _meta field ${META.clientCapabilities}`);
  }
  return meta;
}

function clientName(info) {
  return isPlainObject(info) ? `${info.name ?? '?'} ${info.version ?? ''}`.trim() : 'unknown client';
}

export class McpServer {
  // unavailable — инструменты, скрытые при текущих настройках: имя → объяснение.
  // Вызов такого инструмента (например, из устаревшего списка у клиента) получает
  // объяснение, а не голую ошибку протокола.
  constructor({ info, instructions, tools, logger, unavailable = new Map() }) {
    this.info = info;
    this.instructions = instructions;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.unavailable = unavailable;
    this.logger = logger;
    this.inflight = new Map();
    this.subscriptions = new Map();
    this.seenModernClients = new Set();
    // Отправка сообщений вне ответа на запрос (подтверждение подписки); start()
    // подключает её к stdout.
    this.emit = () => {};
  }

  get capabilities() {
    return { tools: { listChanged: false } };
  }

  listTools() {
    return [...this.tools.values()].map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      annotations,
    }));
  }

  initialize(params) {
    const requested = params?.protocolVersion;
    const version = LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0];
    this.logger.info(`initialize: ${clientName(params?.clientInfo)}, protocol ${requested} → ${version}`);
    return {
      protocolVersion: version,
      capabilities: this.capabilities,
      serverInfo: this.info,
      instructions: this.instructions,
    };
  }

  discover(meta) {
    const client = clientName(meta[META.clientInfo]);
    if (!this.seenModernClients.has(client)) {
      this.seenModernClients.add(client);
      this.logger.info(`server/discover: ${client}, protocol ${meta[META.protocolVersion]}`);
    }
    return {
      supportedVersions: MODERN_PROTOCOL_VERSIONS,
      capabilities: this.capabilities,
      instructions: this.instructions,
    };
  }

  // Результат современного запроса: resultType, у списков — срок годности кеша,
  // в _meta — кто отвечает.
  modernResult(result, cacheable) {
    const out = { resultType: 'complete', ...result };
    if (cacheable) {
      out.ttlMs = LIST_TTL_MS;
      out.cacheScope = 'private';
    }
    out._meta = { ...(isPlainObject(result._meta) ? result._meta : {}), [META.serverInfo]: this.info };
    return out;
  }

  cancel(requestId) {
    const controller = this.inflight.get(requestId);
    if (controller) controller.abort(new Error('Cancelled by client'));
    const subscription = this.subscriptions.get(requestId);
    if (subscription) {
      this.subscriptions.delete(requestId);
      subscription(NO_RESPONSE);
    }
  }

  // subscriptions/listen. Набор инструментов не меняется, пока работает процесс, поэтому
  // уведомлений не будет: подтверждаем подписку с пустым набором и держим запрос
  // открытым до отмены клиентом или завершения сервера.
  listen(id) {
    this.emit({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: { [META.subscriptionId]: id }, notifications: {} },
    });
    return new Promise((resolve) => this.subscriptions.set(id, resolve));
  }

  // Сервер завершается: подписки закрываются штатно — ответом на исходный запрос.
  // Возвращает их id, чтобы после ответов послать notifications/cancelled (так на stdio
  // сервер сообщает, что поток подписки закрыт).
  closeSubscriptions() {
    const ids = [...this.subscriptions.keys()];
    for (const [id, resolve] of this.subscriptions) resolve({ _meta: { [META.subscriptionId]: id } });
    this.subscriptions.clear();
    return ids;
  }

  async callTool(id, params) {
    const name = params?.name;
    const tool = this.tools.get(name);
    if (!tool) {
      const why = this.unavailable.get(name);
      if (why) return { content: [{ type: 'text', text: why }], isError: true };
      throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const unsafe = findUnsafeKey(params.arguments);
    if (unsafe) {
      return { content: [{ type: 'text', text: `Invalid arguments for ${name}: key ${unsafe} is not allowed` }], isError: true };
    }
    const args = normalizeArgs(tool.inputSchema, params.arguments);
    const problems = validateArgs(tool.inputSchema, args);
    if (problems.length) {
      return {
        content: [{ type: 'text', text: `Invalid arguments for ${name}:\n- ${problems.join('\n- ')}` }],
        isError: true,
      };
    }
    const controller = new AbortController();
    this.inflight.set(id, controller);
    try {
      const out = await tool.handler(args, { signal: controller.signal });
      // Отменённый запрос ответа не получает, даже если обработчик успел закончить.
      if (controller.signal.aborted) return NO_RESPONSE;
      const { text, isError } = typeof out === 'string' ? { text: out, isError: false } : out;
      return { content: [{ type: 'text', text }], isError: Boolean(isError) };
    } catch (err) {
      if (controller.signal.aborted) return NO_RESPONSE;
      const exposed = err?.name === 'ToolError' || err instanceof RpcError;
      if (!exposed) this.logger.error(`tool ${name} failed: ${err?.stack ?? err}`);
      return {
        content: [{ type: 'text', text: exposed ? err.message : `Internal error: ${err?.message ?? err}` }],
        isError: true,
      };
    } finally {
      this.inflight.delete(id);
    }
  }

  // Один разобранный объект JSON-RPC → ответ или null (уведомления ответа не ждут).
  async handle(message) {
    const isObject = isPlainObject(message);
    if (isObject && message.jsonrpc === '2.0' && message.method === undefined && ('result' in message || 'error' in message)) {
      return null; // ответ на наш запрос — мы запросов не шлём
    }
    if (!isObject || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return fail(isObject ? message.id : null, INVALID_REQUEST, 'Invalid Request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined;
    if (isNotification) {
      // Запросы без id — уведомления: ответа на них не будет, поэтому и не выполняем.
      if (method === 'notifications/cancelled') this.cancel(params?.requestId);
      return null;
    }
    const era = requestEra(method, params);
    try {
      const meta = era === 'modern' ? checkEnvelope(params) : undefined;
      let result;
      let cacheable = false;
      switch (method) {
        case 'initialize':
          result = this.initialize(params);
          break;
        case 'server/discover':
          if (era !== 'modern') throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
          result = this.discover(meta);
          cacheable = true;
          break;
        case 'subscriptions/listen':
          if (era !== 'modern') throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
          if (this.inflight.has(id) || this.subscriptions.has(id)) {
            this.logger.warn(`subscriptions/listen with id ${JSON.stringify(id)} ignored: a request with this id is in progress`);
            return null;
          }
          result = await this.listen(id);
          break;
        // В современной эпохе этих методов нет, но ответить на них безвредно.
        case 'ping':
        case 'logging/setLevel':
          result = {};
          break;
        case 'tools/list':
          result = { tools: this.listTools() };
          cacheable = true;
          break;
        case 'tools/call':
          // Ответ с тем же id клиент мог бы принять за ответ на первый вызов.
          if (this.inflight.has(id) || this.subscriptions.has(id)) {
            this.logger.warn(`tools/call with id ${JSON.stringify(id)} ignored: a call with this id is in progress`);
            return null;
          }
          result = await this.callTool(id, params);
          break;
        case 'resources/list':
          result = { resources: [] };
          cacheable = true;
          break;
        case 'resources/templates/list':
          result = { resourceTemplates: [] };
          cacheable = true;
          break;
        case 'prompts/list':
          result = { prompts: [] };
          cacheable = true;
          break;
        default:
          throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
      if (result === NO_RESPONSE) return null;
      return ok(id, era === 'modern' ? this.modernResult(result, cacheable) : result);
    } catch (err) {
      if (err instanceof RpcError) return fail(id, err.code, err.message, err.data);
      this.logger.error(`${method} failed: ${err?.stack ?? err}`);
      return fail(id, INTERNAL_ERROR, err?.message ?? String(err));
    }
  }

  async handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return fail(null, PARSE_ERROR, 'Parse error');
    }
    if (Array.isArray(message)) {
      if (!message.length) return fail(null, INVALID_REQUEST, 'Empty batch');
      const replies = (await Promise.all(message.map((m) => this.handle(m)))).filter(Boolean);
      return replies.length ? replies : null;
    }
    return this.handle(message);
  }

  // Когда вход закрыт, начатые вызовы дорабатывают (до closeGraceMs), чтобы ответы
  // не терялись при работе через канал; затем onClose.
  start({ input = process.stdin, output = process.stdout, onClose, closeGraceMs = 10_000 } = {}) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    const pending = new Set();
    const write = (payload) => {
      if (payload) output.write(`${JSON.stringify(payload)}\n`);
    };
    this.emit = write;
    rl.on('line', (line) => {
      const task = this.handleLine(line)
        .then(write, (err) => this.logger.error(`unhandled: ${err?.stack ?? err}`))
        .finally(() => pending.delete(task));
      pending.add(task);
    });
    rl.on('close', async () => {
      const timer = setTimeout(() => {
        for (const controller of this.inflight.values()) controller.abort(new Error('Client disconnected'));
      }, closeGraceMs);
      const closed = this.closeSubscriptions();
      await Promise.allSettled([...pending]);
      clearTimeout(timer);
      for (const requestId of closed) {
        write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'Server shutting down' } });
      }
      onClose?.();
    });
    return rl;
  }
}
