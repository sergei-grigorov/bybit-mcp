import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';

import { createSigner, normalizePem, restSignPayload, wsAuthPayload } from '../server/signer.js';

// Эталоны посчитаны независимо, модулем hmac из Python.
test('HMAC-подпись REST совпадает с независимым расчётом', () => {
  const signer = createSigner('XXXXXXXXXX');
  assert.equal(signer.type, 'hmac');
  const payload = restSignPayload({
    timestamp: '1658384314791',
    apiKey: 'XXXXXXXXXX',
    recvWindow: '5000',
    payload: 'category=option&symbol=BTC-29JUL22-25000-C',
  });
  assert.equal(payload, '1658384314791XXXXXXXXXX5000category=option&symbol=BTC-29JUL22-25000-C');
  assert.equal(signer.sign(payload), 'c00720f96c5934ca7057ac28ae65b823f83b8b67a8fe784e7795ca0fa3c148ec');
});

test('HMAC-подпись тела с не-ASCII символами считается по UTF-8', () => {
  const signer = createSigner('секрет');
  const payload = restSignPayload({
    timestamp: 1700000000000,
    apiKey: 'KEY',
    recvWindow: 5000,
    payload: '{"qty":"0.01","note":"тест"}',
  });
  assert.equal(signer.sign(payload), '775a6a5c16ba76550f584d119741608888f0f57c6a89ec8340d2b37ee05f2d54');
});

test('строка авторизации WebSocket', () => {
  assert.equal(wsAuthPayload(1700000000000), 'GET/realtime1700000000000');
  assert.equal(
    createSigner('test-secret').sign(wsAuthPayload(1700000000000)),
    '5e1a6810262f270b783cf759f856aadee413643be3c03d0fb89dd22261e41df0',
  );
});

test('RSA-ключ, вставленный одной строкой, восстанавливается и подписывает в base64', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const oneLine = pem.replace(/\n/g, ' ');
  const escaped = pem.replace(/\n/g, '\\n');
  for (const variant of [pem, oneLine, escaped]) {
    const normalized = normalizePem(variant);
    assert.match(normalized, /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/);
    const signer = createSigner(variant);
    assert.equal(signer.type, 'rsa');
    const signature = signer.sign('1700000000000KEY5000category=spot');
    assert.match(signature, /^[A-Za-z0-9+/]+=*$/);
    assert.ok(
      verify('RSA-SHA256', Buffer.from('1700000000000KEY5000category=spot'), publicKey, Buffer.from(signature, 'base64')),
    );
  }
});

test('обычный секрет не принимается за PEM, битый PEM — ошибка', () => {
  assert.equal(normalizePem('abcdef'), null);
  assert.throws(() => createSigner('-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----'));
});
