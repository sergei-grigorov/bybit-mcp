// Короткое подключение к WebSocket Bybit V5: подписаться на темы, собрать сообщения
// за отведённое время и вернуть их (или сводку: собранный стакан, итоговый тикер).

import { wsAuthPayload } from './signer.js';

export const PUBLIC_CHANNELS = ['spot', 'linear', 'inverse', 'option', 'spread', 'rfq'];
export const CHANNELS = [...PUBLIC_CHANNELS, 'status', 'private'];

const CONNECT_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const SUBSCRIBE_CHUNK = 10; // спот принимает не больше 10 тем за запрос

export function streamUrl(envConfig, channel) {
  if (channel === 'private') return `${envConfig.privateStreamUrl}/v5/private`;
  if (channel === 'status') return `${envConfig.publicStreamUrl}/v5/public/misc/status`;
  return `${envConfig.publicStreamUrl}/v5/public/${channel}`;
}

// Локальная копия стакана: снимок сбрасывает её, дельта обновляет уровни
// (размер "0" — уровень удалён).
export class OrderBook {
  constructor() {
    this.bids = new Map();
    this.asks = new Map();
    this.meta = {};
  }

  apply(msg) {
    const d = msg.data ?? {};
    if (msg.type === 'snapshot') {
      this.bids.clear();
      this.asks.clear();
    }
    for (const [side, levels] of [
      [this.bids, d.b],
      [this.asks, d.a],
    ]) {
      for (const [price, size] of levels ?? []) {
        if (Number(size) === 0) side.delete(price);
        else side.set(price, size);
      }
    }
    this.meta = { symbol: d.s, updateId: d.u, seq: d.seq, ts: msg.ts, cts: msg.cts };
  }

  top(depth) {
    const sorted = (map, dir) =>
      [...map.entries()].sort((x, y) => dir * (Number(x[0]) - Number(y[0]))).slice(0, depth);
    return { ...this.meta, bids: sorted(this.bids, -1), asks: sorted(this.asks, 1) };
  }
}

function subscribeFailures(msg, topics) {
  if (msg.type === 'COMMAND_RESP') return msg.data?.failTopics ?? [];
  if (msg.success === false) return [msg.ret_msg || topics.join(',')];
  return [];
}

export function collectStream({
  url,
  topics,
  auth = null, // { apiKey, signer, serverNow }
  durationMs = 5000,
  maxMessages = 100,
  mode = 'summary',
  depth = 25,
  signal,
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
}) {
  if (typeof WebSocketImpl !== 'function') {
    return Promise.reject(new Error('WebSocket недоступен в этой версии Node.js (нужен Node 22 или новее)'));
  }
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Отменено'));
  return new Promise((resolve, reject) => {
    const startedAt = now();
    const state = {
      authenticated: auth ? false : null,
      subscribeErrors: [],
      errors: [],
      perTopic: {},
      received: 0,
      stored: 0,
      events: [],
      books: new Map(),
      tickers: new Map(),
    };
    let finished = false;
    let connectTimer;
    let durationTimer;
    let pingTimer;
    let reqSeq = 0;
    const ws = new WebSocketImpl(url);

    const send = (payload) => {
      try {
        ws.send(JSON.stringify({ req_id: String(++reqSeq), ...payload }));
      } catch (err) {
        state.errors.push(`send failed: ${err.message}`);
      }
    };

    const result = () => {
      const out = {
        url,
        topics,
        elapsedMs: now() - startedAt,
        received: state.received,
        perTopic: state.perTopic,
      };
      if (auth) out.authenticated = state.authenticated;
      if (state.subscribeErrors.length) out.subscribeErrors = state.subscribeErrors;
      if (state.errors.length) out.errors = state.errors;
      if (state.books.size) {
        out.orderbooks = Object.fromEntries([...state.books].map(([t, b]) => [t, b.top(depth)]));
      }
      if (state.tickers.size) out.tickers = Object.fromEntries(state.tickers);
      out[mode === 'raw' ? 'messages' : 'events'] = state.events;
      return out;
    };

    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      clearTimeout(durationTimer);
      clearInterval(pingTimer);
      signal?.removeEventListener('abort', onAbort);
      try {
        ws.close();
      } catch {
        // соединение уже закрыто
      }
      if (err) reject(err);
      else resolve(result());
    };

    const onAbort = () => finish(signal.reason ?? new Error('Отменено'));
    signal?.addEventListener('abort', onAbort, { once: true });

    connectTimer = setTimeout(
      () => finish(new Error(`Не удалось подключиться к ${url} за ${CONNECT_TIMEOUT_MS / 1000} с`)),
      CONNECT_TIMEOUT_MS,
    );

    const subscribe = () => {
      for (let i = 0; i < topics.length; i += SUBSCRIBE_CHUNK) {
        send({ op: 'subscribe', args: topics.slice(i, i + SUBSCRIBE_CHUNK) });
      }
    };

    const store = (item) => {
      if (state.stored >= maxMessages) return;
      state.events.push(item);
      state.stored++;
      if (state.stored >= maxMessages) finish();
    };

    const handleData = (msg) => {
      const topic = msg.topic;
      state.received++;
      state.perTopic[topic] = (state.perTopic[topic] ?? 0) + 1;
      if (mode === 'raw') {
        store(msg);
        return;
      }
      if (topic.startsWith('orderbook.')) {
        if (!state.books.has(topic)) state.books.set(topic, new OrderBook());
        state.books.get(topic).apply(msg);
        return;
      }
      if (topic.startsWith('tickers.')) {
        const prev = msg.type === 'delta' ? (state.tickers.get(topic) ?? {}) : {};
        state.tickers.set(topic, { ...prev, ...msg.data, ts: msg.ts });
        return;
      }
      const items = Array.isArray(msg.data) ? msg.data : [msg.data];
      for (const data of items) {
        store({ topic, type: msg.type, ts: msg.ts ?? msg.creationTime, data });
        if (finished) return;
      }
    };

    ws.onopen = () => {
      if (finished) return;
      clearTimeout(connectTimer);
      // Таймеры — до подписки: сбор может завершиться прямо внутри неё.
      pingTimer = setInterval(() => send({ op: 'ping' }), PING_INTERVAL_MS);
      durationTimer = setTimeout(() => finish(), durationMs);
      if (auth) {
        const expires = auth.serverNow() + 10_000;
        send({ op: 'auth', args: [auth.apiKey, expires, auth.signer.sign(wsAuthPayload(expires))] });
      } else {
        subscribe();
      }
    };

    ws.onmessage = (event) => {
      if (finished) return;
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      } catch {
        return;
      }
      if (msg.op === 'auth') {
        if (msg.success) {
          state.authenticated = true;
          subscribe();
        } else {
          state.authenticated = false;
          finish(new Error(`Bybit отклонил авторизацию WebSocket: ${msg.ret_msg || 'без пояснения'}`));
        }
        return;
      }
      if (msg.op === 'subscribe' || msg.type === 'COMMAND_RESP') {
        state.subscribeErrors.push(...subscribeFailures(msg, topics));
        return;
      }
      if (msg.op === 'ping' || msg.op === 'pong') return;
      if (typeof msg.topic === 'string') handleData(msg);
    };

    ws.onerror = (event) => {
      state.errors.push(event?.message || event?.error?.message || 'ошибка WebSocket');
    };

    ws.onclose = (event) => {
      if (finished) return;
      if (state.received === 0 && state.errors.length && !durationTimer) {
        finish(new Error(`Не удалось подключиться к ${url}: ${state.errors.join('; ')}`));
        return;
      }
      state.errors.push(`соединение закрыто сервером (${event?.code ?? '?'} ${event?.reason ?? ''})`.trim());
      finish();
    };
  });
}
