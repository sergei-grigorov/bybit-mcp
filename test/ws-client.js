// Сырой WebSocket-клиент для тестов: своё рукопожатие, кадры с маской и без, чтение
// кадров сервера. В отличие от встроенного WebSocket, умеет не отвечать на ping.

import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await sleep(3);
  }
}

// Кадр клиента: с маской (или без — для проверки отказа).
export function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = true, rsv = 0 } = {}) {
  const body = Buffer.from(payload);
  const len = body.length;
  const head = [(fin ? 0x80 : 0) | rsv | opcode];
  let ext = Buffer.alloc(0);
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 0x10000) {
    head.push((mask ? 0x80 : 0) | 126);
    ext = Buffer.alloc(2);
    ext.writeUInt16BE(len);
  } else {
    head.push((mask ? 0x80 : 0) | 127);
    ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(len));
  }
  const key = mask ? randomBytes(4) : Buffer.alloc(0);
  if (mask) for (let i = 0; i < len; i++) body[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), ext, key, body]);
}

// Кадры сервера (без маски) из буфера.
export function serverFrames(buffer) {
  const frames = [];
  let b = buffer;
  while (b.length >= 2) {
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      len = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    if (b.length < offset + len) break;
    frames.push({ fin: (b[0] & 0x80) !== 0, opcode: b[0] & 0x0f, payload: b.subarray(offset, offset + len) });
    b = b.subarray(offset + len);
  }
  return frames;
}

// Подключение со своим рукопожатием; заголовки можно подменить (null — убрать).
export function rawConnect(port, { path = '/x', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    socket.once('error', reject);
    socket.on('connect', () => {
      const all = {
        Host: `127.0.0.1:${port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...headers,
      };
      const lines = [`GET ${path} HTTP/1.1`, ...Object.entries(all).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`), '', ''];
      socket.write(lines.join('\r\n'));
    });
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buf.subarray(0, end).toString();
      const client = { socket, status: Number(head.split(' ')[1]), head, data: buf.subarray(end + 4), ended: false };
      socket.on('data', (d) => (client.data = Buffer.concat([client.data, d])));
      socket.on('close', () => (client.ended = true));
      socket.on('error', () => {});
      resolve(client);
    };
    socket.on('data', onData);
  });
}
