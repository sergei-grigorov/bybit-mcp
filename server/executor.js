// Выполнение вызовов: разбор пути, проверка уровня доступа и настроек,
// подпись, постраничный вывод, упаковка ответа.

import { randomBytes } from 'node:crypto';

import { TIER_TOOL } from './catalog.js';
import { accessBlockers, accessSummary, ENV_NAMES, keyProblem, maskKey, settingRef, SETTINGS_PATH } from './config.js';
import { fitJson } from './format.js';
import { mergeParamSchemas, prepareParams } from './params.js';
import { BybitError, HTTP_STATUS_HINTS, isV5Path, RET_CODE_HINTS, RestClient } from './rest.js';
import { NAME, VERSION } from './version.js';
import { CHANNELS, collectStream, streamUrl } from './ws.js';

// Ошибка, которую нужно показать модели как результат инструмента (isError).
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

// Ответ должен успеть до таймаута клиента (в MCP SDK по умолчанию 60 с).
const CALL_BUDGET_MS = 45_000;
const MIN_PAGE_BUDGET_MS = 5_000;
const STATUS_TIMEOUT_MS = 8_000;
export const STREAM_LIMITS = { maxSeconds: 30, maxMessages: 2000, maxDepth: 1000 };

// После таких ответов на изменяющий запрос неизвестно, выполнила ли его биржа.
const UNKNOWN_OUTCOME =
  'The outcome is unknown: Bybit may or may not have executed this request. Check the actual state first ' +
  '(the order by orderLinkId, open orders, transfer or withdrawal records) and do not repeat the request blindly.';
const UNKNOWN_OUTCOME_CODES = new Set([10000, 10016]);
// HTTP-статусы, при которых запрос отклонён до исполнения.
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 405, 429]);

// Методы, где коннектор сам задаёт orderLinkId, если его не передали: по нему можно
// найти ордер, если ответ потерялся, а повтор с тем же id Bybit отклонит.
const ORDER_LINK_ID_PATHS = new Set(['/v5/order/create', '/v5/order/create-batch', '/v5/spread/order/create']);

const DCP_TOPIC = /^dcp(\.|$)/i;

export function newOrderLinkId() {
  return `mcp-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Параметр курсора у метода: почти везде cursor, у списков субаккаунтов — nextCursor.
function cursorParamOf(entries) {
  if (!entries.length) return 'cursor';
  const names = new Set(entries.flatMap((e) => e.params.map((p) => p.name)));
  if (names.has('cursor')) return 'cursor';
  if (names.has('nextCursor')) return 'nextCursor';
  return null;
}

// Курсор следующей страницы в ответе; "" и "0" — страниц больше нет.
function nextCursorOf(result) {
  if (!isPlainObject(result)) return null;
  for (const key of ['nextPageCursor', 'nextCursor']) {
    const v = result[key];
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v);
      return { key, value: s && s !== '0' ? s : null };
    }
  }
  return null;
}

// Поле-список в ответе: list, а если его нет — единственный массив (rows, records…).
function listKeyOf(result) {
  if (!isPlainObject(result)) return null;
  const arrays = Object.keys(result).filter((k) => Array.isArray(result[k]));
  if (arrays.includes('list')) return 'list';
  return arrays.length === 1 ? arrays[0] : null;
}

// Код проверки ботов: успех — *SUCCESS*, а также *_UNSPECIFIED (его Bybit
// показывает в примерах успешного создания); провал — явные коды вроде *_TOO_LOW.
function checkCodeFailed(code) {
  return typeof code === 'string' && code !== '' && !/SUCCESS/i.test(code) && !/UNSPECIFIED$/i.test(code);
}

// Ошибки отдельных элементов при retCode 0: пакетные ордера (retExtInfo.list)
// и боты (result.status_code: 0 или 200 — успех; result.check_code — см. выше).
function itemErrorsOf(json) {
  const errors = [];
  const ext = json?.retExtInfo?.list;
  if (Array.isArray(ext)) {
    ext.forEach((item, index) => {
      if (isPlainObject(item) && item.code !== undefined && Number(item.code) !== 0) {
        errors.push({ index, code: item.code, msg: item.msg });
      }
    });
  }
  const r = json?.result;
  if (isPlainObject(r)) {
    if (r.status_code !== undefined && r.status_code !== null && ![0, 200].includes(Number(r.status_code))) {
      errors.push({ field: 'result.status_code', code: r.status_code, msg: r.debug_msg || undefined });
    }
    if (checkCodeFailed(r.check_code)) {
      errors.push({ field: 'result.check_code', code: r.check_code, msg: r.debug_msg || undefined });
    }
  }
  return errors;
}

// Обрезанный список делает курсор опасным: он указывает за конец полного списка,
// и переход по нему пропустит выброшенные записи.
function dropCursorOnTruncation(clone, truncated) {
  const r = clone?.result;
  const key = listKeyOf(r);
  if (!key || !truncated.some((t) => t.path === `result.${key}`)) return undefined;
  let removed = false;
  for (const ck of ['nextPageCursor', 'nextCursor']) {
    if (typeof r[ck] === 'string' && r[ck] && r[ck] !== '0') {
      r[ck] = null;
      removed = true;
    }
  }
  return removed
    ? 'The page cursor was removed because following it would skip the omitted items. Repeat the request with a ' +
        'smaller "limit" (or a narrower time range) so that each page fits, then page with the cursor.'
    : undefined;
}

export class Executor {
  constructor({ config, catalog, logger, fetchImpl, WebSocketImpl }) {
    this.config = config;
    this.catalog = catalog;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.clients = {};
    for (const name of ENV_NAMES) {
      this.clients[name] = new RestClient(config.envs[name], {
        recvWindow: config.recvWindow,
        timeoutMs: config.timeoutMs,
        referer: config.referer,
        fetchImpl,
        logger,
      });
    }
  }

  resolveEnv(env) {
    const name = env ?? this.config.defaultEnv;
    if (!ENV_NAMES.includes(name)) throw new ToolError(`env must be "mainnet" or "demo", got "${env}"`);
    return name;
  }

  noKeysMessage(envName) {
    const client = this.clients[envName];
    const [keyField, secretField] = envName === 'demo' ? ['demoKey', 'demoSecret'] : ['mainnetKey', 'mainnetSecret'];
    if (client.keyError) return `${envName}: ${client.keyError}. Check ${settingRef(secretField)} in ${SETTINGS_PATH}.`;
    const account = envName === 'demo' ? 'the Demo Trading account (api-demo.bybit.com)' : 'the real account (api.bybit.com)';
    const other = ENV_NAMES.find((n) => n !== envName && this.config.envs[n].hasKeys);
    return (
      `No API key configured for ${account}. The user can add it in ${SETTINGS_PATH}: fields ${settingRef(keyField)} ` +
      `and ${settingRef(secretField)}. Public market data works without keys.` +
      (other ? ` The ${other} account has an API key: pass env="${other}" to use it.` : '')
    );
  }

  // На каких счетах метод каталога можно вызвать при текущих настройках, а на каких
  // нельзя и почему: для описания метода и подсказок.
  availability(entry) {
    const ok = [];
    const blocked = [];
    for (const name of ENV_NAMES) {
      const e = this.config.envs[name];
      let reason = null;
      if (entry.envs && !entry.envs.includes(name)) reason = 'the endpoint does not exist there';
      else if ((entry.auth === 'private' || entry.tier !== 'read') && !e.hasKeys) reason = keyProblem(e);
      else if (entry.tier === 'trade' && !e.allowTrade) reason = `switch ${settingRef('trade')} is off`;
      else if ((entry.tier === 'funds' || entry.movesFunds) && !e.allowFunds) reason = `switch ${settingRef('funds')} is off`;
      if (reason) blocked.push(`${name}: ${reason}`);
      else ok.push(name);
    }
    return { ok, blocked };
  }

  // Если инструмент уровня tier скрыт при текущих настройках — почему (иначе null).
  tierBlocker(tier) {
    if (tier === 'read') return null;
    const access = accessSummary(this.config);
    return access[tier].length ? null : accessBlockers(this.config, tier);
  }

  // Какой инструмент выполняет уровень tier — или почему он сейчас недоступен.
  toolHint(tier) {
    const blocker = this.tierBlocker(tier);
    if (!blocker) return `call it with ${TIER_TOOL[tier]}`;
    return (
      `it needs ${TIER_TOOL[tier]}, which is not available with the current settings (${blocker}); ` +
      `the user can change this in ${SETTINGS_PATH}`
    );
  }

  // Принимает "/v5/order/create", "POST /v5/order/create", полный URL, путь с
  // ?query или id из каталога ("order/create-order"). Хост из URL игнорируется:
  // запрос всегда идёт на адрес выбранного контура.
  parseTarget(pathInput, methodInput) {
    let s = String(pathInput ?? '').trim();
    let method = methodInput ? String(methodInput).toUpperCase() : undefined;
    const prefixed = s.match(/^(GET|POST)\s+(\S+)$/i);
    if (prefixed) {
      const m = prefixed[1].toUpperCase();
      if (method && method !== m) throw new ToolError(`method "${method}" conflicts with "${prefixed[1]}" in path`);
      method = m;
      s = prefixed[2];
    }
    if (/^https?:\/\//i.test(s)) {
      const url = new URL(s);
      s = url.pathname + url.search;
    }
    let query = {};
    const q = s.indexOf('?');
    if (q >= 0) {
      query = Object.fromEntries(new URLSearchParams(s.slice(q + 1)));
      s = s.slice(0, q);
    }
    s = s.replace(/\/+$/, '');
    if (!s.startsWith('/v5/')) {
      const byId = this.catalog.get(s.replace(/^\//, ''));
      if (byId) {
        s = byId.path;
        method ??= byId.method;
      } else if (/^\/?v5\//.test(s)) {
        s = `/${s.replace(/^\//, '')}`;
      }
    }
    if (!isV5Path(s)) {
      throw new ToolError(
        `"${pathInput}" is not a Bybit V5 path. Use a path like /v5/market/tickers or an id from bybit_search_endpoints.`,
      );
    }
    if (method && !['GET', 'POST'].includes(method)) throw new ToolError(`unsupported HTTP method ${method}`);
    // Путь в другом регистре — тот же метод каталога и тот же уровень доступа.
    if (!this.catalog.lookup(s).length) {
      const alt = this.catalog.lookupIgnoreCase(s);
      if (alt.length) s = alt[0].path;
    }
    const all = this.catalog.lookup(s);
    if (method && all.length && !all.some((e) => e.method === method)) {
      throw new ToolError(`${s} is a ${all[0].method} endpoint, not ${method}.`);
    }
    method ??= all[0]?.method;
    return { path: s, method, query, entries: all.filter((e) => e.method === method) };
  }

  // needs — уровни, которые должны быть разрешены: {'read'} | {'trade'} | {'funds'} | оба.
  checkAccess(envName, needs, why) {
    const envCfg = this.config.envs[envName];
    const missing = [];
    if (needs.has('trade') && !envCfg.allowTrade) missing.push('trade');
    if (needs.has('funds') && !envCfg.allowFunds) missing.push('funds');
    if (!missing.length) return;
    const demoNote = this.config.envs.demo.hasKeys
      ? 'On the Demo Trading account (env="demo") everything is allowed.'
      : `On the Demo Trading account (env="demo") everything is allowed once its API key is added (${settingRef('demoKey')}).`;
    if (needs.has('trade') && needs.has('funds')) {
      throw new ToolError(
        `${why} needs both mainnet switches: ${settingRef('trade')} and ${settingRef('funds')}. ` +
          `Currently disabled: ${missing.map((m) => settingRef(m)).join(' and ')}. ` +
          `The user can change them in ${SETTINGS_PATH}. ${demoNote}`,
      );
    }
    if (missing[0] === 'trade') {
      throw new ToolError(
        `Trading on ${envName} is disabled in the connector settings (off by default). ` +
          `The user can enable it with the switch ${settingRef('trade')} in ${SETTINGS_PATH}. ${demoNote}`,
      );
    }
    throw new ToolError(
      `Fund operations (transfers, withdrawals, conversions, loans, earn, sub-accounts, API keys) on ${envName} are disabled ` +
        `in the connector settings. The user can enable them with the switch ${settingRef('funds')} in ${SETTINGS_PATH}. ${demoNote}`,
    );
  }

  // Возвращает список сгенерированных id (для текста ошибки при сбое сети).
  fillOrderLinkIds(path, schema, params, notes) {
    const generated = [];
    if (path === '/v5/order/create-batch') {
      const supported = schema.find((p) => p.name === 'request')?.children?.some((c) => c.name === 'orderLinkId');
      if (!supported || !Array.isArray(params.request)) return;
      params.request.forEach((item, i) => {
        if (isPlainObject(item) && !item.orderLinkId) {
          item.orderLinkId = newOrderLinkId();
          generated.push(`request[${i}]: ${item.orderLinkId}`);
        }
      });
    } else if (schema.some((p) => p.name === 'orderLinkId') && !params.orderLinkId) {
      params.orderLinkId = newOrderLinkId();
      generated.push(params.orderLinkId);
    }
    if (generated.length) {
      notes.push(`orderLinkId generated by the connector (use it to look the order up): ${generated.join(', ')}`);
    }
    return generated;
  }

  // tool: 'read' | 'trade' | 'funds' — через какой инструмент пришёл вызов.
  async call({ tool, path, method, params, env, paginate = false, maxPages = 5, auth = 'auto', skipValidation = false, allowUnknownParams = false, signal }) {
    if (params !== undefined && params !== null && !isPlainObject(params)) throw new ToolError('params must be a JSON object');
    const target = this.parseTarget(path, method);
    let envName = this.resolveEnv(env);
    const known = target.entries.length > 0;
    const entry = target.entries[0];
    const httpMethod = target.method ?? (tool === 'read' ? 'GET' : 'POST');
    const tier = known ? entry.tier : httpMethod === 'GET' ? 'read' : 'funds';
    // Открытые данные одинаковы на обоих контурах, но Demo Trading обещает только
    // рыночные. Если счёт не назван, открытый метод вне списка демо-сервиса идёт на
    // mainnet — без подписи, чтобы не задействовать ключ счёта, о котором не просили.
    let routedToMainnet = false;
    if (env === undefined && envName === 'demo' && tool === 'read' && known && entry.auth !== 'private' && !entry.demo) {
      envName = 'mainnet';
      routedToMainnet = true;
    }

    if (!known && tool === 'trade') {
      throw new ToolError(
        `${httpMethod} ${target.path} is not in the endpoint catalog. Find the right path with bybit_search_endpoints; ` +
          'write endpoints missing from the catalog can only be called through bybit_funds, and on mainnet they need ' +
          'both the trading and the fund-operations switches.',
      );
    }
    if (tier !== tool) {
      throw new ToolError(`${httpMethod} ${target.path} is a "${tier}" endpoint — ${this.toolHint(tier)}.`);
    }
    if (entry?.envs && !entry.envs.includes(envName)) {
      throw new ToolError(`${httpMethod} ${target.path} works only with env="${entry.envs.join('" or "')}".`);
    }
    // Неизвестный POST может оказаться чем угодно, а создание бота и переводит
    // средства, и торгует: для них нужны оба переключателя.
    const needs = new Set([tier]);
    let why = '';
    if (!known && httpMethod !== 'GET') {
      needs.add('trade');
      why = `${httpMethod} ${target.path} is not in the catalog, so it`;
    } else if (entry?.movesFunds) {
      needs.add('funds');
      why = `${httpMethod} ${target.path} moves funds to a trading bot and`;
    }
    this.checkAccess(envName, needs, why);

    const client = this.clients[envName];
    const authMode = auth && auth !== 'auto' ? auth : known ? entry.auth : 'private';
    let sign = false;
    if (authMode === 'optional') sign = client.canSign && !routedToMainnet;
    else if (authMode === 'private') {
      if (!client.canSign) throw new ToolError(this.noKeysMessage(envName));
      sign = true;
    }

    const input = { ...target.query, ...(params ?? {}) };
    const notes = [];
    if (routedToMainnet) {
      notes.push('Demo Trading does not list this public endpoint, so it was served from mainnet (public data is the same)');
    }
    const schema = known ? (target.entries.length > 1 ? mergeParamSchemas(target.entries.map((e) => e.params)) : entry.params) : [];
    let prepared = input;
    if (known && !skipValidation) {
      const res = prepareParams(schema, input, {
        method: httpMethod,
        strictUnknown: tier !== 'read' && !allowUnknownParams,
      });
      if (res.errors.length) {
        throw new ToolError(
          `Invalid parameters for ${httpMethod} ${target.path}:\n- ${res.errors.join('\n- ')}\n` +
            'See bybit_describe_endpoint for the parameter list. If the catalog is outdated, retry with ' +
            (tier === 'read' ? 'skip_validation=true.' : 'allow_unknown_params=true (unknown names) or skip_validation=true.'),
        );
      }
      prepared = res.params;
      notes.push(...res.warnings.map((w) => `warning: ${w}`));
    }
    if (!known) notes.push('endpoint is not in the local catalog; parameters were sent without validation');
    if (known && entry.deprecated) notes.push('endpoint is marked deprecated in Bybit docs');
    const generatedIds =
      tier === 'trade' && ORDER_LINK_ID_PATHS.has(target.path) ? this.fillOrderLinkIds(target.path, schema, prepared, notes) : [];

    const pages = [];
    let pageParams = prepared;
    const wantPages = paginate && tool === 'read';
    const cursorParam = cursorParamOf(target.entries);
    if (wantPages && !cursorParam) notes.push('this endpoint has no cursor pagination; a single page was returned');
    const limit = wantPages && cursorParam ? Math.round(clampNumber(maxPages, 1, 50, 5)) : 1;
    const seen = new Set();
    if (cursorParam && pageParams[cursorParam]) seen.add(String(pageParams[cursorParam]));
    const deadline = Date.now() + CALL_BUDGET_MS;
    let listKey;
    for (let page = 1; page <= limit; page++) {
      let res;
      try {
        res = await client.request({
          method: httpMethod,
          path: target.path,
          params: pageParams,
          sign,
          signal,
          budgetMs: deadline - Date.now(),
        });
      } catch (err) {
        if (!(err instanceof BybitError)) throw err;
        if (pages.length) {
          notes.push(`pagination stopped at page ${page}: ${err.message}`);
          break;
        }
        const ids = generatedIds.length ? `\norderLinkId generated for this request: ${generatedIds.join(', ')}` : '';
        throw new ToolError(`${err.message}${ids}`);
      }
      pages.push(res);
      if (page === limit || res.json?.retCode !== 0) break;
      const result = res.json?.result;
      const next = nextCursorOf(result);
      const key = listKeyOf(result);
      if (page === 1) listKey = key;
      if (!next?.value || !key || key !== listKey || seen.has(next.value)) break;
      if (deadline - Date.now() < MIN_PAGE_BUDGET_MS) {
        notes.push(`pagination stopped after ${page} pages to answer in time; continue from the cursor in result`);
        break;
      }
      seen.add(next.value);
      pageParams = { ...pageParams, [cursorParam]: next.value };
    }

    const out = this.shape(pages, { envName, entry, tier, notes });
    return { text: fitJson(out.body, this.config.maxOutputChars, dropCursorOnTruncation), isError: out.isError };
  }

  shape(pages, { envName, entry, tier, notes }) {
    const first = pages[0];
    const last = pages[pages.length - 1];
    // «Исход неизвестен» имеет смысл только для методов, которые что-то меняют.
    const isWrite = tier !== 'read';
    const body = { env: envName, request: `${first.method} ${first.path}` };
    for (const p of pages) notes.push(...p.notes);
    if (!first.json) {
      body.httpStatus = first.httpStatus;
      const text = (first.text ?? '').trim();
      body.error = text ? 'Response is not JSON' : 'Empty response';
      if (text) body.body = text.slice(0, 500);
      if (HTTP_STATUS_HINTS[first.httpStatus]) body.hint = HTTP_STATUS_HINTS[first.httpStatus];
      if (isWrite && !REJECTED_STATUSES.has(first.httpStatus)) body.outcome = UNKNOWN_OUTCOME;
      if (first.traceId) body.traceId = first.traceId;
      if (notes.length) body.notes = notes;
      return { body, isError: true };
    }
    const json = first.json;
    const retCode = json.retCode ?? json.ret_code;
    body.retCode = retCode;
    body.retMsg = json.retMsg ?? json.ret_msg;
    let result = json.result;
    if (pages.length > 1) {
      const okPages = pages.filter((p) => p.json?.retCode === 0);
      const key = listKeyOf(result);
      const lastResult = okPages[okPages.length - 1].json.result;
      // Курсор — только с последней страницы: курсор первой снова вернул бы вторую.
      const { nextPageCursor, nextCursor, ...rest } = result;
      result = { ...rest, [key]: okPages.flatMap((p) => p.json.result?.[key] ?? []) };
      const next = nextCursorOf(lastResult);
      if (next) result[next.key] = lastResult[next.key];
      body.pages = pages.length;
      const failed = pages.find((p) => p.json?.retCode !== 0);
      if (failed) notes.push(`page ${pages.indexOf(failed) + 1} failed: ${failed.json?.retCode} ${failed.json?.retMsg}`);
    }
    body.result = result;
    if (json.retExtInfo && Object.keys(json.retExtInfo).length) body.retExtInfo = json.retExtInfo;
    if (json.time !== undefined) body.time = json.time;
    if (last.rateLimit) body.rateLimit = last.rateLimit;

    let isError = retCode !== 0 || first.httpStatus >= 400;
    const itemErrors = isError ? [] : itemErrorsOf(json);
    if (itemErrors.length) {
      body.itemErrors = itemErrors;
      if (tier === 'read') {
        notes.push('the response reports a failed check (see itemErrors)');
      } else {
        const batch = Array.isArray(json.retExtInfo?.list) ? json.retExtInfo.list.length : 0;
        const failedItems = itemErrors.filter((e) => e.index !== undefined).length;
        const allFailed = itemErrors.some((e) => e.field) || (batch > 0 && failedItems === batch);
        isError = allFailed;
        notes.push(
          allFailed
            ? 'Bybit accepted the request but reports a failure (see itemErrors). Before retrying, check whether the ' +
                'order or bot exists (e.g. open orders or the bot detail endpoint).'
            : `${failedItems} of ${batch} items failed (see itemErrors); the other items were executed.`,
        );
      }
    }
    if (retCode !== 0 || first.httpStatus >= 400) {
      const hint = RET_CODE_HINTS[retCode] ?? HTTP_STATUS_HINTS[first.httpStatus];
      if (hint) body.hint = hint;
      if (isWrite && (UNKNOWN_OUTCOME_CODES.has(retCode) || (first.httpStatus >= 500 && !REJECTED_STATUSES.has(first.httpStatus)))) {
        body.outcome = UNKNOWN_OUTCOME;
      }
      if (first.traceId) body.traceId = first.traceId;
      if (envName === 'demo' && entry && !entry.demo) {
        notes.push("this endpoint is not in Bybit's list of Demo Trading endpoints, so api-demo.bybit.com may not support it");
      }
    }
    if (notes.length) body.notes = notes;
    return { body, isError };
  }

  async stream({ env, channel, topics, durationSeconds = 5, maxMessages = 100, mode = 'summary', depth = 25, signal }) {
    if (!CHANNELS.includes(channel)) throw new ToolError(`channel must be one of: ${CHANNELS.join(', ')}`);
    const envName = this.resolveEnv(env);
    const envCfg = this.config.envs[envName];
    const cleanTopics = [...new Set((Array.isArray(topics) ? topics : []).map((t) => String(t).trim()).filter(Boolean))];
    if (!cleanTopics.length) throw new ToolError('topics must contain at least one topic, e.g. "tickers.BTCUSDT"');
    if (cleanTopics.some((t) => DCP_TOPIC.test(t))) {
      throw new ToolError(
        'dcp topics are refused: a dcp subscription arms Disconnect Cancel All for this connection, and closing it after ' +
          'the snapshot can make Bybit cancel all active orders. Read DCP settings with bybit_read GET /v5/account/query-dcp-info.',
      );
    }
    let auth = null;
    if (channel === 'private') {
      const client = this.clients[envName];
      if (!client.canSign) throw new ToolError(this.noKeysMessage(envName));
      await client.ensureTime(signal);
      auth = { apiKey: envCfg.apiKey, signer: client.signer, serverNow: () => client.serverNow() };
    }
    const url = streamUrl(envCfg, channel);
    let res;
    try {
      res = await collectStream({
        url,
        topics: cleanTopics,
        auth,
        durationMs: Math.round(clampNumber(durationSeconds, 1, STREAM_LIMITS.maxSeconds, 5) * 1000),
        maxMessages: Math.round(clampNumber(maxMessages, 1, STREAM_LIMITS.maxMessages, 100)),
        mode: mode === 'raw' ? 'raw' : 'summary',
        depth: Math.round(clampNumber(depth, 1, STREAM_LIMITS.maxDepth, 25)),
        signal,
        WebSocketImpl: this.WebSocketImpl,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ToolError(err.message);
    }
    const body = { env: envName, channel, ...res };
    if (envName === 'demo' && channel !== 'private') {
      body.note = 'Demo Trading has no separate public streams; this is the mainnet public stream.';
    }
    const isError = Boolean(res.subscribeErrors?.length) && res.received === 0;
    return { text: fitJson(body, this.config.maxOutputChars), isError };
  }

  async status({ checkKeys = false, signal } = {}) {
    const out = {
      server: { name: NAME, version: VERSION, node: process.version },
      catalog: {
        endpoints: this.catalog.endpoints.length,
        docsCommit: this.catalog.source.commit,
        docsDate: this.catalog.source.committedAt,
      },
      defaultEnv: this.config.defaultEnv,
      defaultEnvSource: this.config.defaultEnvSource,
      recvWindowMs: this.config.recvWindow,
      // Где что доступно: счета с ключами и счета, где разрешены торговля и операции со средствами.
      access: accessSummary(this.config),
      settings: SETTINGS_PATH,
      envs: {},
    };
    if (this.config.problems.length) out.configProblems = this.config.problems;
    const infos = await Promise.all(
      ENV_NAMES.map(async (name) => {
        const cfg = this.config.envs[name];
        const client = this.clients[name];
        const info = {
          rest: cfg.restUrl,
          publicStream: cfg.publicStreamUrl,
          privateStream: cfg.privateStreamUrl,
          apiKey: maskKey(cfg.apiKey),
          keyType: client.signer?.type ?? null,
          read: true,
          trade: cfg.allowTrade,
          funds: cfg.allowFunds,
        };
        if (client.keyError) info.keyError = client.keyError;
        if (checkKeys) {
          try {
            const t = await client.syncTime(signal, STATUS_TIMEOUT_MS);
            info.clock = { offsetMs: t.offsetMs, rttMs: t.rttMs };
          } catch (err) {
            if (signal?.aborted) throw err;
            info.clock = { error: err.message };
          }
          if (client.canSign) info.key = await this.keyInfo(client, signal);
        }
        return [name, info];
      }),
    );
    out.envs = Object.fromEntries(infos);
    return { text: JSON.stringify(out, null, 1), isError: false };
  }

  async keyInfo(client, signal) {
    try {
      const res = await client.request({
        method: 'GET',
        path: '/v5/user/query-api',
        sign: true,
        signal,
        maxAttempts: 1,
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      const json = res.json;
      if (!json || json.retCode !== 0) {
        return {
          ok: false,
          retCode: json?.retCode ?? null,
          retMsg: json?.retMsg ?? `HTTP ${res.httpStatus}`,
          hint: RET_CODE_HINTS[json?.retCode] ?? HTTP_STATUS_HINTS[res.httpStatus],
          traceId: res.traceId,
        };
      }
      const r = json.result ?? {};
      const pick = ['note', 'readOnly', 'permissions', 'ips', 'type', 'expiredAt', 'deadlineDay', 'unified', 'uta', 'userID', 'isMaster', 'parentUid', 'vipLevel', 'kycLevel', 'kycRegion'];
      return { ok: true, ...Object.fromEntries(pick.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])) };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { ok: false, error: err.message };
    }
  }
}
