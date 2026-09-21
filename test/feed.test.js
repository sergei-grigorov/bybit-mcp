// Постоянное соединение с WebSocket Bybit: подписки, отказы, переподключение, авторизация.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BybitFeed } from '../server/feed.js';
import { fakeBybit } from './fake-bybit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await sleep(2);
  }
}

const FAST = { reconnectDelaysMs: [10], idleCloseMs: 30, pingIntervalMs: 1000, staleMs: 5000, subscribeTimeoutMs: 500 };

function makeFeed(t, bybit, options = {}) {
  const log = { data: [], states: [], failed: [] };
  const feed = new BybitFeed({
    name: 'test',
    url: 'wss://stream.bybit.com/v5/public/linear',
    WebSocketImpl: bybit.FakeWebSocket,
    onData: (msg) => log.data.push(msg),
    onState: (s) => log.states.push(s.state),
    onTopicFailed: (topic, reason) => log.failed.push([topic, reason]),
    random: () => 0.5,
    ...options,
    timing: { ...FAST, ...options.timing },
  });
  t.after(() => feed.close());
  return { feed, log };
}

test('подписка по теме: запрос с req_id, подтверждение, данные темы', async (t) => {
  const bybit = fakeBybit();
  const { feed, log } = makeFeed(t, bybit);
  await feed.subscribe('tickers.BTCUSDT');
  const [ws] = bybit.state.sockets;
  const sub = ws.sent.find((m) => m.op === 'subscribe');
  assert.deepEqual(sub.args, ['tickers.BTCUSDT']);
  assert.match(sub.req_id, /^s\d+$/);
  assert.equal(feed.state, 'ready');
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '1' });
  bybit.ticker('linear', 'ETHUSDT', { lastPrice: '2' });
  assert.deepEqual(log.data.map((m) => m.topic), ['tickers.BTCUSDT'], 'чужие темы не передаются');
  // Вторая тема — вторым запросом в то же соединение.
  await feed.subscribe('kline.5.BTCUSDT');
  assert.equal(bybit.state.sockets.length, 1);
  assert.deepEqual(ws.sent.filter((m) => m.op === 'subscribe').map((m) => m.args[0]), ['tickers.BTCUSDT', 'kline.5.BTCUSDT']);
});

test('отказ в подписке: ошибка с текстом Bybit, соединение без тем закрывается', async (t) => {
  const bybit = fakeBybit({ failTopics: ['tickers.NOPE'] });
  const { feed, log } = makeFeed(t, bybit);
  await assert.rejects(feed.subscribe('tickers.NOPE'), /handler not found,topic:tickers\.NOPE/);
  assert.deepEqual(log.failed.map(([topic]) => topic), ['tickers.NOPE']);
  await until(() => feed.state === 'idle');
  assert.ok(bybit.state.sockets[0].closed);
});

test('опционный канал: списки успешных и неудачных тем в COMMAND_RESP', async (t) => {
  const bybit = fakeBybit();
  const { feed } = makeFeed(t, bybit);
  const ok = feed.subscribe('tickers.BTC-1');
  await until(() => bybit.state.sockets[0]?.sent.length);
  const ws = bybit.state.sockets[0];
  ws.send = (data) => ws.sent.push(JSON.parse(data)); // сам отвечать не будет
  const bad = feed.subscribe('tickers.BTC-2');
  ws.emit({ success: true, type: 'COMMAND_RESP', data: { successTopics: ['tickers.BTC-1'], failTopics: ['tickers.BTC-2'] } });
  await ok;
  await assert.rejects(bad, /rejected the subscription/);
});

test('обрыв: ожидание, переподключение, повторная подписка на все темы', async (t) => {
  const bybit = fakeBybit();
  const { feed, log } = makeFeed(t, bybit);
  await feed.subscribe('tickers.BTCUSDT');
  await feed.subscribe('tickers.ETHUSDT');
  bybit.dropAll();
  assert.equal(feed.state, 'waiting');
  assert.ok(feed.downSince > 0);
  await until(() => feed.state === 'ready' && bybit.state.sockets.length === 2);
  const again = bybit.state.sockets[1].sent.filter((m) => m.op === 'subscribe').map((m) => m.args[0]);
  assert.deepEqual(again.sort(), ['tickers.BTCUSDT', 'tickers.ETHUSDT']);
  assert.equal(feed.downSince, null);
  assert.deepEqual(log.states.slice(-3), ['waiting', 'connecting', 'ready']);
});

test('подписка во время переподключения дождётся готового соединения', async (t) => {
  const bybit = fakeBybit();
  const { feed } = makeFeed(t, bybit);
  await feed.subscribe('tickers.BTCUSDT');
  bybit.state.refuse = true;
  bybit.dropAll();
  const pending = feed.subscribe('tickers.ETHUSDT');
  await sleep(40);
  bybit.state.refuse = false;
  await pending;
  assert.equal(feed.state, 'ready');
});

test('приватный канал: сначала авторизация, потом подписка; отказ — ошибка у ждущих', async (t) => {
  const bybit = fakeBybit();
  const { feed } = makeFeed(t, bybit, { url: 'wss://stream-demo.bybit.com/v5/private', auth: async () => ['KEY', 123, 'SIG'] });
  await feed.subscribe('order');
  const sent = bybit.state.sockets[0].sent;
  assert.deepEqual(sent[0], { op: 'auth', args: ['KEY', 123, 'SIG'] });
  assert.equal(sent[1].op, 'subscribe');

  const denied = fakeBybit({ authOk: false });
  const other = makeFeed(t, denied, { url: 'wss://x/v5/private', auth: async () => ['KEY', 1, 'S'] });
  await assert.rejects(other.feed.subscribe('position'), /Bybit rejected the authentication: Invalid apikey/);
  assert.equal(other.feed.state, 'waiting');
});

test('молчащее соединение считается мёртвым и переподключается', async (t) => {
  const bybit = fakeBybit({ answerPing: false });
  const { feed } = makeFeed(t, bybit, { timing: { pingIntervalMs: 20, staleMs: 50 } });
  await feed.subscribe('tickers.BTCUSDT');
  await until(() => bybit.state.sockets.length >= 2);
  assert.ok(bybit.state.sockets[0].closed);
  assert.match(feed.lastError ?? '', /no data from Bybit|^$/);
});

test('отписка: запрос unsubscribe; без тем соединение закрывается не сразу', async (t) => {
  const bybit = fakeBybit();
  const { feed } = makeFeed(t, bybit);
  await feed.subscribe('tickers.BTCUSDT');
  feed.unsubscribe('tickers.BTCUSDT');
  const ws = bybit.state.sockets[0];
  assert.deepEqual(ws.sent.at(-1), { op: 'unsubscribe', args: ['tickers.BTCUSDT'] });
  assert.equal(ws.closed, false, 'тема может понадобиться снова');
  // Новая подписка в паузе отменяет закрытие.
  await feed.subscribe('tickers.ETHUSDT');
  await sleep(50);
  assert.equal(ws.closed, false);
  feed.unsubscribe('tickers.ETHUSDT');
  await until(() => ws.closed);
  assert.equal(feed.state, 'idle');
});

test('нет подтверждения подписки — ошибка по таймауту', async (t) => {
  const bybit = fakeBybit();
  const { feed } = makeFeed(t, bybit, { timing: { subscribeTimeoutMs: 50 } });
  await feed.subscribe('tickers.BTCUSDT');
  bybit.state.sockets[0].send = () => {}; // Bybit перестал отвечать
  await assert.rejects(feed.subscribe('tickers.ETHUSDT'), /did not confirm the subscription to tickers\.ETHUSDT/);
});

test('исключение в обработчике данных не роняет процесс и не рвёт поток', async (t) => {
  const bybit = fakeBybit();
  const errors = [];
  let calls = 0;
  const feed = new BybitFeed({
    name: 'test',
    url: 'wss://stream.bybit.com/v5/public/linear',
    WebSocketImpl: bybit.FakeWebSocket,
    logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
    onData: () => {
      calls++;
      throw new Error('boom');
    },
    timing: FAST,
  });
  t.after(() => feed.close());
  await feed.subscribe('tickers.BTCUSDT');
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '1' });
  bybit.ticker('linear', 'BTCUSDT', { lastPrice: '2' });
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /onData: Error: boom/);
  assert.equal(feed.state, 'ready');
});
