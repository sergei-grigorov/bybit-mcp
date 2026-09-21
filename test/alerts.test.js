// Оповещения: условия, доставка в Monitor, жизненный цикл. Bybit поддельный, локальный
// WebSocket-сервер настоящий, в роли Monitor — встроенный клиент WebSocket.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AlertManager, buildFrame, CLOSE_CODES, FRAME_MAX_CHARS } from '../server/alerts.js';
import { createServer } from '../server/index.js';
import { OP } from '../server/wsserver.js';
import { fakeBybit } from './fake-bybit.js';
import { makeExecutor, silentLogger, TEST_KEYS } from './helpers.js';
import { rawConnect, serverFrames, sleep, until } from './ws-client.js';

const DEMO = { BYBIT_DEMO_API_KEY: TEST_KEYS.BYBIT_DEMO_API_KEY, BYBIT_DEMO_API_SECRET: TEST_KEYS.BYBIT_DEMO_API_SECRET };
const FAST_TIMING = { batchDelayMs: 5, minFrameIntervalMs: 10, streamNoticeMs: 60, closeGraceMs: 5, setupTimeoutMs: 3000, firstTickerMs: 1000 };
const FAST_FEED = { reconnectDelaysMs: [15], idleCloseMs: 50, pingIntervalMs: 60_000 };

const ok = (result) => ({ json: { retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: Date.now() } });
const queryOf = (call) => Object.fromEntries(new URLSearchParams(call.rawQuery));

function makeAlerts(t, { env = {}, handler, timing = {}, bybit = fakeBybit(), now } = {}) {
  const { executor, config, calls } = makeExecutor({ env, handler });
  const manager = new AlertManager({
    config,
    executor,
    logger: silentLogger,
    WebSocketImpl: bybit.FakeWebSocket,
    timing: { ...FAST_TIMING, ...timing },
    feedTiming: FAST_FEED,
    socketOptions: { closeWaitMs: 50 },
    ...(now ? { now } : {}),
  });
  t.after(() => manager.close());
  return { manager, bybit, calls };
}

// Monitor: кадры (JSON) и закрытие.
function monitor(url) {
  const ws = new WebSocket(url);
  const m = { ws, frames: [], close: null };
  ws.onmessage = (e) => m.frames.push(JSON.parse(e.data));
  m.closed = new Promise((resolve) => (ws.onclose = (e) => resolve((m.close = { code: e.code, reason: e.reason }))));
  m.events = () => m.frames.flatMap((f) => f.events);
  m.open = () => until(() => ws.readyState === WebSocket.OPEN);
  return m;
}

const pathOf = (url) => new URL(url).pathname;
const portOf = (url) => Number(new URL(url).port);

test('тикер достиг уровня: одно событие в Monitor, затем закрытие 4000', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '65000.5', markPrice: '65001', bid1Price: '65000.4' });
  const res = await manager.create({
    conditions: [{ type: 'ticker', category: 'linear', symbol: 'btcusdt', op: 'above', value: 70000 }],
    note: 'buy the breakout',
  });
  assert.equal(res.status, 'active');
  assert.deepEqual(res.conditions, [{ index: 1, condition: 'BTCUSDT linear lastPrice >= 70000', current: '65000.5' }]);
  assert.match(res.monitor.ws.url, /^ws:\/\/127\.0\.0\.1:\d+\/alerts\/[A-Za-z0-9_-]{24}$/);
  assert.equal(res.monitor.timeout_ms, 1_800_000);
  assert.equal(res.monitor.description, `Bybit alert ${res.alert_id}: BTCUSDT lastPrice >= 70000`);
  assert.match(res.how_to_wait, /Monitor/);

  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '69999.9' });
  await sleep(40);
  assert.equal(mon.frames.length, 0, 'пока условие не выполнено — тишина');
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '70000.0' });
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '70100.0' });
  const close = await mon.closed;
  assert.equal(close.code, CLOSE_CODES.finished);
  assert.equal(close.reason, `alert ${res.alert_id} finished: all events delivered`);
  assert.equal(mon.frames.length, 1);
  const [frame] = mon.frames;
  assert.equal(frame.alert, res.alert_id);
  assert.equal(frame.note, 'buy the breakout');
  assert.equal(frame.status, 'finished');
  assert.equal(frame.events.length, 1, 'после первого события оповещение once больше не срабатывает');
  assert.equal(frame.events[0].summary, 'BTCUSDT linear lastPrice 70000.0 >= 70000');
  assert.equal(frame.events[0].value, '70000.0');
  assert.equal(frame.events[0].data.markPrice, '65001');

  const list = manager.list();
  assert.deepEqual(list.alerts, []);
  assert.equal(list.recently_ended[0].status, 'finished');
  assert.equal(list.recently_ended[0].events_delivered, 1);
  // Тема больше никому не нужна — отписка.
  await until(() => bybit.state.sockets[0].sent.some((m) => m.op === 'unsubscribe'));
  // Повторное подключение к закончившемуся оповещению — тот же код и причина.
  const again = monitor(res.monitor.ws.url);
  assert.equal((await again.closed).code, CLOSE_CODES.finished);
});

test('условие уже выполнено при создании: событие приходит сразу при подключении', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.ETHUSDT', { symbol: 'ETHUSDT', lastPrice: '2990' });
  const res = await manager.create({ conditions: [{ type: 'ticker', category: 'spot', symbol: 'ETHUSDT', op: 'below', value: 3000 }] });
  assert.equal(res.status, 'finished');
  assert.equal(res.conditions[0].already_met, true);
  assert.match(res.fired_on_creation, /^1 condition\(s\) already fired/);
  const mon = monitor(res.monitor.ws.url);
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  const [event] = mon.events();
  assert.equal(event.initial, true);
  assert.equal(event.summary, 'ETHUSDT spot lastPrice 2990 <= 3000; already true when the alert was created');
});

test('проценты превращаются в уровни от текущего значения; once_per_condition', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100.00' });
  const res = await manager.create({
    conditions: [
      { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'rise_pct', value: 2 },
      { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'fall_pct', value: 5 },
      { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'move_pct', value: 1 },
    ],
    frequency: 'once_per_condition',
  });
  assert.deepEqual(
    res.conditions.map((c) => c.condition),
    [
      'BTCUSDT linear lastPrice >= 102 (+2% from 100.00)',
      'BTCUSDT linear lastPrice <= 95 (-5% from 100.00)',
      'BTCUSDT linear lastPrice >= 101 or <= 99 (+/-1% from 100.00)',
    ],
  );
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '101.50' });
  await until(() => mon.events().length === 1);
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '102.10' });
  await until(() => mon.events().length === 2);
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '98.00' });
  await sleep(30);
  assert.equal(mon.events().length, 2, 'условие 3 уже сработало, 2 ещё не выполнено');
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '94.99' });
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  assert.deepEqual(mon.events().map((e) => e.condition), [3, 1, 2]);
  assert.equal(mon.events()[0].summary, 'BTCUSDT linear lastPrice 101.50 >= 101 (move 1% from 100.00)');
  assert.deepEqual(mon.frames.map((f) => f.status), ['active', 'active', 'finished']);
});

test('every_time: снова только после сброса условия и не чаще cooldown', async (t) => {
  let clock = 1_000_000;
  const { manager, bybit } = makeAlerts(t, { now: () => clock });
  bybit.state.snapshots.set('tickers.SOLUSDT', { symbol: 'SOLUSDT', lastPrice: '100' });
  const res = await manager.create({
    conditions: [{ type: 'ticker', category: 'linear', symbol: 'SOLUSDT', op: 'above', value: 105 }],
    frequency: 'every_time',
    cooldown_seconds: 60,
  });
  assert.equal(res.cooldown_seconds, 60);
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  const push = (price) => bybit.ticker('linear', 'SOLUSDT', { lastPrice: price });
  push('106');
  await until(() => mon.events().length === 1);
  push('107'); // всё ещё выше — не повторяется
  push('104'); // сброс
  clock += 30_000;
  push('106'); // рано: cooldown
  await sleep(30);
  assert.equal(mon.events().length, 1);
  clock += 31_000;
  push('106.5');
  await until(() => mon.events().length === 2);
  assert.equal(mon.events()[1].value, '106.5');
  assert.equal(mon.frames.at(-1).status, 'active');
  assert.equal(manager.list().alerts[0].conditions[0].fired, 2);
});

test('ошибки условий объясняют, что не так, и не оставляют подписок', async (t) => {
  const bybit = fakeBybit({ failTopics: ['tickers.NOPEUSDT'] });
  const { manager } = makeAlerts(t, { bybit });
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '1', fundingRate: '', markPrice: '1.1' });
  const create = (condition, extra = {}) => manager.create({ conditions: [condition], ...extra });
  const btc = { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 2 };
  await assert.rejects(create({ ...btc, field: 'fooBar' }), /no numeric ticker field "fooBar"\. Numeric fields: lastPrice, markPrice\./);
  await assert.rejects(create({ ...btc, field: 'fundingRate' }), /it is empty for this instrument/);
  await assert.rejects(create({ ...btc, symbol: 'NOPEUSDT' }), /conditions\[0\] \(NOPEUSDT linear lastPrice above 2\): error:handler not found,topic:tickers\.NOPEUSDT/);
  await assert.rejects(create({ ...btc, interval: '5' }), /"interval" does not apply to type "ticker"/);
  await assert.rejects(create({ ...btc, op: 'rise_pct', value: 0 }), /rise_pct needs a percent value above 0/);
  await assert.rejects(create({ type: 'candle', category: 'option', symbol: 'BTC-1', interval: '5', op: 'above', value: 1 }), /candles exist for spot, linear, inverse only/);
  await assert.rejects(create({ type: 'order', category: 'linear' }), /No API key configured for the real account/);
  await assert.rejects(create(btc, { frequency: 'sometimes' }), /frequency must be one of/);
  await assert.rejects(manager.create({ conditions: Array.from({ length: 11 }, () => btc) }), /At most 10 conditions/);
  // Одно условие из двух провалилось — второе тоже откатывается.
  await assert.rejects(manager.create({ conditions: [btc, { ...btc, symbol: 'NOPEUSDT' }] }), /handler not found/);
  assert.equal(manager.topics.size, 0);
  assert.equal(manager.alerts.size, 0);
});

test('события копятся без Monitor; неподтверждённое после обрыва приходит снова с пометкой', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const res = await manager.create({ conditions: [{ type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 110 }] });
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '111' }); // Monitor ещё не подключён
  await sleep(20);
  assert.equal(manager.list().alerts[0].events_pending, 1);
  // Клиент, который читает кадр, но не отвечает на ping, и обрывается.
  const raw = await rawConnect(portOf(res.monitor.ws.url), { path: pathOf(res.monitor.ws.url) });
  await until(() => serverFrames(raw.data).some((f) => f.opcode === OP.text));
  const first = JSON.parse(serverFrames(raw.data).find((f) => f.opcode === OP.text).payload.toString());
  assert.equal(first.events[0].redelivered, undefined);
  raw.socket.resetAndDestroy();
  await until(() => !manager.list().alerts[0]?.monitor_connected);
  const mon = monitor(res.monitor.ws.url);
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  assert.equal(mon.events().length, 1);
  assert.equal(mon.events()[0].redelivered, true);
  assert.equal(mon.events()[0].seq, first.events[0].seq);
});

test('новое подключение Monitor вытесняет старое (4001)', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const res = await manager.create({ conditions: [{ type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 110 }] });
  const first = monitor(res.monitor.ws.url);
  await first.open();
  const second = monitor(res.monitor.ws.url);
  const replaced = await first.closed;
  assert.equal(replaced.code, CLOSE_CODES.replaced);
  await second.open();
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '120' });
  assert.equal((await second.closed).code, CLOSE_CODES.finished);
  assert.equal(second.events().length, 1);
  assert.equal(first.events().length, 0);
});

test('отмена (4002), истечение срока (4003), неизвестный адрес (4004), остановка коннектора (4005)', async (t) => {
  const { manager, bybit } = makeAlerts(t, { timing: { minuteMs: 40 } });
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const cond = { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 110 };

  const a = await manager.create({ conditions: [cond], expires_in_minutes: 1000 });
  const ma = monitor(a.monitor.ws.url);
  await ma.open();
  assert.deepEqual(manager.cancel({ alert_id: a.alert_id }), { cancelled: [a.alert_id], active_left: 0 });
  assert.deepEqual(await ma.closed, { code: CLOSE_CODES.cancelled, reason: `alert ${a.alert_id} cancelled` });
  assert.equal((await monitor(a.monitor.ws.url).closed).code, CLOSE_CODES.cancelled, 'адрес помнит, чем кончилось');
  assert.throws(() => manager.cancel({ alert_id: 'nope' }), /No active alert "nope"\. Active alerts: none/);

  const b = await manager.create({ conditions: [cond], expires_in_minutes: 1 });
  const mb = monitor(b.monitor.ws.url);
  const expired = await mb.closed;
  assert.equal(expired.code, CLOSE_CODES.expired);
  assert.equal(expired.reason, `alert ${b.alert_id} expired`);

  const unknown = monitor(a.monitor.ws.url.replace(/alerts\/.*/, 'alerts/AAAAAAAAAAAAAAAAAAAAAAAA'));
  const u = await unknown.closed;
  assert.equal(u.code, CLOSE_CODES.unknown);
  assert.match(u.reason, /connector restarted or the URL is wrong/);

  const c = await manager.create({ conditions: [cond], expires_in_minutes: 1000 });
  const mc = monitor(c.monitor.ws.url);
  await mc.open();
  await manager.close();
  const stopped = await mc.closed;
  assert.equal(stopped.code, CLOSE_CODES.stopped);
  assert.match(stopped.reason, /alerts are gone/);
});

test('свеча: закрытие после создания, старые свечи не считаются, пропуск добирается по REST', async (t) => {
  const minute = 60_000;
  const s0 = Math.floor(Date.now() / minute) * minute;
  const candleRow = (start, close) => [String(start), '100', '110', '90', String(close), '5', '500'];
  const { manager, bybit, calls } = makeAlerts(t, {
    handler: (call) => {
      const q = queryOf(call);
      if (call.path !== '/v5/market/kline') return ok({});
      if (q.start) return ok({ list: [candleRow(s0 + 2 * minute, 107), candleRow(s0 + minute, 104)] });
      return ok({ list: [candleRow(s0, 100.5)] });
    },
  });
  const res = await manager.create({
    conditions: [{ type: 'candle', category: 'linear', symbol: 'BTCUSDT', interval: '1', op: 'above', value: 105 }],
    frequency: 'every_time',
  });
  assert.deepEqual(res.conditions[0], { index: 1, condition: 'BTCUSDT linear 1m candle close >= 105', current: '100.5 (candle in progress)' });
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  const kline = (start, close, confirm) =>
    bybit.push('/v5/public/linear', {
      topic: 'kline.1.BTCUSDT',
      type: 'snapshot',
      ts: Date.now(),
      data: [{ start, end: start + minute - 1, interval: '1', open: '100', high: '110', low: '90', close: String(close), volume: '5', turnover: '500', confirm }],
    });
  kline(s0 - minute, 120, true); // закрылась до создания оповещения
  kline(s0, 106, true);
  await until(() => mon.events().length === 1);
  assert.match(mon.events()[0].summary, /^BTCUSDT linear 1m candle \d\d:\d\d-\d\d:\d\d UTC closed: close 106 >= 105$/);
  assert.equal(mon.events()[0].data.close, '106');
  // Свеча s0+1 не получила закрытия (обрыв), пришла уже s0+3 — добор s0+1 и s0+2 по REST.
  kline(s0 + minute, 101, false);
  kline(s0 + 3 * minute, 101, false);
  await until(() => mon.events().length === 2);
  assert.equal(mon.events()[1].value, '107');
  assert.equal(mon.events()[1].source, 'rest');
  const backfill = calls.find((c) => c.path === '/v5/market/kline' && queryOf(c).start);
  assert.deepEqual(queryOf(backfill), { category: 'linear', symbol: 'BTCUSDT', interval: '1', start: String(s0 + 1), end: String(s0 + 3 * minute - 1), limit: '1000' });
  kline(s0 + 2 * minute, 108, true); // запоздалое закрытие уже проверенной свечи
  await sleep(30);
  assert.equal(mon.events().length, 2);
});

test('ордер по orderLinkId: статус по REST, событие по приватному потоку, авторизация демо-ключом', async (t) => {
  let status = 'New';
  const order = () => ({ orderId: '111', orderLinkId: 'mcp-a', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', price: '60000', qty: '0.01', cumExecQty: '0', orderStatus: status });
  const { manager, bybit, calls } = makeAlerts(t, {
    env: DEMO,
    handler: (call) => (call.path === '/v5/order/realtime' ? ok({ list: [order()] }) : ok({ list: [] })),
  });
  const res = await manager.create({ conditions: [{ type: 'order', category: 'linear', order_link_id: 'mcp-a' }] });
  assert.deepEqual(res.conditions[0], {
    index: 1,
    condition: 'demo order orderLinkId=mcp-a (linear) -> Filled/PartiallyFilledCanceled/Cancelled/Rejected/Deactivated',
    current: 'New',
  });
  const lookup = calls.find((c) => c.path === '/v5/order/realtime');
  assert.equal(lookup.origin, 'https://api-demo.bybit.com');
  assert.deepEqual(queryOf(lookup), { category: 'linear', orderLinkId: 'mcp-a' });
  assert.equal(lookup.headers['x-bapi-api-key'], TEST_KEYS.BYBIT_DEMO_API_KEY);
  const [priv] = bybit.live('/v5/private');
  assert.equal(priv.url, 'wss://stream-demo.bybit.com/v5/private');
  assert.equal(priv.sent[0].op, 'auth');
  assert.equal(priv.sent[0].args[0], TEST_KEYS.BYBIT_DEMO_API_KEY);
  assert.deepEqual(priv.sent[1].args, ['order']);

  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  const push = (data) => bybit.push('/v5/private', { topic: 'order', id: 'x', creationTime: Date.now(), data: [{ category: 'linear', ...order(), ...data }] });
  push({ orderStatus: 'PartiallyFilled', cumExecQty: '0.004' });
  push({ orderLinkId: 'other', orderStatus: 'Filled' });
  await sleep(30);
  assert.equal(mon.events().length, 0);
  push({ orderStatus: 'Filled', cumExecQty: '0.01', avgPrice: '59999.5', updatedTime: '1700000000000' });
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  const [event] = mon.events();
  assert.equal(event.summary, 'demo linear Buy Limit BTCUSDT @ 60000: Filled, filled 0.01/0.01, avg 59999.5');
  assert.equal(event.at, new Date(1700000000000).toISOString());
  assert.equal(event.data.orderId, '111');
});

test('ордер исполнился до подписки — событие сразу; дубли Filled не повторяются; нет ордера — ошибка', async (t) => {
  const filled = { orderId: '7', orderLinkId: 'mcp-f', symbol: 'ETHUSDT', side: 'Sell', orderType: 'Market', qty: '1', cumExecQty: '1', avgPrice: '3000', orderStatus: 'Filled' };
  const { manager, bybit } = makeAlerts(t, {
    env: DEMO,
    handler: (call) => {
      const q = queryOf(call);
      if (call.path === '/v5/order/realtime' && q.orderLinkId === 'mcp-f') return ok({ list: [filled] });
      return ok({ list: [] });
    },
  });
  await assert.rejects(
    manager.create({ conditions: [{ type: 'order', category: 'spot', order_link_id: 'mcp-x' }] }),
    /no order with orderLinkId mcp-x in spot on demo/,
  );
  const res = await manager.create({ conditions: [{ type: 'order', category: 'spot', order_link_id: 'mcp-f' }], frequency: 'every_time' });
  assert.equal(res.conditions[0].already_met, true);
  const mon = monitor(res.monitor.ws.url);
  await until(() => mon.events().length === 1);
  assert.equal(mon.events()[0].initial, true);
  assert.equal(mon.events()[0].source, 'rest');
  // Тот же Filled из потока (и второй, после неудачной отмены) — уже не новость.
  for (let i = 0; i < 2; i++) bybit.push('/v5/private', { topic: 'order', data: [{ category: 'spot', ...filled }] });
  await sleep(40);
  assert.equal(mon.events().length, 1);
});

test('позиция: отправная точка по REST, устаревшие обновления отбрасываются, закрытие', async (t) => {
  const { manager, bybit } = makeAlerts(t, {
    env: DEMO,
    handler: (call) =>
      call.path === '/v5/position/list'
        ? ok({ list: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0.01', positionIdx: 0, seq: 10, positionStatus: 'Normal' }] })
        : ok({}),
  });
  const res = await manager.create({ conditions: [{ type: 'position', category: 'linear', symbol: 'BTCUSDT', event: 'closed' }] });
  assert.deepEqual(res.conditions[0], { index: 1, condition: 'demo position linear BTCUSDT: closed', current: 'Buy 0.01' });
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  const push = (data) => bybit.push('/v5/private', { topic: 'position', data: [{ category: 'linear', symbol: 'BTCUSDT', positionIdx: 0, ...data }] });
  push({ side: '', size: '0', seq: 9 }); // старше отправной точки
  push({ side: 'Buy', size: '0.005', seq: 11 }); // частичное закрытие — не то событие
  push({ category: 'inverse', side: '', size: '0', seq: 12 }); // другая категория
  await sleep(30);
  assert.equal(mon.events().length, 0);
  push({ side: '', size: '0', seq: 13, curRealisedPnl: '12.5' });
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  const [event] = mon.events();
  assert.equal(event.summary, 'demo linear BTCUSDT position closed: Buy 0.005 -> 0, realised PnL 12.5');
  assert.deepEqual([event.data.previousSize, event.data.size], ['0.005', '0']);
});

test('поток Bybit надолго пропал и вернулся: агент узнаёт об этом', async (t) => {
  const { manager, bybit } = makeAlerts(t, { timing: { streamNoticeMs: 40 } });
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const res = await manager.create({ conditions: [{ type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 110 }], frequency: 'every_time' });
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  bybit.state.refuse = true;
  bybit.dropAll('/v5/public/linear');
  await until(() => mon.events().some((e) => e.kind === 'stream_down'));
  const down = mon.events().find((e) => e.kind === 'stream_down');
  assert.match(down.summary, /^Bybit public linear stream is disconnected since \d\d:\d\d:\d\d UTC \(.+\); conditions 1 are not checked until it reconnects$/);
  const stream = manager.list().streams[0];
  assert.ok(['waiting', 'connecting'].includes(stream.state), stream.state); // между попытками переподключения
  assert.ok(stream.down_since);
  bybit.state.refuse = false;
  await until(() => mon.events().some((e) => e.kind === 'stream_restored'));
  assert.match(mon.events().find((e) => e.kind === 'stream_restored').summary, /is back after \d+ s; ticker moves during the gap were not seen/);
  // После возвращения проверки идут как прежде.
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '111' });
  await until(() => mon.events().some((e) => e.condition === 1));
});

test('кадр не длиннее 2500 символов: события делятся на кадры, огромное — без data', () => {
  const alert = { id: 'abc', note: 'n'.repeat(300), state: 'active', dropped: 0 };
  const queue = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, condition: 1, summary: 's'.repeat(200), at: 'x', data: { x: 'y'.repeat(300) }, deliveries: 1 }));
  let rest = queue;
  const frames = [];
  while (rest.length) {
    const { text, count } = buildFrame(alert, rest);
    assert.ok(text.length <= FRAME_MAX_CHARS, `${text.length}`);
    assert.ok(count >= 1);
    frames.push(JSON.parse(text));
    rest = rest.slice(count);
  }
  assert.ok(frames.length > 1);
  assert.deepEqual(frames.flatMap((f) => f.events.map((e) => e.seq)), queue.map((e) => e.seq));
  assert.equal(frames[0].more, 30 - frames[0].events.length);
  assert.equal(frames[0].events[0].deliveries, undefined, 'служебные поля не уходят');
  const huge = JSON.parse(buildFrame(alert, [{ seq: 1, summary: 'z'.repeat(5000), data: { big: 'q'.repeat(5000) } }]).text);
  assert.equal(huge.events[0].data, undefined);
  assert.ok(huge.events[0].summary.endsWith('…'));
  assert.ok(JSON.stringify(huge).length <= FRAME_MAX_CHARS);
});

test('инструменты: схема, создание, список, отмена через MCP', async (t) => {
  const bybit = fakeBybit();
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const { server, alerts } = createServer({ env: {}, WebSocketImpl: bybit.FakeWebSocket, alertOptions: { timing: FAST_TIMING, feedTiming: FAST_FEED } });
  t.after(() => alerts.close());
  const call = async (name, args) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const noKeys = await call('create_alert', { conditions: [{ type: 'order' }] });
  assert.equal(noKeys.isError, true);
  assert.match(noKeys.content[0].text, /type: must be one of "ticker", "candle"/);
  const created = await call('create_alert', {
    conditions: [{ type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: '150' }],
    note: 'test',
  });
  assert.equal(created.isError, false);
  const out = JSON.parse(created.content[0].text);
  assert.equal(out.conditions[0].condition, 'BTCUSDT linear lastPrice >= 150');
  const list = JSON.parse((await call('list_alerts', {})).content[0].text);
  assert.equal(list.alerts[0].alert_id, out.alert_id);
  assert.equal(list.alerts[0].monitor.ws.url, out.monitor.ws.url);
  assert.equal(list.streams[0].stream, 'public linear');
  const cancelled = JSON.parse((await call('cancel_alert', { alert_id: out.alert_id })).content[0].text);
  assert.deepEqual(cancelled.cancelled, [out.alert_id]);
  const missing = await call('cancel_alert', {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Pass alert_id, or all=true/);
});

test('после обрыва приватного потока позиция и ордер сверяются по REST', async (t) => {
  let size = '0.01';
  let status = 'New';
  const { manager, bybit } = makeAlerts(t, {
    env: DEMO,
    handler: (call) => {
      if (call.path === '/v5/position/list') return ok({ list: [{ symbol: 'BTCUSDT', side: size === '0' ? '' : 'Buy', size, positionIdx: 0, seq: size === '0' ? 21 : 20 }] });
      if (call.path === '/v5/order/realtime') return ok({ list: [{ orderId: '9', orderLinkId: 'mcp-r', symbol: 'BTCUSDT', side: 'Sell', orderType: 'Limit', price: '1', qty: '1', cumExecQty: status === 'Filled' ? '1' : '0', orderStatus: status }] });
      return ok({});
    },
  });
  const res = await manager.create({
    conditions: [
      { type: 'position', category: 'linear', symbol: 'BTCUSDT', event: 'closed' },
      { type: 'order', category: 'linear', order_link_id: 'mcp-r' },
    ],
    frequency: 'once_per_condition',
  });
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  // Пока потока нет, позиция закрылась, а ордер исполнился.
  bybit.dropAll('/v5/private');
  size = '0';
  status = 'Filled';
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  const events = mon.events();
  assert.deepEqual(events.map((e) => [e.condition, e.source]).sort(), [[1, 'rest'], [2, 'rest']]);
  assert.match(events.find((e) => e.condition === 1).summary, /position closed: Buy 0\.01 -> 0/);
});

test('Bybit отказал в повторной подписке: событие condition_failed, оповещение заканчивается', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const res = await manager.create({ conditions: [{ type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 110 }] });
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  bybit.state.failTopics.add('tickers.BTCUSDT'); // например, инструмент сняли с торгов
  bybit.dropAll('/v5/public/linear');
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  const [event] = mon.events();
  assert.equal(event.kind, 'condition_failed');
  assert.match(event.summary, /no longer checked, Bybit rejected the subscription \(error:handler not found/);
});

test('события, сработавшие вместе, приходят одним кадром; переполнение очереди отмечается', async (t) => {
  const { manager, bybit } = makeAlerts(t, { env: DEMO, handler: (call) => ok({ list: [] }) });
  const res = await manager.create({ conditions: [{ type: 'order', category: 'linear', symbol: 'BTCUSDT', statuses: ['Filled'] }], frequency: 'every_time' });
  const fill = (i) => ({ category: 'linear', symbol: 'BTCUSDT', orderId: `o${i}`, side: 'Buy', orderType: 'Market', qty: '1', cumExecQty: '1', orderStatus: 'Filled' });
  bybit.push('/v5/private', { topic: 'order', data: Array.from({ length: 3 }, (_, i) => fill(i)) });
  const mon = monitor(res.monitor.ws.url);
  await until(() => mon.events().length === 3);
  assert.equal(mon.frames.length, 1, 'три события — один кадр');
  // Без Monitor очередь держит не больше 30 событий, остальное отбрасывается с пометкой.
  mon.ws.close();
  await until(() => !manager.list().alerts[0].monitor_connected);
  bybit.push('/v5/private', { topic: 'order', data: Array.from({ length: 35 }, (_, i) => fill(100 + i)) });
  const late = monitor(res.monitor.ws.url);
  await until(() => late.events().length === 30);
  assert.equal(late.frames[0].dropped, 5);
  assert.equal(late.events()[0].data.orderId, 'o105');
  assert.ok(late.frames.every((f) => JSON.stringify(f).length <= FRAME_MAX_CHARS));
});

test('срок истёк, пока события ждали Monitor: причина называет недоставленные', async (t) => {
  const { manager, bybit } = makeAlerts(t, { timing: { minuteMs: 60 } });
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const res = await manager.create({ conditions: [{ type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 110 }], expires_in_minutes: 1 });
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '120' });
  await sleep(100);
  assert.equal(manager.alerts.size, 0);
  const late = monitor(res.monitor.ws.url);
  assert.deepEqual(await late.closed, { code: CLOSE_CODES.expired, reason: `alert ${res.alert_id} expired with 1 undelivered event(s)` });
});

test('cancel_alert all=true отменяет все оповещения', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const cond = { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 110 };
  const a = await manager.create({ conditions: [cond] });
  const b = await manager.create({ conditions: [cond] });
  assert.deepEqual(manager.cancel({ all: true }).cancelled.sort(), [a.alert_id, b.alert_id].sort());
  assert.deepEqual(manager.cancel({ all: true }), { cancelled: [], note: 'There were no active alerts.' });
  await until(() => bybit.state.sockets[0].sent.some((m) => m.op === 'unsubscribe'));
});

test('отмена вызова во время настройки: оповещение не создаётся и подписок не остаётся', async (t) => {
  const bybit = fakeBybit();
  const { manager } = makeAlerts(t, { bybit });
  const cond = { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'above', value: 1 };
  // 1) Отмена, пока ждём первый снимок тикера (Bybit его так и не прислал).
  const c1 = new AbortController();
  const first = manager.create({ conditions: [cond] }, { signal: c1.signal });
  await until(() => bybit.live('/v5/public/linear')[0]?.sent.some((m) => m.op === 'subscribe'));
  await sleep(10);
  c1.abort(new Error('cancelled by client'));
  await assert.rejects(first, /cancelled by client/);
  // 2) Отмена, пока ждём подтверждения подписки.
  const [ws] = bybit.live('/v5/public/linear');
  ws.send = (data) => ws.sent.push(JSON.parse(data)); // подписку больше не подтверждает
  const c2 = new AbortController();
  const second = manager.create({ conditions: [{ ...cond, symbol: 'ETHUSDT' }] }, { signal: c2.signal });
  await until(() => ws.sent.some((m) => m.op === 'subscribe' && m.args[0] === 'tickers.ETHUSDT'));
  c2.abort(new Error('cancelled again'));
  await assert.rejects(second, /cancelled again/);
  // 3) Отмена ещё до начала.
  const c3 = new AbortController();
  c3.abort(new Error('too late'));
  await assert.rejects(manager.create({ conditions: [cond] }, { signal: c3.signal }), /too late/);
  assert.equal(manager.alerts.size, 0);
  assert.equal(manager.topics.size, 0);
});

test('разворот позиции одной сделкой: закрытие и открытие', async (t) => {
  const { manager, bybit } = makeAlerts(t, {
    env: DEMO,
    handler: (call) => (call.path === '/v5/position/list' ? ok({ list: [{ symbol: 'ETHUSDT', side: 'Buy', size: '1', positionIdx: 0, seq: 5 }] }) : ok({})),
  });
  const closed = await manager.create({ conditions: [{ type: 'position', category: 'linear', symbol: 'ETHUSDT', event: 'closed' }] });
  const opened = await manager.create({ conditions: [{ type: 'position', category: 'linear', symbol: 'ETHUSDT', event: 'opened' }] });
  const m1 = monitor(closed.monitor.ws.url);
  const m2 = monitor(opened.monitor.ws.url);
  await m1.open();
  await m2.open();
  bybit.push('/v5/private', { topic: 'position', data: [{ category: 'linear', symbol: 'ETHUSDT', side: 'Sell', size: '1', positionIdx: 0, seq: 6 }] });
  assert.equal((await m1.closed).code, CLOSE_CODES.finished);
  assert.equal((await m2.closed).code, CLOSE_CODES.finished);
  assert.equal(m1.events()[0].summary, 'demo linear ETHUSDT position reversed: Buy 1 -> Sell 1');
  assert.deepEqual([m1.events()[0].data.previousSide, m1.events()[0].data.side], ['Buy', 'Sell']);
  assert.equal(m2.events().length, 1);
});

test('свеча закрылась раньше, чем заработала подписка: пропуск добирается по REST', async (t) => {
  const minute = 60_000;
  const s0 = Math.floor(Date.now() / minute) * minute;
  const row = (start, close) => [String(start), '1', '1', '1', String(close), '1', '1'];
  const { manager, bybit, calls } = makeAlerts(t, {
    handler: (call) => {
      if (call.path !== '/v5/market/kline') return ok({});
      return queryOf(call).start ? ok({ list: [row(s0, 200)] }) : ok({ list: [row(s0, 150)] });
    },
  });
  const res = await manager.create({ conditions: [{ type: 'candle', category: 'spot', symbol: 'SOLUSDT', interval: '1', op: 'above', value: 199 }] });
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  // Первое сообщение потока — уже следующая свеча, закрытия s0 не было.
  bybit.push('/v5/public/spot', { topic: 'kline.1.SOLUSDT', type: 'snapshot', ts: Date.now(), data: [{ start: s0 + minute, end: s0 + 2 * minute - 1, open: '1', high: '1', low: '1', close: '1', volume: '1', turnover: '1', confirm: false }] });
  assert.equal((await mon.closed).code, CLOSE_CODES.finished);
  assert.equal(mon.events()[0].value, '200');
  assert.equal(mon.events()[0].source, 'rest');
  assert.equal(queryOf(calls.find((c) => queryOf(c).start)).start, String(s0));
});

test('новое оповещение во время обрыва ждёт свежий снимок тикера, а не берёт старый', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const cond = { type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'rise_pct', value: 10 };
  await manager.create({ conditions: [cond], frequency: 'every_time' }); // держит тему
  bybit.state.refuse = true;
  bybit.dropAll('/v5/public/linear');
  const pending = manager.create({ conditions: [cond] });
  await sleep(40);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '120' }); // цена за время обрыва
  bybit.state.refuse = false;
  const res = await pending;
  assert.equal(res.conditions[0].condition, 'BTCUSDT linear lastPrice >= 132 (+10% from 120)');
  assert.equal(res.status, 'active');
});

test('событие, которое трижды не подтвердили, считается доставленным — оповещение заканчивается', async (t) => {
  const { manager, bybit } = makeAlerts(t);
  bybit.state.snapshots.set('tickers.BTCUSDT', { symbol: 'BTCUSDT', lastPrice: '100' });
  const res = await manager.create({ conditions: [{ type: 'ticker', category: 'linear', symbol: 'BTCUSDT', op: 'below', value: 101 }] });
  for (let i = 0; i < 3; i++) {
    const raw = await rawConnect(portOf(res.monitor.ws.url), { path: pathOf(res.monitor.ws.url) });
    await until(() => serverFrames(raw.data).some((f) => f.opcode === OP.text));
    raw.socket.resetAndDestroy();
    await until(() => manager.alerts.size === 0 || !manager.list().alerts[0].monitor_connected);
  }
  await until(() => manager.alerts.size === 0);
  assert.equal(manager.list().recently_ended[0].status, 'finished');
  assert.equal((await monitor(res.monitor.ws.url).closed).code, CLOSE_CODES.finished);
});

test('второй пропуск во время добора свечей тоже добирается', async (t) => {
  const minute = 60_000;
  const s0 = Math.floor(Date.now() / minute) * minute;
  const row = (start) => [String(start), '1', '1', '1', '300', '1', '1'];
  let release;
  const gate = new Promise((r) => (release = r));
  const { manager, bybit, calls } = makeAlerts(t, {
    handler: async (call) => {
      if (call.path !== '/v5/market/kline') return ok({});
      const q = queryOf(call);
      if (!q.start) return ok({ list: [row(s0)] });
      if (calls.filter((c) => queryOf(c).start).length === 1) await gate; // первый добор задерживается
      const list = [];
      for (let s = Math.ceil(Number(q.start) / minute) * minute; s <= Number(q.end); s += minute) list.unshift(row(s));
      return ok({ list });
    },
  });
  const res = await manager.create({
    conditions: [{ type: 'candle', category: 'linear', symbol: 'XRPUSDT', interval: '1', op: 'above', value: 299 }],
    frequency: 'every_time',
  });
  const mon = monitor(res.monitor.ws.url);
  await mon.open();
  const open = (start) => bybit.push('/v5/public/linear', { topic: 'kline.1.XRPUSDT', type: 'snapshot', ts: Date.now(), data: [{ start, end: start + minute - 1, open: '1', high: '1', low: '1', close: '1', volume: '1', turnover: '1', confirm: false }] });
  open(s0 + 2 * minute); // пропуск: s0 и s0+1 без закрытия
  await until(() => calls.filter((c) => queryOf(c).start).length === 1);
  open(s0 + 5 * minute); // ещё пропуск, пока первый добор не вернулся
  release();
  await until(() => mon.events().length === 5);
  assert.deepEqual(mon.events().map((e) => e.data.start), [0, 1, 2, 3, 4].map((i) => new Date(s0 + i * minute).toISOString()));
});
