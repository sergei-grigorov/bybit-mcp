// Локальный WebSocket-сервер для Monitor: кадры, рукопожатие, закрытие, отказы.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptKey, closePayload, encodeFrame, FrameParser, OP, ProtocolError, startLocalServer } from '../server/wsserver.js';
import { clientFrame, rawConnect, serverFrames, until } from './ws-client.js';

async function withServer(t, onConnection, socketOptions) {
  const server = await startLocalServer({ onConnection, socketOptions });
  t.after(() => server.close());
  return server;
}

test('Sec-WebSocket-Accept по примеру из RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('кадры сервера: длина 7, 16 и 64 бита', () => {
  assert.deepEqual([...encodeFrame(OP.text, Buffer.from('hi'))], [0x81, 2, 0x68, 0x69]);
  const mid = encodeFrame(OP.text, Buffer.alloc(300));
  assert.deepEqual([mid[0], mid[1], mid.readUInt16BE(2)], [0x81, 126, 300]);
  const big = encodeFrame(OP.binary, Buffer.alloc(70_000));
  assert.deepEqual([big[0], big[1], Number(big.readBigUInt64BE(2))], [0x82, 127, 70_000]);
  assert.equal(serverFrames(big)[0].payload.length, 70_000);
});

test('причина закрытия не длиннее 123 байт и не рвёт символ UTF-8', () => {
  const payload = closePayload(4000, 'я'.repeat(100));
  assert.ok(payload.length <= 125);
  assert.equal(payload.readUInt16BE(0), 4000);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2)), 'я'.repeat(61));
});

test('разбор кадров клиента: маска, фрагменты, ping между фрагментами, 16-битная длина', () => {
  const parser = new FrameParser();
  const long = 'x'.repeat(200);
  const stream = Buffer.concat([
    clientFrame(OP.text, Buffer.from('hel'), { fin: false }),
    clientFrame(OP.ping, Buffer.from('1')),
    clientFrame(OP.continuation, Buffer.from('lo')),
    clientFrame(OP.text, Buffer.from(long)),
  ]);
  // По байту — как пришло бы по сети самыми мелкими кусками.
  const messages = [];
  for (const byte of stream) messages.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(
    messages.map((m) => [m.opcode, m.payload.toString()]),
    [
      [OP.ping, '1'],
      [OP.text, 'hello'],
      [OP.text, long],
    ],
  );
});

test('разбор кадров клиента: нарушения протокола', () => {
  const cases = [
    [clientFrame(OP.text, Buffer.from('a'), { mask: false }), 1002],
    [clientFrame(OP.text, Buffer.from('a'), { rsv: 0x40 }), 1002],
    [clientFrame(OP.ping, Buffer.alloc(126)), 1002],
    [clientFrame(OP.ping, Buffer.from('a'), { fin: false }), 1002],
    [clientFrame(OP.continuation, Buffer.from('a')), 1002],
    [clientFrame(0x3, Buffer.from('a')), 1002],
    [clientFrame(OP.text, Buffer.from([0xff, 0xfe])), 1007],
    [clientFrame(OP.binary, Buffer.alloc(70_000)), 1009],
  ];
  for (const [frame, code] of cases) {
    assert.throws(
      () => new FrameParser().push(frame),
      (err) => err instanceof ProtocolError && err.code === code,
      `код ${code}`,
    );
  }
});

test('соединение: путь, текст, подтверждение по pong, закрытие сервером с кодом и причиной', async (t) => {
  let server;
  const seen = {};
  server = await withServer(t, (path, ws) => {
    seen.path = path;
    seen.ws = ws;
    ws.onAck = (n) => (seen.ack = n);
    ws.onClose = (info) => (seen.close = info);
  });
  const client = new WebSocket(server.url('/alerts/abc?x=1'));
  const got = [];
  client.onmessage = (e) => got.push(e.data);
  const closed = new Promise((resolve) => (client.onclose = (e) => resolve(e)));
  await until(() => seen.ws && client.readyState === WebSocket.OPEN);
  assert.equal(seen.path, '/alerts/abc');
  const id = seen.ws.sendText('привет');
  assert.ok(id > 0);
  await until(() => seen.ack === id);
  assert.deepEqual(got, ['привет']);
  seen.ws.close(4000, 'alert finished');
  const e = await closed;
  assert.equal(e.code, 4000);
  assert.equal(e.reason, 'alert finished');
  assert.equal(e.wasClean, true);
  await until(() => seen.close);
  assert.equal(seen.close.code, 4000, 'клиент ответил тем же кодом');
  assert.equal(seen.ws.sendText('поздно'), 0, 'после закрытия кадры не отправляются');
});

test('закрытие клиентом: код и причина доходят до сервера', async (t) => {
  let seen;
  const server = await withServer(t, (path, ws) => (ws.onClose = (info) => (seen = info)));
  const client = new WebSocket(server.url('/x'));
  await until(() => client.readyState === WebSocket.OPEN);
  client.close(1000, 'bye');
  await until(() => seen);
  assert.deepEqual([seen.code, seen.reason], [1000, 'bye']);
});

test('отказы при рукопожатии: браузер (Origin), чужой Host, версия, обычный HTTP', async (t) => {
  let connected = 0;
  const server = await withServer(t, () => connected++);
  const origin = await rawConnect(server.port, { headers: { Origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
  const host = await rawConnect(server.port, { headers: { Host: `evil.example:${server.port}` } });
  assert.equal(host.status, 403);
  const version = await rawConnect(server.port, { headers: { 'Sec-WebSocket-Version': '8' } });
  assert.equal(version.status, 426);
  assert.match(version.head, /Sec-WebSocket-Version: 13/);
  const plain = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(plain.status, 426);
  assert.equal(connected, 0);
  // localhost в Host допустим.
  const ok = await rawConnect(server.port, { headers: { Host: `localhost:${server.port}` } });
  assert.equal(ok.status, 101);
  assert.match(ok.head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  ok.socket.destroy();
});

test('нарушение протокола: код 1002, соединение закрывается, данные больше не читаются', async (t) => {
  let seen;
  const server = await withServer(t, (path, ws) => (ws.onClose = (info) => (seen = info)), { closeWaitMs: 50 });
  const client = await rawConnect(server.port);
  client.socket.write(clientFrame(OP.text, Buffer.from('x'), { mask: false }));
  await until(() => client.ended);
  const [frame] = serverFrames(client.data);
  assert.equal(frame.opcode, OP.close);
  assert.equal(frame.payload.readUInt16BE(0), 1002);
  await until(() => seen);
});

test('обрыв соединения клиентом не роняет процесс', async (t) => {
  let seen;
  const server = await withServer(t, (path, ws) => (ws.onClose = (info) => (seen = info)));
  const client = await rawConnect(server.port);
  client.socket.resetAndDestroy();
  await until(() => seen);
  assert.equal(seen.code, 1006);
  // Сервер жив и принимает новые соединения.
  const again = new WebSocket(server.url('/x'));
  await until(() => again.readyState === WebSocket.OPEN);
  again.close();
});

test('клиент, не отвечающий на ping, отключается', async (t) => {
  let seen;
  const server = await withServer(t, (path, ws) => (ws.onClose = (info) => (seen = info)), { keepAliveMs: 30, pongTimeoutMs: 60 });
  const client = await rawConnect(server.port);
  await until(() => seen, 2000);
  assert.equal(seen.code, 1006);
  const pings = serverFrames(client.data).filter((f) => f.opcode === OP.ping);
  assert.ok(pings.length >= 1);
});

test('ping клиента получает pong с теми же данными', async (t) => {
  const server = await withServer(t, () => {});
  const client = await rawConnect(server.port);
  client.socket.write(clientFrame(OP.ping, Buffer.from('abc')));
  await until(() => serverFrames(client.data).some((f) => f.opcode === OP.pong));
  assert.equal(serverFrames(client.data).find((f) => f.opcode === OP.pong).payload.toString(), 'abc');
  client.socket.destroy();
});
