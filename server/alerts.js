// Оповещения: условие на рынке или на счёте Bybit → событие в WebSocket, который слушает
// инструмент Monitor в Claude Code. Агент не опрашивает биржу, а просыпается, когда
// условие выполнилось.
//
//   create_alert → условия проверяются на потоках Bybit (feed.js), которые держит коннектор;
//   событие → очередь оповещения → кадр в соединение Monitor (wsserver.js). Доставка
//   подтверждается pong на ping после кадра; неподтверждённое при обрыве уходит снова.
//   Monitor живёт не дольше 30 минут: агент подключается заново по тому же адресу, и всё,
//   что сработало в перерыве, приходит сразу.
//
// Оповещения живут в памяти процесса: после перезапуска коннектора их нет, и Monitor
// узнаёт об этом по отказу в подключении или по коду закрытия 4004.

import { randomBytes } from 'node:crypto';

import { ToolError } from './executor.js';
import { BybitFeed } from './feed.js';
import { TOOL } from './names.js';
import { BybitError } from './rest.js';
import { wsAuthPayload } from './signer.js';
import { streamUrl } from './ws.js';
import { createMountedServer, startLocalServer } from './wsserver.js';

export const CONDITION_TYPES = ['ticker', 'candle', 'order', 'position'];
export const TICKER_OPS = ['above', 'below', 'rise_pct', 'fall_pct', 'move_pct'];
export const CANDLE_OPS = ['above', 'below'];
export const CANDLE_CATEGORIES = ['spot', 'linear', 'inverse'];
export const CANDLE_INTERVALS = ['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'W', 'M'];
export const CANDLE_FIELDS = ['close', 'open', 'high', 'low', 'volume', 'turnover', 'change_pct', 'range_pct'];
export const ORDER_STATUSES = ['New', 'PartiallyFilled', 'Untriggered', 'Rejected', 'PartiallyFilledCanceled', 'Filled', 'Cancelled', 'Triggered', 'Deactivated'];
export const DEFAULT_ORDER_STATUSES = ['Filled', 'PartiallyFilledCanceled', 'Cancelled', 'Rejected', 'Deactivated'];
export const POSITION_CATEGORIES = ['linear', 'inverse', 'option'];
export const POSITION_EVENTS = ['opened', 'closed', 'size_changed', 'liquidation'];
export const FREQUENCIES = ['once', 'once_per_condition', 'every_time'];

// Коды закрытия соединения Monitor: оповещение закончилось, переподключаться незачем.
export const CLOSE_CODES = { finished: 4000, replaced: 4001, cancelled: 4002, expired: 4003, unknown: 4004, stopped: 4005 };

export const ALERT_LIMITS = {
  maxAlerts: 50,
  maxConditions: 10,
  maxNoteChars: 300,
  defaultExpiresMinutes: 24 * 60,
  maxExpiresMinutes: 7 * 24 * 60,
  defaultCooldownSeconds: 60,
  minCooldownSeconds: 5,
};

// Monitor обрезает событие длиннее 3000 символов — кадр держим короче.
export const FRAME_MAX_CHARS = 2500;
export const MONITOR_TIMEOUT_MS = 1_800_000;

const DEFAULT_TIMING = {
  setupTimeoutMs: 25_000, // подписка, первые данные и проверки по REST при создании
  firstTickerMs: 10_000, // снимок тикера после подтверждения подписки
  batchDelayMs: 150, // события, сработавшие вместе, уходят одним кадром
  minFrameIntervalMs: 1000,
  streamNoticeMs: 60_000, // столько поток Bybit должен лежать, чтобы агента разбудили
  minuteMs: 60_000,
  tombstoneMs: 24 * 3600_000,
  closeGraceMs: 300,
};

const MAX_QUEUE = 30; // событий в очереди оповещения; старые сверх этого отбрасываются
const MAX_DELIVERIES = 3; // сколько раз повторять неподтверждённое событие
const MAX_PENDING = 1000; // сообщений, пришедших, пока условие настраивается
const MAX_TOMBSTONES = 200;
const MAX_ENDED_LOG = 20;
const REST_BUDGET_MS = 15_000;
const LIQUIDATION_STATUSES = new Set(['Liq', 'Adl']);

const TICKER_DATA_FIELDS = ['lastPrice', 'markPrice', 'indexPrice', 'bid1Price', 'ask1Price', 'bidPrice', 'askPrice', 'price24hPcnt', 'fundingRate', 'openInterest'];
const ORDER_DATA_FIELDS = [
  'category', 'symbol', 'side', 'orderType', 'price', 'qty', 'orderStatus', 'cumExecQty', 'avgPrice', 'leavesQty', 'orderId',
  'orderLinkId', 'stopOrderType', 'triggerPrice', 'takeProfit', 'stopLoss', 'rejectReason', 'cancelType', 'updatedTime',
];
const POSITION_DATA_FIELDS = [
  'category', 'symbol', 'side', 'size', 'positionIdx', 'entryPrice', 'markPrice', 'unrealisedPnl', 'curRealisedPnl',
  'cumRealisedPnl', 'liqPrice', 'takeProfit', 'stopLoss', 'positionStatus', 'updatedTime',
];

const HOW_TO_WAIT =
  'Start the Monitor tool with the "monitor" object now. Messages are JSON and may carry several events; they come only ' +
  'when something happens: a condition fired, a Bybit stream went down or came back, a condition can no longer be ' +
  'checked. When Monitor times out (30 min at most), start it again with the same URL: events from the gap are ' +
  'delivered then. Close codes 4000-4005 mean this Monitor is no longer needed (the alert is over, or 4001: a newer ' +
  'Monitor took over): do not restart it. If Monitor fails to connect (1006), the connector restarted and its alerts ' +
  `are gone: check ${TOOL.listAlerts} and create the alert again.`;

const toNumber = (v) => {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const roundLevel = (x) => Number(x.toPrecision(12));
// Уровень от процента — с точностью исходного значения плюс два знака: 85796.30 +1% → 86654.263.
const levelFrom = (x, reference) => Number(x.toFixed(Math.min(12, (String(reference).split('.')[1]?.length ?? 0) + 2)));
// Время из данных Bybit может оказаться кривым — тогда берётся текущее, а не исключение.
const iso = (ms) => {
  const date = new Date(ms);
  return (Number.isFinite(date.getTime()) ? date : new Date()).toISOString();
};

// Ожидание, которое прерывается отменой вызова.
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
const clock = (ms) => `${iso(ms).slice(11, 19)} UTC`;

function candleSpan(candle, interval) {
  if (['D', 'W', 'M'].includes(interval)) return `${iso(candle.start).slice(0, 10)} (${intervalLabel(interval)})`;
  return `${iso(candle.start).slice(11, 16)}-${iso(candle.end + 1).slice(11, 16)} UTC`;
}
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined && obj[k] !== '').map((k) => [k, obj[k]]));

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export function intervalLabel(interval) {
  if (interval === 'D' || interval === 'W' || interval === 'M') return `1${interval}`;
  const minutes = Number(interval);
  return minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

function tickerText(c) {
  const head = `${c.symbol} ${c.category} ${c.field}`;
  if (c.upper === undefined && c.lower === undefined) return `${head} ${c.op} ${c.value}`;
  const levels = [c.upper !== undefined ? `>= ${c.upper}` : null, c.lower !== undefined ? `<= ${c.lower}` : null].filter(Boolean).join(' or ');
  if (!c.op.endsWith('_pct')) return `${head} ${levels}`;
  const sign = { rise_pct: '+', fall_pct: '-', move_pct: '+/-' }[c.op];
  return `${head} ${levels} (${sign}${c.value}% from ${c.reference})`;
}

function candleText(c) {
  return `${c.symbol} ${c.category} ${intervalLabel(c.interval)} candle ${c.field} ${c.op === 'above' ? '>=' : '<='} ${c.value}`;
}

function orderText(c) {
  const target = c.orderId ? `order ${c.orderId}` : c.orderLinkId ? `order orderLinkId=${c.orderLinkId}` : 'any order';
  const scope = [c.category, c.symbol].filter(Boolean).join(' ');
  return `${c.env} ${target}${scope ? ` (${scope})` : ''} -> ${c.statuses.join('/')}`;
}

function positionText(c) {
  return `${c.env} position ${c.category} ${c.symbol}: ${c.event}`;
}

function shortText(c) {
  const sign = { above: '>=', below: '<=', rise_pct: '+', fall_pct: '-', move_pct: '+/-' }[c.op];
  const pct = c.op?.endsWith('_pct') ? '%' : '';
  let text;
  if (c.type === 'ticker') text = `${c.symbol} ${c.field} ${sign}${pct ? '' : ' '}${c.value}${pct}`;
  else if (c.type === 'candle') text = `${c.symbol} ${intervalLabel(c.interval)} ${c.field} ${sign} ${c.value}`;
  else if (c.type === 'order') text = `${c.env} order ${c.orderId ?? c.orderLinkId ?? c.symbol ?? 'any'}`;
  else text = `${c.env} ${c.symbol} position ${c.event}`;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function candleValue(candle, field) {
  const open = toNumber(candle.open);
  const high = toNumber(candle.high);
  const low = toNumber(candle.low);
  const close = toNumber(candle.close);
  if (field === 'change_pct') return open > 0 && close !== null ? ((close - open) / open) * 100 : null;
  if (field === 'range_pct') return low > 0 && high !== null ? ((high - low) / low) * 100 : null;
  return toNumber(candle[field]);
}

function positionState(p) {
  return {
    size: toNumber(p.size) ?? 0,
    side: p.side ?? '',
    seq: toNumber(p.seq) ?? -Infinity,
    status: p.positionStatus || 'Normal',
  };
}

const signedSize = (p) => (p.side === 'Sell' ? -p.size : p.size);
const positionLabel = (p) => (p.size > 0 ? `${p.side} ${p.size}` : '0');

function describePositions(map) {
  const open = [...map.values()].filter((p) => p.size > 0).map((p) => `${p.side} ${p.size}`);
  return open.length ? open.join(', ') : 'no position';
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new ToolError(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// Кадр для Monitor: события, которые помещаются в FRAME_MAX_CHARS. Не влезает и одно —
// сначала без data, потом с укороченной сводкой.
export function buildFrame(alert, queue, limit = FRAME_MAX_CHARS) {
  const head = { alert: alert.id };
  if (alert.note) head.note = alert.note;
  const tail = (count) => {
    const out = { status: alert.state === 'active' ? 'active' : 'finished' };
    const rest = queue.length - count;
    if (rest > 0) out.more = rest;
    if (alert.dropped) out.dropped = alert.dropped;
    return out;
  };
  const text = (events) => JSON.stringify({ ...head, events, ...tail(events.length) });
  const events = [];
  let frame = '';
  for (const event of queue) {
    const { deliveries, ...view } = event;
    let candidate = text([...events, view]);
    if (candidate.length > limit) {
      if (events.length) break;
      const { data, ...lean } = view;
      candidate = text([lean]);
      if (candidate.length > limit) {
        const room = Math.max(40, (lean.summary?.length ?? 0) - (candidate.length - limit) - 20);
        candidate = text([{ ...lean, summary: `${String(lean.summary ?? '').slice(0, room)}…` }]);
      }
      if (candidate.length > limit) candidate = text([{ seq: lean.seq, summary: 'event too large to show' }]);
    }
    events.push(view);
    frame = candidate;
  }
  return { text: frame, count: events.length };
}

export class AlertManager {
  // publicUrl — коннектор на сервере: соединения Monitor принимает его HTTP-сервер
  // (acceptUpgrade), а адреса оповещений — публичные.
  constructor({ config, executor, logger, WebSocketImpl, timing = {}, feedTiming = {}, socketOptions = {}, now = Date.now, publicUrl = null }) {
    this.config = config;
    this.executor = executor;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.feedTiming = feedTiming;
    this.socketOptions = socketOptions;
    this.now = now;
    this.alerts = new Map(); // id → оповещение
    this.byToken = new Map(); // токен из адреса → оповещение
    this.tombstones = new Map(); // токен закончившегося оповещения → { code, reason, at }
    this.endedLog = [];
    this.feeds = new Map(); // ключ потока → { feed, label, noticeTimer, noticeSent, downAt }
    this.topics = new Map(); // «ключ потока тема» → { feedKey, topic, conditions, ticker, candle }
    this.server = publicUrl
      ? createMountedServer({ publicUrl, onConnection: (path, ws) => this.onConnection(path, ws), logger, socketOptions })
      : null;
    this.serverStarting = null;
    this.closed = false;
  }

  // Коннектор на сервере: запрос на WebSocket к <путь-коннектора>/alerts/<токен>.
  acceptUpgrade(req, socket, head, path) {
    if (!this.server?.accept) throw new Error('alerts: acceptUpgrade needs publicUrl');
    return this.server.accept(req, socket, head, path);
  }

  // ---------- разбор условий ----------

  parseCondition(raw, index) {
    const where = `conditions[${index - 1}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError(`${where} must be an object`);
    const { type } = raw;
    if (!CONDITION_TYPES.includes(type)) throw new ToolError(`${where}.type must be one of: ${CONDITION_TYPES.join(', ')}`);
    const allowed = {
      ticker: ['type', 'category', 'symbol', 'field', 'op', 'value'],
      candle: ['type', 'category', 'symbol', 'interval', 'field', 'op', 'value'],
      order: ['type', 'env', 'category', 'symbol', 'order_id', 'order_link_id', 'statuses'],
      position: ['type', 'env', 'category', 'symbol', 'event'],
    }[type];
    // Поле другого типа — ошибка: иначе модель решит, что оно что-то значит.
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) throw new ToolError(`${where}: "${key}" does not apply to type "${type}" (allowed: ${allowed.join(', ')})`);
    }
    const need = (name) => {
      const v = raw[name];
      if (v === undefined || v === null || v === '') throw new ToolError(`${where}: "${name}" is required for type "${type}"`);
      return v;
    };
    const symbolOf = (v) => {
      const s = String(v).trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(s)) throw new ToolError(`${where}: "${v}" does not look like a Bybit symbol`);
      return s;
    };
    const cond = { index, type, where };

    if (type === 'ticker' || type === 'candle') {
      cond.category = need('category');
      cond.symbol = symbolOf(need('symbol'));
      cond.op = need('op');
      const value = toNumber(need('value'));
      if (value === null) throw new ToolError(`${where}: value must be a number`);
      cond.value = value;
      if (type === 'ticker') {
        if (!TICKER_OPS.includes(cond.op)) throw new ToolError(`${where}: op must be one of ${TICKER_OPS.join(', ')}`);
        cond.field = String(raw.field ?? (cond.category === 'option' ? 'markPrice' : 'lastPrice')).trim();
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(cond.field)) throw new ToolError(`${where}: "${raw.field}" is not a ticker field name`);
        if (cond.op.endsWith('_pct') && !(value > 0 && (cond.op === 'rise_pct' ? value <= 10_000 : value < 100))) {
          throw new ToolError(`${where}: ${cond.op} needs a percent value above 0${cond.op === 'rise_pct' ? '' : ' and below 100'}`);
        }
        cond.feedKey = `public:${cond.category}`;
        cond.topic = `tickers.${cond.symbol}`;
        cond.text = tickerText(cond);
      } else {
        if (!CANDLE_CATEGORIES.includes(cond.category)) throw new ToolError(`${where}: candles exist for ${CANDLE_CATEGORIES.join(', ')} only`);
        if (!CANDLE_OPS.includes(cond.op)) throw new ToolError(`${where}: op must be above or below for candles`);
        cond.interval = String(need('interval'));
        if (!CANDLE_INTERVALS.includes(cond.interval)) throw new ToolError(`${where}: interval must be one of ${CANDLE_INTERVALS.join(', ')}`);
        cond.field = raw.field ?? 'close';
        if (!CANDLE_FIELDS.includes(cond.field)) throw new ToolError(`${where}: field must be one of ${CANDLE_FIELDS.join(', ')}`);
        cond.feedKey = `public:${cond.category}`;
        cond.topic = `kline.${cond.interval}.${cond.symbol}`;
        cond.text = candleText(cond);
      }
      return cond;
    }

    cond.env = this.executor.resolveEnv(raw.env);
    if (!this.executor.clients[cond.env].canSign) throw new ToolError(`${where}: ${this.executor.noKeysMessage(cond.env)}`);
    cond.feedKey = `private:${cond.env}`;
    if (type === 'order') {
      cond.category = raw.category;
      cond.symbol = raw.symbol === undefined ? undefined : symbolOf(raw.symbol);
      cond.orderId = raw.order_id ? String(raw.order_id).trim() : undefined;
      cond.orderLinkId = raw.order_link_id ? String(raw.order_link_id).trim() : undefined;
      if ((cond.orderId || cond.orderLinkId) && !cond.category) {
        throw new ToolError(`${where}: "category" is required with order_id / order_link_id (the connector checks the order's current status)`);
      }
      const statuses = raw.statuses?.length ? raw.statuses : DEFAULT_ORDER_STATUSES;
      for (const s of statuses) if (!ORDER_STATUSES.includes(s)) throw new ToolError(`${where}: unknown order status "${s}"`);
      cond.statuses = [...new Set(statuses)];
      cond.topic = 'order';
      cond.text = orderText(cond);
      return cond;
    }
    cond.category = need('category');
    if (!POSITION_CATEGORIES.includes(cond.category)) throw new ToolError(`${where}: positions exist for ${POSITION_CATEGORIES.join(', ')} only`);
    cond.symbol = symbolOf(need('symbol'));
    cond.event = raw.event ?? 'size_changed';
    if (!POSITION_EVENTS.includes(cond.event)) throw new ToolError(`${where}: event must be one of ${POSITION_EVENTS.join(', ')}`);
    cond.topic = 'position';
    cond.text = positionText(cond);
    return cond;
  }

  // ---------- создание ----------

  async create(args, { signal } = {}) {
    if (this.closed) throw new ToolError('The connector is shutting down.');
    const raws = Array.isArray(args?.conditions) ? args.conditions : [];
    if (!raws.length) throw new ToolError('conditions must contain at least one condition');
    if (raws.length > ALERT_LIMITS.maxConditions) throw new ToolError(`At most ${ALERT_LIMITS.maxConditions} conditions per alert`);
    if (this.alerts.size >= ALERT_LIMITS.maxAlerts) {
      throw new ToolError(`Too many active alerts (${this.alerts.size}). Cancel some with ${TOOL.cancelAlert} (see ${TOOL.listAlerts}).`);
    }
    const frequency = args.frequency ?? 'once';
    if (!FREQUENCIES.includes(frequency)) throw new ToolError(`frequency must be one of ${FREQUENCIES.join(', ')}`);
    const note = String(args.note ?? '').trim();
    if (note.length > ALERT_LIMITS.maxNoteChars) throw new ToolError(`note is limited to ${ALERT_LIMITS.maxNoteChars} characters`);
    const expiresMinutes = Math.round(args.expires_in_minutes ?? ALERT_LIMITS.defaultExpiresMinutes);
    if (!(expiresMinutes >= 1 && expiresMinutes <= ALERT_LIMITS.maxExpiresMinutes)) {
      throw new ToolError(`expires_in_minutes must be between 1 and ${ALERT_LIMITS.maxExpiresMinutes}`);
    }
    const cooldownSeconds = Math.round(args.cooldown_seconds ?? ALERT_LIMITS.defaultCooldownSeconds);
    if (!(cooldownSeconds >= ALERT_LIMITS.minCooldownSeconds && cooldownSeconds <= 86_400)) {
      throw new ToolError(`cooldown_seconds must be between ${ALERT_LIMITS.minCooldownSeconds} and 86400`);
    }
    const conditions = raws.map((raw, i) => this.parseCondition(raw, i + 1));
    signal?.throwIfAborted();
    await this.ensureServer();
    signal?.throwIfAborted();

    const createdAt = this.now();
    const alert = {
      id: this.newId(),
      token: randomBytes(18).toString('base64url'),
      note,
      frequency,
      cooldownMs: cooldownSeconds * 1000,
      createdAt,
      expiresAt: createdAt + expiresMinutes * this.timing.minuteMs,
      conditions,
      state: 'active',
      queue: [],
      inflight: [],
      eventSeq: 0,
      delivered: 0,
      dropped: 0,
      recent: [],
      client: null,
      lastFrameAt: 0,
      connections: 0,
    };
    for (const cond of conditions) {
      Object.assign(cond, { alert, ready: false, pending: [], fired: 0, armed: true, done: false, createdAt });
    }

    // Отмена вызова или ошибка одного условия прерывает остальные проверки.
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await withTimeout(
        Promise.all(conditions.map((c) => this.setup(c, controller.signal))),
        this.timing.setupTimeoutMs,
        `Bybit did not answer within ${this.timing.setupTimeoutMs / 1000} s while setting up the alert; try again`,
      );
      // Вызов отменили или коннектор останавливается, а настройка успела закончиться: ответа
      // никто не получит, и оповещение без адреса только занимало бы подписки.
      signal?.throwIfAborted();
      if (this.closed) throw new ToolError('The connector is shutting down.');
    } catch (err) {
      controller.abort(err);
      for (const c of conditions) this.detach(c);
      if (signal?.aborted) throw signal.reason ?? err;
      if (err instanceof ToolError) throw err;
      throw new ToolError(err?.message ?? String(err));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    this.alerts.set(alert.id, alert);
    this.byToken.set(alert.token, alert);
    alert.expiryTimer = setTimeout(() => this.expire(alert), alert.expiresAt - this.now());
    alert.expiryTimer.unref?.();
    for (const cond of conditions) {
      cond.ready = true;
      this.afterSetup(cond);
    }
    this.logger?.info(`оповещение ${alert.id}: ${conditions.map((c) => c.text).join('; ')}`);
    return this.describeCreated(alert);
  }

  newId() {
    for (;;) {
      const id = randomBytes(4).toString('hex');
      if (!this.alerts.has(id)) return id;
    }
  }

  async setup(cond, signal) {
    if (cond.type === 'candle') await this.checkCandle(cond, signal);
    // Другое условие уже провалилось и создание откатили — не подписываться после отката.
    signal.throwIfAborted();
    this.attach(cond);
    if (cond.type === 'candle') {
      // Свеча, которая шла при проверке по REST: если её закрытие придёт раньше, чем подписка
      // начнёт работать, следующая свеча покажет пропуск, и он доберётся по REST.
      this.topics.get(this.topicKey(cond)).candle.openStart ??= cond.lastClosedStart + 1;
    }
    const feed = this.feedFor(cond.feedKey);
    try {
      await abortable(feed.subscribe(cond.topic), signal);
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err;
      throw new ToolError(`${cond.where} (${cond.text}): ${err.message}`);
    }
    if (cond.type === 'ticker') await this.setupTicker(cond, signal);
    else if (cond.type === 'order') await this.setupOrder(cond, signal);
    else if (cond.type === 'position') await this.setupPosition(cond, signal);
  }

  // Ответ REST целиком (нужно и поле time — часы Bybit).
  async restJson(cond, { path, params, sign, signal }) {
    const client = this.executor.clients[cond.env ?? 'mainnet'];
    let res;
    try {
      res = await client.request({ method: 'GET', path, params, sign, signal, budgetMs: REST_BUDGET_MS });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (err instanceof BybitError) throw new ToolError(`${cond.where} (${cond.text}): ${path}: ${err.message}`);
      throw err;
    }
    const json = res.json;
    if (!json || json.retCode !== 0) {
      const why = json ? `retCode ${json.retCode} ${json.retMsg ?? ''}`.trim() : `HTTP ${res.httpStatus}`;
      throw new ToolError(`${cond.where} (${cond.text}): Bybit answered ${path} with ${why}`);
    }
    return json;
  }

  async rest(cond, request) {
    return (await this.restJson(cond, request)).result ?? {};
  }

  // Свеча: проверка символа и интервала по REST. Считаются свечи, закрывшиеся после создания;
  // «после» — по часам Bybit из этого же ответа, чтобы не зависеть от сдвига местных часов.
  async checkCandle(cond, signal) {
    const json = await this.restJson(cond, {
      path: '/v5/market/kline',
      params: { category: cond.category, symbol: cond.symbol, interval: cond.interval, limit: 1 },
      sign: false,
      signal,
    });
    const latest = json.result?.list?.[0];
    if (!latest) throw new ToolError(`${cond.where} (${cond.text}): Bybit has no candles for ${cond.symbol} (${cond.category})`);
    cond.current = `${latest[4]} (candle in progress)`;
    cond.lastClosedStart = Number(latest[0]) - 1;
    const serverTime = toNumber(json.time);
    if (serverTime !== null) cond.createdAt = serverTime;
  }

  // Первый снимок тикера после подписки: ожидание снимается по таймауту и отмене вызова.
  waitTicker(entry, cond, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {};
      const onAbort = () => waiter.reject(signal.reason);
      const settle = (fn) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        entry.tickerWaiters = entry.tickerWaiters.filter((w) => w !== waiter);
        fn();
      };
      waiter.resolve = () => settle(resolve);
      waiter.reject = (err) => settle(() => reject(err));
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      timer = setTimeout(
        () => waiter.reject(new ToolError(`${cond.where} (${cond.text}): no ticker data from Bybit within ${this.timing.firstTickerMs / 1000} s`)),
        this.timing.firstTickerMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.tickerWaiters.push(waiter);
    });
  }

  async setupTicker(cond, signal) {
    const entry = this.topics.get(this.topicKey(cond));
    if (!entry || !cond.attached) throw new ToolError(`${cond.where} (${cond.text}): the alert was removed while being set up`);
    if (!entry.ticker) await this.waitTicker(entry, cond, signal);
    const data = entry.ticker.data;
    const raw = data[cond.field];
    const value = toNumber(raw);
    if (value === null) {
      const numeric = Object.keys(data).filter((k) => toNumber(data[k]) !== null && k !== 'symbol');
      throw new ToolError(
        `${cond.where}: ${cond.symbol} (${cond.category}) has no numeric ticker field "${cond.field}"` +
          `${raw === '' ? ' (it is empty for this instrument)' : ''}. Numeric fields: ${numeric.join(', ')}.`,
      );
    }
    if (cond.op.endsWith('_pct')) {
      if (!(value > 0)) throw new ToolError(`${cond.where}: a percent move needs a positive current value, but ${cond.field} is ${raw}; use op above/below`);
      cond.reference = raw;
      const p = cond.value / 100;
      if (cond.op !== 'fall_pct') cond.upper = levelFrom(value * (1 + p), raw);
      if (cond.op !== 'rise_pct') cond.lower = levelFrom(value * (1 - p), raw);
    } else if (cond.op === 'above') cond.upper = cond.value;
    else cond.lower = cond.value;
    cond.text = tickerText(cond);
    cond.current = raw;
  }

  // Ордер по id: текущий статус по REST закрывает гонку «исполнился до подписки».
  async setupOrder(cond, signal) {
    if (!cond.orderId && !cond.orderLinkId) {
      cond.current = 'waiting for order updates';
      return;
    }
    const order = await this.lookupOrder(cond, signal);
    if (!order) {
      throw new ToolError(
        `${cond.where}: no order ${cond.orderId ?? `with orderLinkId ${cond.orderLinkId}`} in ${cond.category} on ${cond.env}. ` +
          'Check the id, the category and the account.',
      );
    }
    cond.current = order.orderStatus;
    cond.initialOrder = order;
  }

  async lookupOrder(cond, signal) {
    const params = { category: cond.category, ...(cond.orderId ? { orderId: cond.orderId } : { orderLinkId: cond.orderLinkId }) };
    // realtime отдаёт открытые и последние 500 закрытых; после перезапуска Bybit — только history.
    for (const path of ['/v5/order/realtime', '/v5/order/history']) {
      const result = await this.rest(cond, { path, params, sign: true, signal });
      const order = result.list?.find((o) => (cond.orderId ? o.orderId === cond.orderId : o.orderLinkId === cond.orderLinkId));
      if (order) return { category: cond.category, ...order };
    }
    return null;
  }

  // Позиция: отправная точка по REST. Обновления, пришедшие раньше неё, отбрасываются по seq.
  async setupPosition(cond, signal) {
    cond.positions = await this.fetchPositions(cond, signal);
    cond.current = describePositions(cond.positions);
  }

  async fetchPositions(cond, signal) {
    const result = await this.rest(cond, {
      path: '/v5/position/list',
      params: { category: cond.category, symbol: cond.symbol },
      sign: true,
      signal,
    });
    const map = new Map();
    for (const p of result.list ?? []) {
      if (p.symbol === cond.symbol) map.set(Number(p.positionIdx ?? 0), positionState(p));
    }
    return map;
  }

  afterSetup(cond) {
    if (cond.type === 'ticker') {
      // Уровень мог выполняться ещё до создания; процентный сдвиг отсчитан от значения при
      // настройке, так что если он уже есть — это движение за время настройки, а не «было так».
      const entry = this.topics.get(this.topicKey(cond));
      if (entry?.ticker) this.evaluateTicker(cond, entry, { initial: !cond.op.endsWith('_pct') });
    } else if (cond.type === 'order' && cond.initialOrder) {
      this.evaluateOrder(cond, cond.initialOrder, { initial: true, source: 'rest' });
      cond.initialOrder = null;
    }
    const pending = cond.pending;
    cond.pending = [];
    for (const item of pending) this.route(cond, item);
  }

  // ---------- темы и потоки ----------

  topicKey(cond) {
    return `${cond.feedKey} ${cond.topic}`;
  }

  attach(cond) {
    const key = this.topicKey(cond);
    let entry = this.topics.get(key);
    if (!entry) {
      entry = { key, feedKey: cond.feedKey, topic: cond.topic, conditions: new Set(), ticker: null, tickerWaiters: [], candle: {} };
      this.topics.set(key, entry);
    }
    entry.conditions.add(cond);
    cond.attached = true;
  }

  detach(cond) {
    if (!cond.attached) return;
    cond.attached = false;
    const key = this.topicKey(cond);
    const entry = this.topics.get(key);
    if (!entry) return;
    entry.conditions.delete(cond);
    if (entry.conditions.size) return;
    this.topics.delete(key);
    for (const w of entry.tickerWaiters) w.reject(new Error('the alert was removed'));
    this.feeds.get(entry.feedKey)?.feed.unsubscribe(entry.topic);
  }

  feedFor(feedKey) {
    const known = this.feeds.get(feedKey);
    if (known) return known.feed;
    const [kind, name] = feedKey.split(':');
    let url;
    let auth = null;
    let label;
    if (kind === 'public') {
      url = streamUrl(this.config.envs.mainnet, name);
      label = `public ${name}`;
    } else {
      const envCfg = this.config.envs[name];
      const client = this.executor.clients[name];
      url = streamUrl(envCfg, 'private');
      label = `private (${name} account)`;
      auth = async () => {
        await client.ensureTime();
        const expires = client.serverNow() + 10_000;
        return [envCfg.apiKey, expires, client.signer.sign(wsAuthPayload(expires))];
      };
    }
    const feed = new BybitFeed({
      name: `поток ${label}`,
      url,
      auth,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger,
      timing: this.feedTiming,
      onData: (msg) => this.onData(feedKey, msg),
      onState: (info) => this.onFeedState(feedKey, info),
      onTopicFailed: (topic, reason) => this.onTopicFailed(feedKey, topic, reason),
      onTopicAcked: (topic) => this.onTopicAcked(feedKey, topic),
    });
    this.feeds.set(feedKey, { feed, label, noticeTimer: null, noticeSent: false, downAt: null });
    return feed;
  }

  onData(feedKey, msg) {
    const entry = this.topics.get(`${feedKey} ${msg.topic}`);
    if (!entry) return;
    if (msg.topic.startsWith('tickers.')) this.onTicker(entry, msg);
    else if (msg.topic.startsWith('kline.')) this.onKline(entry, msg);
    else if (msg.topic === 'order' || msg.topic === 'position') {
      const items = Array.isArray(msg.data) ? msg.data : [msg.data];
      for (const item of items) {
        if (item && typeof item === 'object') for (const cond of entry.conditions) this.route(cond, item);
      }
    }
  }

  // Сообщение для условия: до конца настройки копится, потом проверяется.
  route(cond, item) {
    if (!cond.ready) {
      if (cond.pending.length < MAX_PENDING) cond.pending.push(item);
      return;
    }
    if (cond.type === 'order') this.evaluateOrder(cond, item, {});
    else if (cond.type === 'position') this.evaluatePosition(cond, item, {});
    else if (cond.type === 'candle') this.candleClosed(cond, item);
  }

  onTicker(entry, msg) {
    const data = Array.isArray(msg.data) ? msg.data[0] : msg.data;
    if (!data || typeof data !== 'object') return;
    if (msg.type === 'delta') {
      if (!entry.ticker) return; // дельта без снимка ничего не значит
      Object.assign(entry.ticker.data, data);
    } else {
      entry.ticker = { data: { ...data } };
      for (const w of entry.tickerWaiters) w.resolve();
      entry.tickerWaiters = [];
    }
    entry.ticker.ts = msg.ts;
    for (const cond of entry.conditions) if (cond.ready) this.evaluateTicker(cond, entry, {});
  }

  onKline(entry, msg) {
    const k = entry.candle;
    const items = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const item of items) {
      const start = toNumber(item?.start);
      if (start === null) continue;
      const candle = {
        start,
        end: toNumber(item.end) ?? start,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
        turnover: item.turnover,
      };
      const prevOpen = k.openStart;
      // Закрытие пропущено (обрыв связи или потерянный кадр) — закрытые свечи до этой
      // добираются по REST. Добор начинается синхронно, поэтому и закрытие этой же свечи
      // встаёт в очередь за ним и не обгоняет более ранние.
      const missed = prevOpen !== undefined && start > prevOpen && (k.lastConfirmed ?? -Infinity) < prevOpen;
      if (k.needsBackfill || missed) {
        k.needsBackfill = false;
        this.backfillCandles(entry, start).catch((err) => this.logger?.error(`${entry.topic}: добор свечей: ${err?.stack ?? err}`));
      }
      k.openStart = Math.max(prevOpen ?? -Infinity, start);
      if (item.confirm) {
        k.lastConfirmed = Math.max(k.lastConfirmed ?? -Infinity, start);
        this.closedCandle(entry, candle);
      }
    }
  }

  // Закрытая свеча для всех условий темы; пока идёт добор по REST — в очередь за ним.
  closedCandle(entry, candle) {
    const k = entry.candle;
    if (k.backfilling) {
      k.deferred.push(candle);
      return;
    }
    for (const cond of entry.conditions) this.route(cond, candle);
  }

  // Добор закрытых свечей по REST. Пока он идёт, закрытия из потока ждут в очереди; если за
  // это время обнаружится ещё один пропуск, добор продолжится до новой границы.
  async backfillCandles(entry, untilStart) {
    const k = entry.candle;
    k.backfillUntil = Math.max(k.backfillUntil ?? -Infinity, untilStart);
    if (k.backfilling) return;
    k.backfilling = true;
    k.deferred = [];
    try {
      while (Number.isFinite(k.backfillUntil)) {
        const until = k.backfillUntil;
        k.backfillUntil = undefined;
        await this.backfillRange(entry, until);
      }
    } finally {
      k.backfilling = false;
      k.backfillUntil = undefined;
      const deferred = k.deferred;
      k.deferred = [];
      for (const c of deferred) this.closedCandle(entry, c);
    }
  }

  async backfillRange(entry, until) {
    // Условия, которые ещё настраиваются, тоже в счёт: свечи дождутся их в очереди route().
    const conds = [...entry.conditions].filter((c) => c.alert.state === 'active' && !c.done && c.lastClosedStart !== undefined);
    if (!conds.length) return;
    const from = Math.min(...conds.map((c) => c.lastClosedStart + 1));
    if (!Number.isFinite(from) || from >= until) return;
    const cond = conds[0];
    let rows;
    try {
      const result = await this.rest(cond, {
        path: '/v5/market/kline',
        params: { category: cond.category, symbol: cond.symbol, interval: cond.interval, start: from, end: until - 1, limit: 1000 },
        sign: false,
      });
      rows = (result.list ?? [])
        .map((r) => ({ start: Number(r[0]), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], turnover: r[6] }))
        .filter((c) => Number.isFinite(c.start) && c.start >= from && c.start < until)
        .sort((a, b) => a.start - b.start);
    } catch (err) {
      this.logger?.warn(`${entry.topic}: не удалось добрать закрытые свечи: ${err.message}`);
      for (const c of conds) {
        if (c.ready) {
          this.enqueue(c.alert, { kind: 'check_failed', condition: c.index, summary: `${c.text}: could not check candles closed during a stream gap (${err.message})` });
        }
      }
      return;
    }
    rows.forEach((c, i) => {
      c.end = (rows[i + 1]?.start ?? until) - 1;
      c.source = 'rest';
    });
    for (const c of rows) for (const target of entry.conditions) this.route(target, c);
  }

  onFeedState(feedKey, info) {
    const meta = this.feeds.get(feedKey);
    if (!meta) return;
    if (info.state === 'ready') {
      clearTimeout(meta.noticeTimer);
      meta.noticeTimer = null;
      if (meta.noticeSent) {
        meta.noticeSent = false;
        this.streamNotice(feedKey, 'stream_restored', meta.downAt ? this.now() - meta.downAt : 0);
      }
      meta.downAt = null;
    } else if (info.state === 'waiting') {
      meta.downAt ??= info.downSince ?? this.now();
      meta.lastError = info.error;
      for (const entry of this.topics.values()) {
        if (entry.feedKey !== feedKey) continue;
        // Снимок тикера до обрыва устарел: новое оповещение дождётся свежего после переподписки.
        if (entry.topic.startsWith('tickers.')) entry.ticker = null;
        else if (entry.topic.startsWith('kline.')) entry.candle.needsBackfill = true;
        else entry.needsResync = true;
      }
      if (!meta.noticeTimer && !meta.noticeSent) {
        meta.noticeTimer = setTimeout(() => {
          meta.noticeTimer = null;
          if (meta.feed.state === 'ready' || meta.feed.state === 'closed') return;
          meta.noticeSent = true;
          this.streamNotice(feedKey, 'stream_down', 0);
        }, this.timing.streamNoticeMs);
        meta.noticeTimer.unref?.();
      }
    }
  }

  // Подписка на тему снова работает. Для ордеров и позиций после обрыва — сверка по REST:
  // только теперь, иначе исполнение между сверкой и подпиской потерялось бы.
  onTopicAcked(feedKey, topic) {
    const entry = this.topics.get(`${feedKey} ${topic}`);
    if (!entry?.needsResync) return;
    entry.needsResync = false;
    this.resync(entry);
  }

  streamNotice(feedKey, kind, downForMs) {
    const meta = this.feeds.get(feedKey);
    for (const alert of this.alerts.values()) {
      if (alert.state !== 'active') continue;
      const conds = alert.conditions.filter((c) => c.feedKey === feedKey && c.ready && !c.done);
      if (!conds.length) continue;
      const list = conds.map((c) => c.index).join(', ');
      let summary;
      if (kind === 'stream_down') {
        summary =
          `Bybit ${meta.label} stream is disconnected since ${clock(meta.downAt ?? this.now())}` +
          `${meta.lastError ? ` (${meta.lastError})` : ''}; conditions ${list} are not checked until it reconnects`;
      } else {
        const notes = [];
        if (conds.some((c) => c.type === 'ticker')) notes.push('ticker moves during the gap were not seen');
        if (conds.some((c) => c.type === 'candle')) notes.push('closed candles are checked via REST');
        if (conds.some((c) => c.type === 'position' || (c.type === 'order' && (c.orderId || c.orderLinkId)))) notes.push('orders and positions are re-checked via REST');
        if (conds.some((c) => c.type === 'order' && !c.orderId && !c.orderLinkId)) notes.push('updates of other orders during the gap may be missed');
        summary = `Bybit ${meta.label} stream is back after ${duration(downForMs)}; ${notes.join('; ')}`;
      }
      this.enqueue(alert, { kind, summary });
    }
  }

  // Сверка ордеров по id и позиций по REST — по запросу на каждый ордер и каждую пару
  // категория + символ, сколько бы условий на них ни смотрело.
  resync(entry) {
    const groups = new Map();
    for (const cond of entry.conditions) {
      if (!cond.ready || cond.alert.state !== 'active' || cond.done) continue;
      let key;
      if (cond.type === 'position') key = `position ${cond.category} ${cond.symbol}`;
      else if (cond.type === 'order' && (cond.orderId || cond.orderLinkId)) key = `order ${cond.category} ${cond.orderId ?? ''} ${cond.orderLinkId ?? ''}`;
      else continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cond);
    }
    for (const conds of groups.values()) {
      const [first] = conds;
      if (first.type === 'position') {
        this.fetchPositions(first)
          .then((map) => {
            for (const cond of conds) {
              for (const [idx, p] of map) this.applyPosition(cond, idx, p, {}, { source: 'rest' });
              for (const [idx, prev] of cond.positions ?? []) {
                if (!map.has(idx) && prev.size > 0) this.applyPosition(cond, idx, { ...prev, size: 0, side: '' }, {}, { source: 'rest' });
              }
            }
          })
          .catch((err) => this.logger?.warn(`${first.text}: сверка позиции после обрыва не удалась: ${err.message}`));
      } else {
        this.lookupOrder(first)
          .then((order) => {
            if (order) for (const cond of conds) this.evaluateOrder(cond, order, { source: 'rest' });
          })
          .catch((err) => this.logger?.warn(`${first.text}: сверка ордера после обрыва не удалась: ${err.message}`));
      }
    }
  }

  // Bybit отказал в повторной подписке (например, инструмент сняли с торгов).
  onTopicFailed(feedKey, topic, reason) {
    const entry = this.topics.get(`${feedKey} ${topic}`);
    if (!entry) return;
    for (const cond of [...entry.conditions]) {
      if (!cond.ready) continue; // создание оповещения получит ошибку само
      const alert = cond.alert;
      cond.done = true;
      cond.failed = reason;
      this.detach(cond);
      this.enqueue(alert, { kind: 'condition_failed', condition: cond.index, summary: `${cond.text}: no longer checked, Bybit rejected the subscription (${reason})` });
      if (alert.conditions.every((c) => c.done)) this.finish(alert);
    }
  }

  // ---------- проверка условий ----------

  evaluateTicker(cond, entry, { initial = false }) {
    const alert = cond.alert;
    if (alert.state !== 'active' || cond.done) return;
    const raw = entry.ticker.data[cond.field];
    const value = toNumber(raw);
    if (value === null) return;
    cond.current = raw;
    const up = cond.upper !== undefined && value >= cond.upper;
    const down = cond.lower !== undefined && value <= cond.lower;
    const met = up || down;
    if (alert.frequency === 'every_time') {
      // Снова — только после того, как условие перестало выполняться, и не чаще cooldown.
      if (!met) {
        cond.armed = true;
        return;
      }
      if (!cond.armed || (cond.lastFiredAt !== undefined && this.now() - cond.lastFiredAt < alert.cooldownMs)) return;
      cond.armed = false;
    } else if (!met) return;
    const level = up ? `>= ${cond.upper}` : `<= ${cond.lower}`;
    const from = cond.reference !== undefined ? ` (${cond.op.replace('_pct', '')} ${cond.value}% from ${cond.reference})` : '';
    this.fire(cond, {
      summary: `${cond.symbol} ${cond.category} ${cond.field} ${raw} ${level}${from}${initial ? '; already true when the alert was created' : ''}`,
      value: raw,
      at: entry.ticker.ts,
      initial,
      data: pick(entry.ticker.data, [cond.field, ...TICKER_DATA_FIELDS]),
    });
  }

  candleClosed(cond, candle) {
    const alert = cond.alert;
    if (alert.state !== 'active' || cond.done) return;
    if (candle.start <= cond.lastClosedStart) return;
    cond.lastClosedStart = candle.start;
    if (candle.end < cond.createdAt) return; // закрылась раньше, чем создано оповещение
    const value = candleValue(candle, cond.field);
    if (value === null) return;
    cond.current = `${candle.close} (last closed candle)`;
    if (cond.op === 'above' ? value < cond.value : value > cond.value) return;
    const shown = cond.field.endsWith('_pct') ? `${roundLevel(value).toFixed(3)}%` : String(candle[cond.field]);
    this.fire(cond, {
      summary:
        `${cond.symbol} ${cond.category} ${intervalLabel(cond.interval)} candle ${candleSpan(candle, cond.interval)} closed: ` +
        `${cond.field} ${shown} ${cond.op === 'above' ? '>=' : '<='} ${cond.value}`,
      value: cond.field.endsWith('_pct') ? String(roundLevel(value)) : candle[cond.field],
      at: candle.end + 1,
      source: candle.source,
      data: { start: iso(candle.start), ...pick(candle, ['open', 'high', 'low', 'close', 'volume', 'turnover']) },
    });
  }

  evaluateOrder(cond, order, { initial = false, source }) {
    const alert = cond.alert;
    if (alert.state !== 'active' || cond.done) return;
    if (cond.category && order.category !== cond.category) return;
    if (cond.symbol && order.symbol !== cond.symbol) return;
    if (cond.orderId && order.orderId !== cond.orderId) return;
    if (cond.orderLinkId && order.orderLinkId !== cond.orderLinkId) return;
    if (cond.orderId || cond.orderLinkId) cond.current = order.orderStatus;
    if (!cond.statuses.includes(order.orderStatus)) return;
    // Bybit может прислать одно и то же состояние дважды (например, два Filled при отмене).
    cond.seen ??= new Set();
    const key = `${order.orderId}|${order.orderStatus}|${order.cumExecQty}`;
    if (cond.seen.has(key)) return;
    if (cond.seen.size > 500) cond.seen.clear();
    cond.seen.add(key);
    const filled = order.cumExecQty !== undefined ? `, filled ${order.cumExecQty}/${order.qty}` : '';
    const avg = order.avgPrice ? `, avg ${order.avgPrice}` : '';
    const price = order.price && order.orderType !== 'Market' ? ` @ ${order.price}` : '';
    this.fire(cond, {
      summary:
        `${cond.env} ${order.category ?? ''} ${order.side ?? ''} ${order.orderType ?? ''} ${order.symbol ?? ''}${price}: ` +
        `${order.orderStatus}${filled}${avg}${initial ? '; already so when the alert was created' : ''}`.replace(/\s+/g, ' '),
      value: order.orderStatus,
      at: toNumber(order.updatedTime) ?? undefined,
      initial,
      source,
      data: pick(order, ORDER_DATA_FIELDS),
    });
  }

  evaluatePosition(cond, p, { source }) {
    if (p.category !== cond.category || p.symbol !== cond.symbol) return;
    this.applyPosition(cond, Number(p.positionIdx ?? 0), positionState(p), p, { source });
  }

  applyPosition(cond, idx, next, raw, { source }) {
    const alert = cond.alert;
    if (alert.state !== 'active' || cond.done) return;
    const prev = cond.positions.get(idx) ?? { size: 0, side: '', seq: -Infinity, status: 'Normal' };
    if (next.seq < prev.seq) return; // устаревшее обновление (раньше отправной точки)
    cond.positions.set(idx, next);
    cond.current = describePositions(cond.positions);
    // Размер со знаком: одной сделкой Buy 1 может стать Sell 1 — это закрытие и открытие.
    const before = signedSize(prev);
    const after = signedSize(next);
    const reversed = before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after);
    const happened = [];
    if (before !== 0 && (after === 0 || reversed)) happened.push('closed');
    if (after !== 0 && (before === 0 || reversed)) happened.push('opened');
    if (before !== after) happened.push('size_changed');
    if (!LIQUIDATION_STATUSES.has(prev.status) && LIQUIDATION_STATUSES.has(next.status)) happened.push('liquidation');
    if (!happened.includes(cond.event)) return;
    const label = reversed ? 'reversed' : happened.filter((e) => e !== 'size_changed').join(', ') || 'size changed';
    const what = cond.event === 'liquidation' ? `status ${next.status}` : `${positionLabel(prev)} -> ${positionLabel(next)}`;
    const pnl = raw?.curRealisedPnl ? `, realised PnL ${raw.curRealisedPnl}` : '';
    this.fire(cond, {
      summary: `${cond.env} ${cond.category} ${cond.symbol} position ${label}: ${what}${pnl}`,
      value: String(next.size),
      at: toNumber(raw?.updatedTime) ?? undefined,
      source,
      data: {
        ...pick(raw, POSITION_DATA_FIELDS),
        positionIdx: idx,
        previousSide: prev.side,
        previousSize: String(prev.size),
        side: next.side,
        size: String(next.size),
      },
    });
  }

  fire(cond, { summary, value, at, initial = false, source, data }) {
    const alert = cond.alert;
    if (alert.state !== 'active' || cond.done) return;
    cond.fired++;
    cond.lastFiredAt = this.now();
    if (initial) cond.firedOnCreate = true;
    const event = { condition: cond.index, summary, at: iso(at ?? this.now()) };
    if (value !== undefined) event.value = String(value);
    if (initial) event.initial = true;
    if (source && source !== 'stream') event.source = source;
    if (data && Object.keys(data).length) event.data = data;
    this.enqueue(alert, event);
    if (alert.frequency === 'once') this.finish(alert);
    else if (alert.frequency === 'once_per_condition') {
      cond.done = true;
      this.detach(cond);
      if (alert.conditions.every((c) => c.done)) this.finish(alert);
    }
  }

  // ---------- доставка ----------

  enqueue(alert, event) {
    const item = { seq: ++alert.eventSeq, at: iso(this.now()), ...event };
    alert.queue.push(item);
    alert.recent.push({ seq: item.seq, at: item.at, summary: item.summary });
    if (alert.recent.length > 10) alert.recent.shift();
    if (alert.queue.length > MAX_QUEUE) {
      const extra = alert.queue.length - MAX_QUEUE;
      alert.queue.splice(0, extra);
      alert.dropped += extra;
    }
    this.scheduleFlush(alert);
  }

  scheduleFlush(alert) {
    if (!alert.client || alert.flushTimer || !alert.queue.length) return;
    const wait = Math.max(this.timing.batchDelayMs, alert.lastFrameAt + this.timing.minFrameIntervalMs - this.now());
    alert.flushTimer = setTimeout(() => {
      alert.flushTimer = null;
      this.flush(alert);
    }, wait);
  }

  flush(alert) {
    const ws = alert.client;
    if (!ws || !alert.queue.length) return;
    const { text, count } = buildFrame(alert, alert.queue);
    const events = alert.queue.slice(0, count);
    const id = ws.sendText(text);
    if (!id) return; // соединение закрывается — события дождутся следующего
    alert.queue.splice(0, count);
    // Счёт отброшенных ушёл в этом кадре; если кадр не подтвердят, он вернётся с событиями.
    const dropped = alert.dropped;
    alert.dropped = 0;
    for (const e of events) e.deliveries = (e.deliveries ?? 0) + 1;
    alert.inflight.push({ id, events, dropped });
    alert.lastFrameAt = this.now();
    this.scheduleFlush(alert);
  }

  onAck(alert, ws, n) {
    if (alert.client !== ws) return;
    while (alert.inflight.length && alert.inflight[0].id <= n) {
      alert.delivered += alert.inflight.shift().events.length;
    }
    this.maybeComplete(alert);
  }

  // Неподтверждённое — снова в очередь (с пометкой redelivered), но не бесконечно.
  requeueInflight(alert) {
    const back = [];
    for (const { events, dropped } of alert.inflight) {
      alert.dropped += dropped;
      for (const e of events) {
        if (e.deliveries >= MAX_DELIVERIES) alert.delivered++;
        else back.push({ ...e, redelivered: true });
      }
    }
    alert.inflight = [];
    alert.queue.unshift(...back);
  }

  maybeComplete(alert) {
    if (alert.state !== 'finished' || alert.queue.length || alert.inflight.length) return;
    this.end(alert, 'finished', CLOSE_CODES.finished, `alert ${alert.id} finished: all events delivered`);
  }

  onConnection(path, ws) {
    const token = /^\/alerts\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
    const alert = token ? this.byToken.get(token) : undefined;
    if (!alert) {
      const gone = token ? this.tombstones.get(token) : undefined;
      if (gone) ws.close(gone.code, gone.reason);
      else ws.close(CLOSE_CODES.unknown, `unknown alert: the connector restarted or the URL is wrong; see ${TOOL.listAlerts}`);
      return;
    }
    const previous = alert.client;
    if (previous) {
      alert.client = null;
      clearTimeout(alert.flushTimer);
      alert.flushTimer = null;
      this.requeueInflight(alert);
      previous.close(CLOSE_CODES.replaced, 'replaced by a newer Monitor connection to this alert');
    }
    alert.client = ws;
    alert.connections++;
    ws.onAck = (n) => this.onAck(alert, ws, n);
    ws.onClose = () => {
      if (alert.client !== ws) return;
      alert.client = null;
      clearTimeout(alert.flushTimer);
      alert.flushTimer = null;
      this.requeueInflight(alert);
      // Событие, исчерпавшее повторы, считается доставленным — оповещение может закончиться.
      this.maybeComplete(alert);
    };
    this.scheduleFlush(alert);
    this.maybeComplete(alert);
  }

  // ---------- жизненный цикл ----------

  // Условий больше не проверять; оповещение закончится, когда события доставлены.
  finish(alert) {
    if (alert.state !== 'active') return;
    alert.state = 'finished';
    for (const c of alert.conditions) this.detach(c);
    this.maybeComplete(alert);
  }

  expire(alert) {
    const left = alert.queue.length + alert.inflight.reduce((n, f) => n + f.events.length, 0);
    this.end(alert, 'expired', CLOSE_CODES.expired, `alert ${alert.id} expired${left ? ` with ${left} undelivered event(s)` : ''}`);
  }

  end(alert, state, code, reason) {
    if (alert.ended) return;
    alert.ended = true;
    alert.state = state;
    clearTimeout(alert.expiryTimer);
    clearTimeout(alert.flushTimer);
    for (const c of alert.conditions) this.detach(c);
    this.alerts.delete(alert.id);
    this.byToken.delete(alert.token);
    this.tombstones.set(alert.token, { code, reason, at: this.now() });
    this.pruneTombstones();
    this.endedLog.push({ alert_id: alert.id, status: state, reason, ended_at: iso(this.now()), events_delivered: alert.delivered });
    if (this.endedLog.length > MAX_ENDED_LOG) this.endedLog.shift();
    const ws = alert.client;
    alert.client = null;
    ws?.close(code, reason);
  }

  pruneTombstones() {
    const cutoff = this.now() - this.timing.tombstoneMs;
    for (const [token, t] of this.tombstones) {
      if (t.at < cutoff || this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(token);
      else break;
    }
  }

  cancel({ alert_id: id, all } = {}) {
    if (!all && !id) throw new ToolError('Pass alert_id, or all=true to cancel every alert.');
    const targets = all ? [...this.alerts.values()] : [this.alerts.get(String(id))].filter(Boolean);
    if (!targets.length) {
      if (all) return { cancelled: [], note: 'There were no active alerts.' };
      const active = [...this.alerts.keys()];
      throw new ToolError(`No active alert "${id}". Active alerts: ${active.length ? active.join(', ') : 'none'}.`);
    }
    for (const alert of targets) this.end(alert, 'cancelled', CLOSE_CODES.cancelled, `alert ${alert.id} cancelled`);
    return { cancelled: targets.map((a) => a.id), active_left: this.alerts.size };
  }

  async ensureServer() {
    if (this.server) return this.server;
    this.serverStarting ??= startLocalServer({
      onConnection: (path, ws) => this.onConnection(path, ws),
      logger: this.logger,
      socketOptions: this.socketOptions,
    }).then(
      (server) => {
        this.server = server;
        this.logger?.info(`оповещения: WebSocket для Monitor на 127.0.0.1:${server.port}`);
        return server;
      },
      (err) => {
        this.serverStarting = null;
        throw new ToolError(`Could not start the local WebSocket server for alerts: ${err.message}`);
      },
    );
    return this.serverStarting;
  }

  // Завершение коннектора: Monitor узнаёт причину, потоки закрываются.
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const alert of [...this.alerts.values()]) {
      clearTimeout(alert.expiryTimer);
      clearTimeout(alert.flushTimer);
      alert.client?.close(CLOSE_CODES.stopped, 'Bybit connector stopped: its alerts are gone; create them again after it restarts');
      alert.client = null;
    }
    this.alerts.clear();
    this.byToken.clear();
    for (const meta of this.feeds.values()) {
      clearTimeout(meta.noticeTimer);
      meta.feed.close();
    }
    this.feeds.clear();
    this.topics.clear();
    const server = this.server ?? (await this.serverStarting?.catch(() => null));
    if (server) {
      await new Promise((r) => setTimeout(r, this.timing.closeGraceMs));
      await server.close();
    }
  }

  // ---------- ответы инструментов ----------

  // Описание Monitor повторяется в каждом уведомлении — поэтому коротко.
  monitorFor(alert) {
    const more = alert.conditions.length > 1 ? ` (+${alert.conditions.length - 1} more)` : '';
    return {
      ws: { url: this.server.url(`/alerts/${alert.token}`) },
      description: `Bybit alert ${alert.id}: ${shortText(alert.conditions[0])}${more}`,
      timeout_ms: MONITOR_TIMEOUT_MS,
    };
  }

  describeCreated(alert) {
    const out = {
      alert_id: alert.id,
      status: alert.state,
      frequency: alert.frequency,
    };
    if (alert.frequency === 'every_time') out.cooldown_seconds = alert.cooldownMs / 1000;
    out.expires_at = iso(alert.expiresAt);
    if (alert.note) out.note = alert.note;
    out.conditions = alert.conditions.map((c) => ({
      index: c.index,
      condition: c.text,
      current: c.current,
      ...(c.firedOnCreate ? { already_met: true } : c.fired ? { fired: c.fired } : {}),
    }));
    const fired = alert.conditions.filter((c) => c.fired).length;
    if (fired) out.fired_on_creation = `${fired} condition(s) already fired: the event(s) arrive as soon as Monitor connects`;
    out.monitor = this.monitorFor(alert);
    out.how_to_wait = HOW_TO_WAIT;
    return out;
  }

  describe(alert) {
    return {
      alert_id: alert.id,
      status: alert.state,
      frequency: alert.frequency,
      created_at: iso(alert.createdAt),
      expires_at: iso(alert.expiresAt),
      ...(alert.note ? { note: alert.note } : {}),
      monitor_connected: Boolean(alert.client),
      events_fired: alert.eventSeq,
      events_pending: alert.queue.length + alert.inflight.reduce((n, f) => n + f.events.length, 0),
      conditions: alert.conditions.map((c) => ({
        index: c.index,
        condition: c.text,
        current: c.current,
        fired: c.fired,
        ...(c.done ? { done: true } : {}),
        ...(c.failed ? { failed: c.failed } : {}),
      })),
      recent_events: alert.recent.slice(-5),
      monitor: this.monitorFor(alert),
    };
  }

  list() {
    const streams = [...this.feeds.values()]
      .filter((m) => m.feed.state !== 'idle' || m.feed.topics.size)
      .map((m) => ({
        stream: m.label,
        state: m.feed.state,
        topics: m.feed.topics.size,
        ...(m.feed.downSince ? { down_since: iso(m.feed.downSince) } : {}),
        ...(m.feed.lastError && m.feed.state !== 'ready' ? { error: m.feed.lastError } : {}),
      }));
    return {
      alerts: [...this.alerts.values()].map((a) => this.describe(a)),
      ...(this.endedLog.length ? { recently_ended: this.endedLog.slice(-10) } : {}),
      ...(streams.length ? { streams } : {}),
    };
  }
}
