// Поддельный WebSocket Bybit для тестов потоков и оповещений: подтверждает подписки по
// req_id, отвечает на ping и auth, по запросу рвёт соединение или не пускает вовсе.

export function fakeBybit({ failTopics = [], authOk = true, answerPing = true } = {}) {
  const state = {
    sockets: [],
    snapshots: new Map(), // тема → данные снимка, который приходит сразу после подписки
    refuse: false, // новые подключения сразу закрываются
    failTopics: new Set(failTopics),
    authOk,
    answerPing,
  };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      state.sockets.push(this);
      setTimeout(() => {
        if (this.closed) return;
        if (state.refuse) {
          this.closed = true;
          this.onerror?.({ message: 'connect ECONNREFUSED' });
          this.onclose?.({ code: 1006, reason: '' });
          return;
        }
        this.onopen?.();
      }, 1);
    }

    send(data) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (msg.op === 'subscribe') {
        const [topic] = msg.args;
        queueMicrotask(() => {
          if (state.failTopics.has(topic)) {
            this.emit({ success: false, ret_msg: `error:handler not found,topic:${topic}`, op: 'subscribe', req_id: msg.req_id });
            return;
          }
          this.emit({ success: true, ret_msg: '', op: 'subscribe', req_id: msg.req_id });
          const snapshot = state.snapshots.get(topic);
          if (snapshot) this.emit({ topic, type: 'snapshot', ts: Date.now(), data: { ...snapshot } });
        });
      } else if (msg.op === 'auth') {
        queueMicrotask(() => this.emit({ success: state.authOk, ret_msg: state.authOk ? '' : 'Invalid apikey', op: 'auth' }));
      } else if (msg.op === 'ping' && state.answerPing) {
        queueMicrotask(() => this.emit({ success: true, ret_msg: 'pong', op: 'ping' }));
      }
    }

    emit(obj) {
      if (!this.closed) this.onmessage?.({ data: JSON.stringify(obj) });
    }

    close() {
      this.closed = true;
    }

    // Обрыв со стороны Bybit.
    drop(code = 1006) {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.({ code, reason: '' });
    }
  }

  const live = (part) => state.sockets.filter((s) => !s.closed && s.url.includes(part));
  return {
    FakeWebSocket,
    state,
    live,
    // Сообщение темы во все открытые соединения с адресом, содержащим part.
    push(part, msg) {
      for (const s of live(part)) s.emit(msg);
    },
    ticker(channel, symbol, data, type = 'delta') {
      this.push(`/v5/public/${channel}`, { topic: `tickers.${symbol}`, type, ts: Date.now(), cs: 1, data: { symbol, ...data } });
    },
    dropAll(part = '') {
      for (const s of live(part)) s.drop();
    },
  };
}
