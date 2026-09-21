// Подпись запросов Bybit V5.
//   REST:      timestamp + apiKey + recvWindow + (queryString | jsonBody)
//   WebSocket: "GET/realtime" + expires
// Системные ключи подписываются HMAC-SHA256 (hex), собственные RSA-ключи —
// RSA-SHA256 (base64).

import { createHmac, createPrivateKey, sign } from 'node:crypto';

// PEM, вставленный в однострочное поле настроек, теряет переводы строк.
// Восстанавливаем форму: заголовок, тело по 64 символа, окончание.
export function normalizePem(secret) {
  const m = String(secret).match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return null;
  const body = m[2].replace(/\\n/g, '').replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${m[1]}-----\n${lines.join('\n')}\n-----END ${m[1]}-----\n`;
}

export function createSigner(secret) {
  const pem = normalizePem(secret);
  if (pem) {
    const key = createPrivateKey(pem);
    return {
      type: 'rsa',
      sign: (payload) => sign('RSA-SHA256', Buffer.from(payload, 'utf8'), key).toString('base64'),
    };
  }
  return {
    type: 'hmac',
    sign: (payload) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex'),
  };
}

export function restSignPayload({ timestamp, apiKey, recvWindow, payload }) {
  return `${timestamp}${apiKey}${recvWindow}${payload}`;
}

export function wsAuthPayload(expires) {
  return `GET/realtime${expires}`;
}
