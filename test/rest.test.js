import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { buildQuery, encodeQueryValue, isV5Path, RestClient } from '../server/rest.js';
import { mockFetch, silentLogger } from './helpers.js';

const env = (over = {}) => ({
  name: 'demo',
  restUrl: 'https://api-demo.bybit.com',
  apiKey: 'KEY',
  apiSecret: 'SECRET',
  hasKeys: true,
  ...over,
});

const hmac = (s) => createHmac('sha256', 'SECRET').update(s).digest('hex');

test('значения запроса: готовые %XX сохраняются, опасные символы кодируются', () => {
  assert.equal(encodeQueryValue('0%3A1679%2C0%3A1680'), '0%3A1679%2C0%3A1680');
  assert.equal(encodeQueryValue('BTC-29JUL22-25000-C'), 'BTC-29JUL22-25000-C');
  assert.equal(encodeQueryValue('a b&c+d#e'), 'a%20b%26c%2Bd%23e');
  assert.equal(encodeQueryValue("it's"), 'it%27s');
  assert.equal(encodeQueryValue('100%'), '100%25');
  assert.equal(encodeQueryValue('тест'), '%D1%82%D0%B5%D1%81%D1%82');
  assert.equal(encodeQueryValue('😀'), '%F0%9F%98%80');
  assert.equal(encodeQueryValue('USDT,USDC'), 'USDT,USDC');
});

test('строка запроса не меняется при разборе URL — подпись совпадает с отправленным', () => {
  const tricky = { cursor: 'page%3D2%26x', note: 'a b"c<d>e\'f`g{h}|i\\j^k', symbol: 'BTCUSDT', list: ['A', 'B'] };
  const query = buildQuery(tricky);
  const url = new URL(`https://api.bybit.com/v5/x?${query}`);
  assert.equal(url.search.slice(1), query);
});

test('buildQuery пропускает null/undefined и склеивает массивы', () => {
  assert.equal(buildQuery({ a: 1, b: null, c: undefined, d: true, e: ['x', 'y'] }), 'a=1&d=true&e=x,y');
});

test('isV5Path', () => {
  assert.ok(isV5Path('/v5/market/time'));
  assert.ok(isV5Path('/v5/earn/pwm/investment-plan/fund-nav'));
  for (const bad of ['/v5', '/v5/', '/v5//x', '/v5/../admin', '/v5/./x', '/v3/x', 'v5/x', '/v5/x?y=1', '/v5/x y']) {
    assert.ok(!isV5Path(bad), bad);
  }
});

test('GET подписывается по той же строке, что уходит в URL', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ json: { retCode: 0, retMsg: 'OK', result: {} } }));
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger, recvWindow: 7000 });
  await client.request({ method: 'GET', path: '/v5/order/realtime', params: { category: 'linear', cursor: 'a%3Ab' }, sign: true });
  const call = calls.find((c) => c.path === '/v5/order/realtime');
  assert.equal(call.rawQuery, 'category=linear&cursor=a%3Ab');
  assert.equal(call.headers['x-bapi-api-key'], 'KEY');
  assert.equal(call.headers['x-bapi-recv-window'], '7000');
  assert.equal(call.headers['x-bapi-sign'], hmac(`${call.headers['x-bapi-timestamp']}KEY7000${call.rawQuery}`));
  assert.equal(call.redirect, 'error');
  assert.ok(calls.some((c) => c.path === '/v5/market/time'), 'время сверяется перед первой подписью');
});

test('POST подписывается по телу запроса', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ json: { retCode: 0, retMsg: 'OK', result: {} } }));
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger });
  await client.request({ method: 'POST', path: '/v5/order/create', params: { category: 'linear', qty: '0.01' }, sign: true });
  const call = calls.find((c) => c.path === '/v5/order/create');
  assert.equal(call.body, '{"category":"linear","qty":"0.01"}');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['x-bapi-sign'], hmac(`${call.headers['x-bapi-timestamp']}KEY5000${call.body}`));
});

test('публичный запрос без заголовков авторизации; Referer брокера передаётся', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({}));
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger, referer: 'BROKER' });
  await client.request({ path: '/v5/market/tickers', params: { category: 'spot' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-bapi-sign'], undefined);
  assert.equal(calls[0].headers['x-referer'], 'BROKER');
});

test('смещение часов берётся из timeNano и попадает в подпись', async () => {
  let now = 1_000_000;
  const handler = (call) => {
    if (call.path === '/v5/market/time') return { json: { retCode: 0, result: { timeNano: '1005000000000' }, time: 1005000 } };
    return {};
  };
  handler.handlesTime = true;
  const { fetchImpl, calls } = mockFetch(handler);
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger, now: () => now });
  await client.request({ path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' }, sign: true });
  assert.equal(client.offset, 5000);
  assert.equal(calls.at(-1).headers['x-bapi-timestamp'], String(now + 5000));
});

test('ошибка времени 10002: пересверка часов и повтор', async () => {
  let n = 0;
  const { fetchImpl, calls } = mockFetch((call) => {
    if (call.path !== '/v5/order/create') return {};
    n++;
    return { json: n === 1 ? { retCode: 10002, retMsg: 'timestamp' } : { retCode: 0, retMsg: 'OK', result: { orderId: '1' } } };
  });
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger });
  const res = await client.request({ method: 'POST', path: '/v5/order/create', params: {}, sign: true });
  assert.equal(res.json.retCode, 0);
  assert.equal(res.attempts, 2);
  assert.equal(calls.filter((c) => c.path === '/v5/market/time').length, 2);
});

test('POST после сетевого сбоя не повторяется, исход неизвестен', async () => {
  const { fetchImpl, calls } = mockFetch((call) =>
    call.path === '/v5/order/create' ? Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) : {},
  );
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger });
  await assert.rejects(
    client.request({ method: 'POST', path: '/v5/order/create', params: {}, sign: true }),
    (err) => err.details.executed === 'unknown' && /Неизвестно, выполнил ли Bybit/.test(err.message),
  );
  assert.equal(calls.filter((c) => c.path === '/v5/order/create').length, 1);
});

test('POST, который не ушёл (ECONNREFUSED), повторяется; GET повторяется при сбоях и 5xx', async () => {
  let posts = 0;
  let gets = 0;
  const { fetchImpl } = mockFetch((call) => {
    if (call.path === '/v5/order/create') {
      posts++;
      return posts < 2 ? Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) : {};
    }
    gets++;
    if (gets === 1) return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (gets === 2) return { status: 502, text: 'Bad Gateway' };
    return {};
  });
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger });
  await client.request({ method: 'POST', path: '/v5/order/create', sign: true });
  assert.equal(posts, 2);
  const res = await client.request({ path: '/v5/market/tickers' });
  assert.equal(gets, 3);
  assert.equal(res.attempts, 3);
});

test('10006 с близким сбросом окна: ожидание и один повтор', async () => {
  let n = 0;
  const { fetchImpl } = mockFetch(() => {
    n++;
    if (n === 1) {
      return {
        json: { retCode: 10006, retMsg: 'Too many visits' },
        headers: { 'X-Bapi-Limit': '10', 'X-Bapi-Limit-Status': '0', 'X-Bapi-Limit-Reset-Timestamp': String(Date.now() + 250) },
      };
    }
    return { json: { retCode: 0, retMsg: 'OK', result: {} }, headers: { 'X-Bapi-Limit': '10', 'X-Bapi-Limit-Status': '9' } };
  });
  const client = new RestClient(env(), { fetchImpl, logger: silentLogger });
  const started = Date.now();
  const res = await client.request({ path: '/v5/market/tickers' });
  assert.equal(res.json.retCode, 0);
  assert.ok(Date.now() - started >= 150);
  assert.deepEqual(res.rateLimit, { remaining: 9, limit: 10, resetAt: undefined });
});

test('без ключей подписанный запрос не отправляется', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({}));
  const client = new RestClient(env({ hasKeys: false, apiKey: '', apiSecret: '' }), { fetchImpl, logger: silentLogger });
  await assert.rejects(client.request({ path: '/v5/account/wallet-balance', sign: true }), /не заданы API-ключи/);
  assert.equal(calls.length, 0);
});

test('отмена прерывает запрос', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const client = new RestClient(env({ hasKeys: false }), { fetchImpl, logger: silentLogger });
  const controller = new AbortController();
  const pending = client.request({ path: '/v5/market/tickers', signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
});

test('зависшая сеть: весь запрос укладывается в общий предел, код таймаута читаемый', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const client = new RestClient(env(), { fetchImpl: hang, logger: silentLogger, timeoutMs: 15000 });
  const started = Date.now();
  await assert.rejects(
    client.request({ path: '/v5/account/wallet-balance', sign: true, budgetMs: 2500 }),
    (err) => /Сетевая ошибка: TIMEOUT/.test(err.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4500, `ушло ${elapsed} мс`);
});
