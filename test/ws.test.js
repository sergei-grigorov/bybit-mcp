import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { createSigner } from '../server/signer.js';
import { collectStream, OrderBook, streamUrl } from '../server/ws.js';

// Поддельный WebSocket: сценарий получает сокет и отвечает на отправленные сообщения.
function fakeSocket(script) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      sockets.push(this);
      setTimeout(() => {
        this.onopen?.();
        script.onOpen?.(this);
      }, 1);
    }
    send(data) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      script.onSend?.(this, msg);
    }
    emit(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }
    close() {
      this.closed = true;
    }
  }
  return { FakeWebSocket, sockets };
}

test('адреса потоков: демо-контур берёт публичные данные с mainnet', () => {
  const demo = { privateStreamUrl: 'wss://stream-demo.bybit.com', publicStreamUrl: 'wss://stream.bybit.com' };
  assert.equal(streamUrl(demo, 'private'), 'wss://stream-demo.bybit.com/v5/private');
  assert.equal(streamUrl(demo, 'linear'), 'wss://stream.bybit.com/v5/public/linear');
  assert.equal(streamUrl(demo, 'status'), 'wss://stream.bybit.com/v5/public/misc/status');
});

test('стакан: снимок, дельты, удаление уровня, новый снимок', () => {
  const book = new OrderBook();
  book.apply({ type: 'snapshot', ts: 1, data: { s: 'BTCUSDT', b: [['100', '1'], ['99', '2']], a: [['101', '1'], ['102', '3']], u: 1, seq: 10 } });
  book.apply({ type: 'delta', ts: 2, data: { s: 'BTCUSDT', b: [['100', '0'], ['99.5', '4']], a: [['100.5', '2']], u: 2, seq: 11 } });
  assert.deepEqual(book.top(5), {
    symbol: 'BTCUSDT',
    updateId: 2,
    seq: 11,
    ts: 2,
    cts: undefined,
    bids: [['99.5', '4'], ['99', '2']],
    asks: [['100.5', '2'], ['101', '1'], ['102', '3']],
  });
  book.apply({ type: 'snapshot', ts: 3, data: { s: 'BTCUSDT', b: [['98', '1']], a: [], u: 3 } });
  assert.deepEqual(book.top(1).bids, [['98', '1']]);
  assert.deepEqual(book.top(1).asks, []);
});

test('сводка: стакан, тикер, события и лимит сообщений', async () => {
  const { FakeWebSocket, sockets } = fakeSocket({
    onSend(ws, msg) {
      if (msg.op !== 'subscribe') return;
      ws.emit({ success: true, op: 'subscribe', ret_msg: '' });
      ws.emit({ topic: 'orderbook.1.BTCUSDT', type: 'snapshot', ts: 1, data: { s: 'BTCUSDT', b: [['1', '1']], a: [['2', '1']], u: 1 } });
      ws.emit({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: 1, data: { symbol: 'BTCUSDT', lastPrice: '1', markPrice: '1' } });
      ws.emit({ topic: 'tickers.BTCUSDT', type: 'delta', ts: 2, data: { symbol: 'BTCUSDT', lastPrice: '1.5' } });
      for (let i = 0; i < 5; i++) ws.emit({ topic: 'publicTrade.BTCUSDT', type: 'snapshot', ts: 3, data: [{ p: String(i) }] });
    },
  });
  const res = await collectStream({
    url: 'wss://x/v5/public/linear',
    topics: ['orderbook.1.BTCUSDT', 'tickers.BTCUSDT', 'publicTrade.BTCUSDT'],
    durationMs: 2000,
    maxMessages: 3,
    WebSocketImpl: FakeWebSocket,
  });
  assert.deepEqual(res.orderbooks['orderbook.1.BTCUSDT'].bids, [['1', '1']]);
  assert.deepEqual(res.tickers['tickers.BTCUSDT'], { symbol: 'BTCUSDT', lastPrice: '1.5', markPrice: '1', ts: 2 });
  assert.deepEqual(res.events.map((e) => e.data.p), ['0', '1', '2']);
  assert.equal(res.received, 6, 'после лимита сообщения не принимаются');
  assert.ok(res.elapsedMs < 1000, 'завершилось по лимиту, а не по времени');
  assert.ok(sockets[0].closed);
});

test('подписка частями по 10 тем и ошибки подписки', async () => {
  const topics = Array.from({ length: 23 }, (_, i) => `tickers.S${i}USDT`);
  const { FakeWebSocket, sockets } = fakeSocket({
    onSend(ws, msg) {
      if (msg.op === 'subscribe') ws.emit({ success: false, op: 'subscribe', ret_msg: `error:handler not found,topic:${msg.args[0]}` });
    },
  });
  const res = await collectStream({ url: 'wss://x', topics, durationMs: 30, WebSocketImpl: FakeWebSocket });
  const subs = sockets[0].sent.filter((m) => m.op === 'subscribe');
  assert.deepEqual(subs.map((m) => m.args.length), [10, 10, 3]);
  assert.equal(res.subscribeErrors.length, 3);
  assert.deepEqual(res.events, []);
});

test('опционный канал: failTopics из COMMAND_RESP и режим raw', async () => {
  const { FakeWebSocket } = fakeSocket({
    onSend(ws, msg) {
      if (msg.op !== 'subscribe') return;
      ws.emit({ success: true, type: 'COMMAND_RESP', data: { successTopics: ['a'], failTopics: ['b'] } });
      ws.emit({ topic: 'a', type: 'snapshot', ts: 1, data: { x: 1 } });
    },
  });
  const res = await collectStream({ url: 'wss://x', topics: ['a', 'b'], durationMs: 30, mode: 'raw', WebSocketImpl: FakeWebSocket });
  assert.deepEqual(res.subscribeErrors, ['b']);
  assert.deepEqual(res.messages, [{ topic: 'a', type: 'snapshot', ts: 1, data: { x: 1 } }]);
});

test('приватный канал: авторизация с корректной подписью до подписки', async () => {
  const { FakeWebSocket, sockets } = fakeSocket({
    onSend(ws, msg) {
      if (msg.op === 'auth') ws.emit({ success: true, op: 'auth', ret_msg: '' });
      if (msg.op === 'subscribe') ws.emit({ topic: 'order', creationTime: 5, data: [{ orderId: '1' }] });
    },
  });
  const res = await collectStream({
    url: 'wss://x/v5/private',
    topics: ['order'],
    auth: { apiKey: 'KEY', signer: createSigner('SECRET'), serverNow: () => 1_000 },
    durationMs: 30,
    WebSocketImpl: FakeWebSocket,
  });
  const [auth, sub] = sockets[0].sent;
  assert.equal(auth.op, 'auth');
  assert.deepEqual(auth.args, ['KEY', 11_000, createHmac('sha256', 'SECRET').update('GET/realtime11000').digest('hex')]);
  assert.equal(sub.op, 'subscribe');
  assert.equal(res.authenticated, true);
  assert.deepEqual(res.events, [{ topic: 'order', type: undefined, ts: 5, data: { orderId: '1' } }]);
});

test('отказ в авторизации — ошибка', async () => {
  const { FakeWebSocket } = fakeSocket({
    onSend(ws, msg) {
      if (msg.op === 'auth') ws.emit({ success: false, op: 'auth', ret_msg: 'Params Error' });
    },
  });
  await assert.rejects(
    collectStream({
      url: 'wss://x',
      topics: ['order'],
      auth: { apiKey: 'KEY', signer: createSigner('S'), serverNow: () => 0 },
      durationMs: 1000,
      WebSocketImpl: FakeWebSocket,
    }),
    /отклонил авторизацию WebSocket: Params Error/,
  );
});

test('отмена и отсутствие WebSocket', async () => {
  const { FakeWebSocket } = fakeSocket({});
  const controller = new AbortController();
  const pending = collectStream({ url: 'wss://x', topics: ['a'], durationMs: 5000, signal: controller.signal, WebSocketImpl: FakeWebSocket });
  setTimeout(() => controller.abort(new Error('stop')), 10);
  await assert.rejects(pending, /stop/);
  await assert.rejects(collectStream({ url: 'wss://x', topics: ['a'], WebSocketImpl: null }), /WebSocket недоступен/);
});
