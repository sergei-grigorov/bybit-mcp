// Постоянное соединение с WebSocket Bybit V5 — для оповещений. В отличие от collectStream
// (ws.js), живёт, пока нужны темы: по теме на запрос подписки (ответ сопоставляется по
// req_id), ping каждые 20 с, переподключение с растущей паузой и повторной подпиской,
// авторизация приватного канала при каждом подключении.

const DEFAULT_TIMING = {
  connectTimeoutMs: 10_000,
  pingIntervalMs: 20_000, // так советует документация Bybit
  staleMs: 60_000, // ни одного сообщения, даже pong, — соединение мёртвое
  subscribeTimeoutMs: 15_000, // подтверждение подписки вместе с подключением
  idleCloseMs: 30_000, // соединение без тем закрывается не сразу: тема может понадобиться снова
  stableMs: 30_000, // после стольких секунд работы пауза перед переподключением сбрасывается
  reconnectDelaysMs: [1000, 2000, 5000, 10_000, 20_000, 30_000],
};

export class BybitFeed {
  // auth — async () => [apiKey, expires, signature] для приватного канала, иначе null.
  // onState({ state, downSince, error }) — idle | connecting | authenticating | ready | waiting | closed.
  // onTopicAcked(topic) — подписка на тему (снова) работает: после каждого подключения.
  constructor({ name, url, auth = null, WebSocketImpl = globalThis.WebSocket, logger, onData, onState, onTopicFailed, onTopicAcked, timing = {}, random = Math.random }) {
    this.name = name;
    this.url = url;
    this.auth = auth;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.onData = onData;
    this.onState = onState;
    this.onTopicFailed = onTopicFailed;
    this.onTopicAcked = onTopicAcked;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.random = random;
    this.topics = new Map(); // тема → { acked, waiters: Set }
    this.requests = new Map(); // req_id → тема
    this.state = 'idle';
    this.ws = null;
    this.attempt = 0;
    this.downSince = null;
    this.lastError = null;
    this.reqSeq = 0;
  }

  // Подписка на тему. Промис выполняется, когда Bybit подтвердил подписку (или прислал
  // данные темы), и отклоняется при отказе или по таймауту.
  subscribe(topic) {
    if (this.state === 'closed') return Promise.reject(new Error('stream is closed'));
    let entry = this.topics.get(topic);
    if (!entry) {
      entry = { acked: false, waiters: new Set() };
      this.topics.set(topic, entry);
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      if (this.state === 'ready') this.sendSubscribe(topic);
      else if (this.state === 'idle') this.connect();
      // connecting / authenticating / waiting — подпишемся, когда соединение будет готово.
    }
    if (entry.acked) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        entry.waiters.delete(waiter);
        const why = this.lastError ? ` (${this.lastError})` : '';
        reject(new Error(`Bybit did not confirm the subscription to ${topic} within ${this.timing.subscribeTimeoutMs / 1000} s${why}`));
      }, this.timing.subscribeTimeoutMs);
      entry.waiters.add(waiter);
    });
  }

  unsubscribe(topic) {
    const entry = this.topics.get(topic);
    if (!entry) return;
    this.topics.delete(topic);
    settle(entry, new Error(`unsubscribed from ${topic}`));
    if (this.state === 'ready') this.send({ op: 'unsubscribe', args: [topic] });
    if (!this.topics.size) this.scheduleIdleClose();
  }

  close() {
    this.state = 'closed';
    for (const entry of this.topics.values()) settle(entry, new Error('stream is closed'));
    this.topics.clear();
    clearTimeout(this.idleTimer);
    clearTimeout(this.retryTimer);
    this.disconnect();
  }

  scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.topics.size || this.state === 'closed') return;
      clearTimeout(this.retryTimer);
      this.disconnect();
      this.state = 'idle';
      this.downSince = null;
      this.emitState();
    }, this.timing.idleCloseMs);
    this.idleTimer.unref?.();
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.state = 'connecting';
    this.emitState();
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.dropped(`cannot connect: ${err.message}`);
      return;
    }
    this.ws = ws;
    this.lastMessageAt = Date.now();
    this.connectTimer = setTimeout(() => this.dropped(`no connection within ${this.timing.connectTimeoutMs / 1000} s`), this.timing.connectTimeoutMs);
    // Исключение из обработчика события WebSocket завершило бы весь процесс — ловим всё.
    const guard = (what, fn) => (event) => {
      try {
        fn(event);
      } catch (err) {
        this.logger?.error(`${this.name}: ${what}: ${err?.stack ?? err}`);
      }
    };
    ws.onopen = guard('open', () => this.opened(ws).catch((err) => this.logger?.error(`${this.name}: open: ${err?.stack ?? err}`)));
    ws.onmessage = guard('message', (event) => this.message(ws, event));
    ws.onerror = guard('error', (event) => {
      if (ws === this.ws) this.lastError = event?.message || event?.error?.message || 'WebSocket error';
    });
    ws.onclose = guard('close', (event) => {
      if (ws !== this.ws) return;
      const detail = `${event?.code ?? '?'}${event?.reason ? ` ${event.reason}` : ''}`;
      this.dropped(this.lastError ? `${this.lastError}; closed (${detail})` : `closed by Bybit (${detail})`);
    });
  }

  async opened(ws) {
    if (ws !== this.ws) return;
    clearTimeout(this.connectTimer);
    this.lastMessageAt = Date.now();
    this.pingTimer = setInterval(() => this.heartbeat(), this.timing.pingIntervalMs);
    if (!this.auth) {
      this.becomeReady();
      return;
    }
    this.state = 'authenticating';
    this.emitState();
    let args;
    try {
      args = await this.auth();
    } catch (err) {
      if (ws === this.ws) this.authFailed(`could not sign the authentication request: ${err.message}`);
      return;
    }
    if (ws === this.ws) this.send({ op: 'auth', args });
  }

  becomeReady() {
    this.state = 'ready';
    this.readyAt = Date.now();
    this.downSince = null;
    this.lastError = null;
    for (const [topic, entry] of this.topics) {
      entry.acked = false;
      this.sendSubscribe(topic);
    }
    this.emitState();
  }

  message(ws, event) {
    if (ws !== this.ws) return;
    this.lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    } catch {
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.op === 'auth') {
      if (msg.success) this.becomeReady();
      else this.authFailed(`Bybit rejected the authentication: ${msg.ret_msg || 'no reason given'}`);
      return;
    }
    if (msg.op === 'subscribe' || msg.type === 'COMMAND_RESP') {
      this.subscribeResponse(msg);
      return;
    }
    if (typeof msg.topic === 'string') {
      const entry = this.topics.get(msg.topic);
      if (!entry) return; // тема уже не нужна
      if (!entry.acked) this.acknowledge(msg.topic);
      this.notify('onData', msg);
    }
    // Остальное (pong, ответ на отписку) — только признак живого соединения.
  }

  subscribeResponse(msg) {
    const topic = this.requests.get(msg.req_id);
    if (topic !== undefined) this.requests.delete(msg.req_id);
    const data = msg.data ?? {};
    // Опционный канал отвечает списками успешных и неудачных тем.
    if (Array.isArray(data.successTopics) || Array.isArray(data.failTopics)) {
      for (const t of data.successTopics ?? []) this.acknowledge(t);
      for (const t of data.failTopics ?? []) this.topicFailed(t, 'Bybit rejected the subscription');
      return;
    }
    if (topic === undefined) return;
    if (msg.success) this.acknowledge(topic);
    else this.topicFailed(topic, msg.ret_msg || 'Bybit rejected the subscription');
  }

  acknowledge(topic) {
    const entry = this.topics.get(topic);
    if (!entry || entry.acked) return;
    entry.acked = true;
    settle(entry);
    this.notify('onTopicAcked', topic);
  }

  topicFailed(topic, reason) {
    const entry = this.topics.get(topic);
    if (!entry) return;
    this.topics.delete(topic);
    settle(entry, new Error(reason));
    this.notify('onTopicFailed', topic, reason);
    if (!this.topics.size) this.scheduleIdleClose();
  }

  // Отказ в авторизации скорее всего не пройдёт сам (ключ, права, IP): ждущие подписки
  // получают ошибку сразу, а переподключение идёт с самой длинной паузой.
  authFailed(reason) {
    for (const entry of this.topics.values()) settle(entry, new Error(reason));
    this.attempt = this.timing.reconnectDelaysMs.length - 1;
    this.dropped(reason);
  }

  heartbeat() {
    if (!this.ws) return;
    if (Date.now() - this.lastMessageAt > this.timing.staleMs) {
      this.dropped(`no data from Bybit for ${Math.round(this.timing.staleMs / 1000)} s`);
      return;
    }
    this.send({ op: 'ping' });
  }

  sendSubscribe(topic) {
    const id = `s${++this.reqSeq}`;
    this.requests.set(id, topic);
    this.send({ req_id: id, op: 'subscribe', args: [topic] });
  }

  send(payload) {
    try {
      this.ws?.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.lastError = `send failed: ${err.message}`;
      return false;
    }
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    clearTimeout(this.connectTimer);
    clearInterval(this.pingTimer);
    this.requests.clear();
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // соединение уже закрыто
    }
  }

  // Соединение потеряно (или не установилось): переподключиться, если темы ещё нужны.
  dropped(reason) {
    if (this.state === 'closed') return;
    const wasReady = this.state === 'ready';
    this.disconnect();
    for (const entry of this.topics.values()) entry.acked = false;
    this.lastError = reason;
    if (wasReady && Date.now() - this.readyAt >= this.timing.stableMs) this.attempt = 0;
    if (!this.topics.size) {
      this.state = 'idle';
      this.downSince = null;
      this.emitState();
      return;
    }
    this.downSince ??= Date.now();
    this.state = 'waiting';
    const delays = this.timing.reconnectDelaysMs;
    const delay = Math.round(delays[Math.min(this.attempt, delays.length - 1)] * (0.8 + 0.4 * this.random()));
    this.attempt++;
    this.logger?.warn(`${this.name}: ${reason}; переподключение через ${delay} мс`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.emitState();
  }

  emitState() {
    this.notify('onState', { state: this.state, downSince: this.downSince, error: this.lastError });
  }

  // Обработчики вызываются из событий WebSocket: исключение в них уронило бы весь процесс.
  notify(name, ...args) {
    try {
      this[name]?.(...args);
    } catch (err) {
      this.logger?.error(`${this.name}: ${name}: ${err?.stack ?? err}`);
    }
  }
}

function settle(entry, error) {
  for (const waiter of entry.waiters) {
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }
  entry.waiters.clear();
}
