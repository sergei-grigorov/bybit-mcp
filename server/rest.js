// REST-клиент Bybit V5 для одного контура (mainnet или demo).

import { createSigner, restSignPayload } from './signer.js';
import { NAME, VERSION } from './version.js';

export const USER_AGENT = `${NAME}/${VERSION}`;
const TIME_RESYNC_MS = 30 * 60_000;
const TIME_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const TIME_SYNC_TIMEOUT_MS = 5_000;
// Весь запрос вместе с повторами должен уложиться в таймаут клиента MCP (60 с).
export const REQUEST_BUDGET_MS = 45_000;

// Короткие пояснения к общим кодам ошибок (коды — из docs/v5/error).
export const RET_CODE_HINTS = {
  10000: 'Bybit server timeout.',
  10001: 'Parameter error: check names, types and required fields (see describe_endpoint).',
  10002: 'Timestamp is outside recv_window: local clock drift or a slow network.',
  10003: 'API key is invalid for this domain. Demo Trading keys work only with env="demo", mainnet keys only with env="mainnet".',
  10004: 'Signature error: check the API secret (HMAC secret or RSA private key).',
  10005: 'Permission denied: the API key lacks the permission this endpoint requires.',
  10006: 'Rate limit exceeded for this endpoint; wait for the window to reset.',
  10007: 'User authentication failed.',
  10008: 'Account is restricted (common ban); check the account mode.',
  10009: 'Service is not available for this region.',
  10010: 'Request IP is not in the API key IP whitelist.',
  10014: 'Duplicate request.',
  10016: 'Bybit server error.',
  10017: 'Route not found: check the path and HTTP method.',
  10024: 'Compliance rules triggered.',
  10027: 'Transactions are banned for this account.',
  10028: 'Endpoint is available to Unified Trading Account users only.',
  10029: 'Symbol is not in the API key symbol whitelist.',
  33004: 'API key has expired.',
};

export const HTTP_STATUS_HINTS = {
  401:
    'HTTP 401: Bybit did not accept the API key. Check that the key is correct and active and belongs to this ' +
    'environment: Demo Trading keys work only with env="demo", mainnet keys only with env="mainnet".',
  403:
    'HTTP 403: either the IP is throttled ("access too frequent" — stop requests for about 10 minutes) ' +
    'or Bybit does not serve this region (e.g. US IPs).',
  404: 'HTTP 404: the path does not exist on this domain.',
};

// Ошибки сети, при которых запрос точно не ушёл на сервер.
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Путь метода V5: /v5/…, без «.»/«..» и пустых сегментов.
export function isV5Path(path) {
  return /^\/v5(\/[A-Za-z0-9_.-]+)+$/.test(path) && !path.split('/').some((seg) => seg === '.' || seg === '..');
}

export class BybitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BybitError';
    this.details = details;
  }
}

// Значение идёт в строку запроса почти как есть: Bybit сверяет подпись со строкой,
// которую получил, а курсоры постраничного вывода приходят уже закодированными
// (%2C, %3A). Кодируются только символы, которые сломали бы URL или изменились бы
// при разборе URL на стороне fetch.
// encodeURIComponent не трогает ' ! * ( ), а URL-парсер fetch кодирует ' в запросе,
// поэтому кодируем байты UTF-8 сами.
const percentEncode = (c) =>
  [...Buffer.from(c, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

export function encodeQueryValue(value) {
  return String(value).replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$()*,;:@/?%=]/gu, percentEncode);
}

export function buildQuery(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    let v = value;
    if (Array.isArray(v)) v = v.join(',');
    else if (typeof v === 'object') v = JSON.stringify(v);
    parts.push(`${encodeQueryValue(key)}=${encodeQueryValue(v)}`);
  }
  return parts.join('&');
}

function parseRateLimit(headers) {
  const num = (name) => {
    const v = headers.get(name);
    return v == null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v);
  };
  const info = {
    remaining: num('x-bapi-limit-status'),
    limit: num('x-bapi-limit'),
    resetAt: num('x-bapi-limit-reset-timestamp'),
  };
  return Object.values(info).some((v) => v !== undefined) ? info : null;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function networkCode(err) {
  // У TimeoutError (DOMException) есть числовой code 23 — имя важнее.
  if (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') return 'TIMEOUT';
  return err?.cause?.code ?? err?.code;
}

export class RestClient {
  constructor(envConfig, { recvWindow = 5000, timeoutMs = 15000, referer = '', fetchImpl, now, logger } = {}) {
    this.env = envConfig;
    this.recvWindow = recvWindow;
    this.timeoutMs = timeoutMs;
    this.referer = referer;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.now = now ?? Date.now;
    this.logger = logger;
    this.offset = 0;
    this.syncedAt = -Infinity;
    this.signer = null;
    this.keyError = envConfig.keyError ?? null;
    if (envConfig.hasKeys) {
      try {
        this.signer = createSigner(envConfig.apiSecret);
      } catch (err) {
        this.keyError = `не удалось прочитать закрытый RSA-ключ: ${err.message}`;
      }
    }
  }

  get canSign() {
    return Boolean(this.signer);
  }

  serverNow() {
    return this.now() + this.offset;
  }

  // Смещение локальных часов относительно сервера (по середине интервала запроса).
  async syncTime(signal, timeoutMs) {
    const t0 = this.now();
    const res = await this.send('GET', '/v5/market/time', '', '', { 'User-Agent': USER_AGENT }, signal, timeoutMs);
    const t1 = this.now();
    const nano = res.json?.result?.timeNano;
    const serverMs = nano ? Number(BigInt(nano) / 1_000_000n) : Number(res.json?.time);
    if (!Number.isFinite(serverMs)) throw new BybitError('Некорректный ответ /v5/market/time');
    this.offset = Math.round(serverMs - (t0 + t1) / 2);
    this.syncedAt = t1;
    return { offsetMs: this.offset, rttMs: t1 - t0 };
  }

  async ensureTime(signal, timeoutMs = TIME_SYNC_TIMEOUT_MS) {
    if (this.now() - this.syncedAt < TIME_RESYNC_MS) return;
    try {
      await this.syncTime(signal, Math.max(500, Math.min(timeoutMs, TIME_SYNC_TIMEOUT_MS)));
    } catch (err) {
      if (signal?.aborted) throw err;
      this.logger?.warn(`${this.env.name}: не удалось сверить время с сервером: ${err.message}`);
      this.syncedAt = this.now() - TIME_RESYNC_MS + TIME_RETRY_AFTER_FAILURE_MS;
    }
  }

  signHeaders(payload) {
    const timestamp = String(this.serverNow());
    const recvWindow = String(this.recvWindow);
    return {
      'X-BAPI-API-KEY': this.env.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': this.signer.sign(restSignPayload({ timestamp, apiKey: this.env.apiKey, recvWindow, payload })),
    };
  }

  async send(method, path, query, body, headers, signal, timeoutMs = this.timeoutMs) {
    const url = `${this.env.restUrl}${path}${query ? `?${query}` : ''}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      // Подписанный запрос не должен уходить по перенаправлению на другой адрес.
      redirect: 'error',
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // не JSON — например, страница CDN с кодом 403
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  // Выполняет запрос. sign — подписывать ли его ключом контура.
  // Повторы: GET — при сетевых сбоях и 5xx; любой метод — при ошибке времени (10002)
  // и превышении лимита (10006/429, если окно сбрасывается в пределах 3 с): в этих
  // случаях сервер отклонил запрос, не выполнив его. POST после сетевого сбоя не
  // повторяется — неизвестно, дошёл ли он.
  // maxAttempts и timeoutMs ужимают ожидание (например, для проверки ключей);
  // budgetMs — предел на весь запрос вместе со сверкой часов и повторами.
  async request({ method = 'GET', path, params = {}, sign = false, signal, maxAttempts = 3, timeoutMs, budgetMs = REQUEST_BUDGET_MS }) {
    method = method.toUpperCase();
    if (!isV5Path(path)) throw new BybitError(`Недопустимый путь: ${path}`);
    if (sign && !this.signer) {
      throw new BybitError(this.keyError ?? `Для контура ${this.env.name} не заданы API-ключи`, { kind: 'no-keys' });
    }
    const isGet = method === 'GET';
    const query = isGet ? buildQuery(params) : '';
    const body = isGet ? '' : JSON.stringify(params ?? {});
    const notes = [];
    const deadline = Date.now() + budgetMs;
    const left = () => deadline - Date.now();
    const attemptTimeout = () => Math.max(1000, Math.min(timeoutMs ?? this.timeoutMs, left()));
    for (let attempt = 1; ; attempt++) {
      if (sign) await this.ensureTime(signal, left());
      const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
      if (!isGet) headers['Content-Type'] = 'application/json';
      if (this.referer) headers['X-Referer'] = this.referer;
      if (sign) Object.assign(headers, this.signHeaders(isGet ? query : body));

      let res;
      try {
        res = await this.send(method, path, query, body, headers, signal, attemptTimeout());
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        const code = networkCode(err);
        const notSent = NOT_SENT_CODES.has(code);
        if ((isGet || notSent) && attempt < maxAttempts && left() > 400 * attempt + 1000) {
          notes.push(`retry after network error ${code ?? err.message}`);
          await sleep(400 * attempt, signal);
          continue;
        }
        const reason = code ?? err.cause?.message ?? err.message;
        if (isGet || notSent) {
          throw new BybitError(`Сетевая ошибка: ${reason}`, { kind: 'network', executed: false });
        }
        throw new BybitError(
          `Сетевая ошибка после отправки ${method} ${path} (${reason}). Неизвестно, выполнил ли Bybit операцию: ` +
            'проверьте состояние (например, ордер по orderLinkId), прежде чем повторять.',
          { kind: 'network', executed: 'unknown' },
        );
      }

      const rateLimit = parseRateLimit(res.headers);
      const retCode = res.json?.retCode ?? res.json?.ret_code;
      if (retCode === 10002 && sign && attempt < Math.max(maxAttempts, 2) && left() > 1000) {
        notes.push('clock re-synced after retCode 10002');
        try {
          await this.syncTime(signal, Math.max(500, Math.min(TIME_SYNC_TIMEOUT_MS, left() - 500)));
        } catch (err) {
          if (signal?.aborted) throw signal.reason ?? err;
        }
        continue;
      }
      if ((retCode === 10006 || res.status === 429) && attempt < Math.min(maxAttempts, 2)) {
        const wait = rateLimit?.resetAt ? rateLimit.resetAt - this.serverNow() : 1000;
        if (wait <= 3000 && left() > wait + 1000) {
          notes.push(`waited ${Math.max(wait, 200)} ms for the rate-limit window`);
          await sleep(Math.max(wait, 200), signal);
          continue;
        }
      }
      if (isGet && res.status >= 500 && attempt < maxAttempts && left() > 500 * attempt + 1000) {
        notes.push(`retry after HTTP ${res.status}`);
        await sleep(500 * attempt, signal);
        continue;
      }
      return {
        env: this.env.name,
        method,
        path,
        query,
        httpStatus: res.status,
        json: res.json,
        text: res.json ? undefined : res.text,
        traceId: res.headers.get('traceid') ?? undefined,
        rateLimit,
        attempts: attempt,
        notes,
      };
    }
  }
}
