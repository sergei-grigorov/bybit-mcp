// Локальный WebSocket-сервер (RFC 6455) для оповещений: к нему подключается инструмент
// Monitor в Claude Code, а коннектор шлёт по соединению текстовые кадры с событиями.
// Реализовано только нужное: рукопожатие, кадры без расширений и подпротоколов, ping/pong,
// закрывающее рукопожатие. Сервер слушает только 127.0.0.1; соединения из браузера
// (с заголовком Origin) и с чужим Host отклоняются.

import { createHash } from 'node:crypto';
import { createServer, STATUS_CODES } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// Monitor сам данных не присылает — только служебные кадры, так что большое сообщение — ошибка.
export const MAX_MESSAGE_BYTES = 64 * 1024;

const DEFAULT_SOCKET_OPTIONS = {
  keepAliveMs: 25_000, // ping, если клиент давно не отвечал
  pongTimeoutMs: 20_000, // нет pong дольше — соединение мёртвое
  closeWaitMs: 1000, // ожидание ответного кадра закрытия
};

export const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
const KNOWN_OPCODES = new Set(Object.values(OP));

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

// Кадр сервера: без маски, целиком (FIN).
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

// Код и причина закрытия. Управляющий кадр — не больше 125 байт, поэтому причина ≤ 123 байт
// UTF-8 и обрезается по границе символа.
export function closePayload(code, reason = '') {
  let bytes = Buffer.from(String(reason), 'utf8');
  if (bytes.length > 123) {
    let end = 123;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    bytes = bytes.subarray(0, end);
  }
  const out = Buffer.alloc(2 + bytes.length);
  out.writeUInt16BE(code, 0);
  bytes.copy(out, 2);
  return out;
}

function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

// Разбор кадров клиента: маска обязательна, биты RSV — нули (расширения не согласуются),
// управляющие кадры короткие и целые, фрагменты собираются в сообщение. Нарушение —
// ProtocolError с кодом закрытия.
export class FrameParser {
  constructor(maxMessageBytes = MAX_MESSAGE_BYTES) {
    this.max = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
  }

  // Возвращает законченные сообщения: [{ opcode, payload }].
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages = [];
    for (let frame = this.next(); frame; frame = this.next()) {
      const { fin, opcode, payload } = frame;
      if (opcode >= 0x8) {
        messages.push({ opcode, payload });
        continue;
      }
      if (opcode === OP.continuation) {
        if (!this.fragments) throw new ProtocolError(1002, 'unexpected continuation frame');
      } else {
        if (this.fragments) throw new ProtocolError(1002, 'new message inside a fragmented one');
        this.fragments = { opcode, parts: [], size: 0 };
      }
      this.fragments.parts.push(payload);
      this.fragments.size += payload.length;
      if (this.fragments.size > this.max) throw new ProtocolError(1009, 'message too big');
      if (!fin) continue;
      const { opcode: messageOpcode, parts } = this.fragments;
      this.fragments = null;
      const data = Buffer.concat(parts);
      if (messageOpcode === OP.text) {
        try {
          utf8.decode(data);
        } catch {
          throw new ProtocolError(1007, 'invalid UTF-8 in a text message');
        }
      }
      messages.push({ opcode: messageOpcode, payload: data });
    }
    return messages;
  }

  next() {
    const b = this.buffer;
    if (b.length < 2) return null;
    if (b[0] & 0x70) throw new ProtocolError(1002, 'reserved bits are set');
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    if (!KNOWN_OPCODES.has(opcode)) throw new ProtocolError(1002, `unknown opcode ${opcode}`);
    if (!(b[1] & 0x80)) throw new ProtocolError(1002, 'client frames must be masked');
    let len = b[1] & 0x7f;
    let offset = 2;
    if (opcode >= 0x8 && (!fin || len > 125)) throw new ProtocolError(1002, 'invalid control frame');
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.max)) throw new ProtocolError(1009, 'frame too big');
      len = Number(big);
      offset = 10;
    }
    if (len > this.max) throw new ProtocolError(1009, 'frame too big');
    if (b.length < offset + 4 + len) return null;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = b.subarray(offset + 4 + len);
    return { fin, opcode, payload };
  }
}

// Одно соединение. sendText() пишет кадр и сразу ping с его номером. Pong с номером n
// подтверждает, что клиент прочитал всё отправленное до ping n: TCP сохраняет порядок, а
// клиент вправе ответить только на последний ping. Об этом сообщает onAck(n).
export class LocalSocket {
  constructor(socket, options = {}) {
    const { keepAliveMs, pongTimeoutMs, closeWaitMs, logger } = { ...DEFAULT_SOCKET_OPTIONS, ...options };
    this.socket = socket;
    this.logger = logger;
    this.state = 'open'; // open → closing → closed
    this.parser = new FrameParser();
    this.seq = 0;
    this.acked = 0;
    this.unansweredSince = null;
    this.clientClose = null; // { code, reason } из кадра клиента
    this.serverClose = null; // { code, reason } нашего кадра
    this.pongTimeoutMs = pongTimeoutMs;
    this.closeWaitMs = closeWaitMs;
    this.onAck = null;
    this.onClose = null;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.receive(chunk));
    // Клиент закрыл свою половину без кадра закрытия — закрываем и свою.
    socket.on('end', () => socket.end());
    socket.on('close', () => this.finished());
    this.keepAlive = setInterval(() => this.checkAlive(), keepAliveMs);
    this.keepAlive.unref?.();
  }

  get open() {
    return this.state === 'open';
  }

  write(buffer) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(buffer);
    return true;
  }

  // Номер кадра для подтверждения или 0, если соединение уже закрывается.
  sendText(text) {
    if (this.state !== 'open' || !this.write(encodeFrame(OP.text, Buffer.from(text, 'utf8')))) return 0;
    return this.ping();
  }

  ping() {
    if (this.state !== 'open') return 0;
    const n = ++this.seq;
    this.unansweredSince ??= Date.now();
    this.write(encodeFrame(OP.ping, Buffer.from(String(n))));
    return n;
  }

  receive(chunk) {
    if (this.state === 'closed' || !this.parser) return;
    let messages;
    try {
      messages = this.parser.push(chunk);
    } catch (err) {
      // Дальше соединение не читаем: буфер не растёт, клиент получает код ошибки.
      this.parser = null;
      this.close(err.code ?? 1002, err.message);
      return;
    }
    for (const { opcode, payload } of messages) {
      if (opcode === OP.ping) {
        if (this.state === 'open') this.write(encodeFrame(OP.pong, payload));
      } else if (opcode === OP.pong) {
        this.unansweredSince = null;
        const n = Number(payload.toString('latin1'));
        if (Number.isInteger(n) && n > this.acked && n <= this.seq) {
          this.acked = n;
          this.notify('onAck', n);
        }
      } else if (opcode === OP.close) {
        this.receiveClose(payload);
        return;
      }
      // Текстовые и двоичные сообщения клиента коннектору не нужны.
    }
  }

  receiveClose(payload) {
    this.parser = null;
    let code = 1005;
    let reason = '';
    let reply = null;
    if (payload.length === 1) {
      reply = 1002;
    } else if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        reply = 1007;
      }
      if (!validCloseCode(code)) reply = 1002;
    }
    this.clientClose = { code, reason };
    if (this.state === 'open') {
      // Клиент закрывает первым: отвечаем тем же кодом (или кодом ошибки) и закрываем TCP.
      this.state = 'closing';
      const answer = reply ?? (code === 1005 ? null : code);
      this.serverClose = { code: answer ?? 1000, reason: '' };
      this.write(encodeFrame(OP.close, answer === null ? Buffer.alloc(0) : closePayload(answer)));
    }
    this.socket.end();
    this.armDestroy();
  }

  // Закрывающее рукопожатие со стороны сервера: код 4000–4999 и причина видны модели.
  close(code = 1000, reason = '') {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.serverClose = { code, reason };
    this.write(encodeFrame(OP.close, closePayload(code, reason)));
    this.armDestroy();
  }

  armDestroy() {
    if (this.destroyTimer) return;
    this.destroyTimer = setTimeout(() => this.socket.destroy(), this.closeWaitMs);
    this.destroyTimer.unref?.();
  }

  terminate() {
    this.socket.destroy();
  }

  checkAlive() {
    if (this.state !== 'open') return;
    if (this.unansweredSince !== null) {
      if (Date.now() - this.unansweredSince > this.pongTimeoutMs) this.terminate();
      return;
    }
    this.ping();
  }

  finished() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.parser = null;
    clearInterval(this.keepAlive);
    clearTimeout(this.destroyTimer);
    const { code, reason } = this.clientClose ?? { code: 1006, reason: '' };
    this.notify('onClose', { code, reason, serverClose: this.serverClose });
  }

  // Обработчики вызываются из событий сокета: исключение в них уронило бы весь процесс.
  notify(name, arg) {
    try {
      this[name]?.(arg);
    } catch (err) {
      this.logger?.error(`оповещения: ${name}: ${err?.stack ?? err}`);
    }
  }
}

// Что не так с запросом на апгрейд (или null). Отказ — ответом HTTP: так отсекаются
// браузер и подмена Host, а свои отказы (неизвестный адрес и т. п.) сервер даёт уже
// после рукопожатия кодом закрытия — его причину Monitor показывает, а тело HTTP нет.
export function checkHandshake(req, port) {
  const h = req.headers;
  if (req.method !== 'GET') return { status: 405, text: 'Only GET is supported' };
  if (String(h.upgrade ?? '').toLowerCase() !== 'websocket') return { status: 400, text: 'Expected Upgrade: websocket' };
  const connection = String(h.connection ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  if (!connection.includes('upgrade')) return { status: 400, text: 'Expected Connection: Upgrade' };
  if (h['sec-websocket-version'] !== '13') {
    return { status: 426, text: 'Unsupported WebSocket version', headers: { 'Sec-WebSocket-Version': '13' } };
  }
  const key = h['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return { status: 400, text: 'Bad Sec-WebSocket-Key' };
  // Браузер всегда присылает Origin, Monitor — нет: страница из браузера сюда не подключится.
  if (h.origin !== undefined) return { status: 403, text: 'Browser connections are not allowed' };
  // Защита от DNS rebinding: Host — только адрес самого сервера.
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!hosts.includes(String(h.host ?? '').toLowerCase())) return { status: 403, text: 'Unexpected Host header' };
  return null;
}

function rejectUpgrade(socket, { status, text, headers = {} }) {
  const body = `${text}\n`;
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

// Сервер на 127.0.0.1, порт выбирает система. onConnection(path, ws) решает судьбу
// соединения: подключить к оповещению или сразу закрыть своим кодом с причиной.
export async function startLocalServer({ onConnection, logger, host = '127.0.0.1', socketOptions = {} }) {
  const connections = new Set();
  const server = createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket', Connection: 'close' });
    res.end('WebSocket endpoint of the Bybit connector alerts (for the Monitor tool of Claude Code).\n');
  });
  let port = 0;
  server.on('upgrade', (req, socket, head) => {
    // Первым делом — обработчик ошибок: без него сброс соединения клиентом роняет процесс.
    socket.on('error', () => {});
    const problem = checkHandshake(req, port);
    if (problem) {
      rejectUpgrade(socket, problem);
      return;
    }
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`, '', ''].join('\r\n'),
    );
    const ws = new LocalSocket(socket, { logger, ...socketOptions });
    connections.add(ws);
    socket.on('close', () => connections.delete(ws));
    try {
      onConnection(new URL(req.url, 'http://localhost').pathname, ws);
    } catch (err) {
      logger?.error(`оповещения: ошибка при подключении Monitor: ${err?.stack ?? err}`);
      ws.close(1011, 'internal error');
    }
    if (head?.length) ws.receive(head);
  });
  server.on('clientError', (err, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  server.on('error', (err) => logger?.error(`оповещения: локальный WebSocket-сервер: ${err.message}`));
  return {
    port,
    url: (path) => `ws://${host}:${port}${path}`,
    connections,
    close() {
      for (const ws of connections) ws.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
