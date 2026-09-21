import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeParamSchemas, plainNumber, prepareParams } from '../server/params.js';
import { catalog } from './helpers.js';

const schemaOf = (path) => catalog.lookup(path)[0].params;

test('числа без экспоненты', () => {
  assert.equal(plainNumber(0.1), '0.1');
  assert.equal(plainNumber(123), '123');
  assert.equal(plainNumber(1e-7), '0.0000001');
  assert.equal(plainNumber(-2.5e-8), '-0.000000025');
  assert.equal(plainNumber(1.5e21), '1500000000000000000000');
  assert.equal(plainNumber(1.23e-5), '0.0000123');
  assert.throws(() => plainNumber(Number.NaN));
});

test('ордер: типы приводятся к ожидаемым Bybit', () => {
  const res = prepareParams(
    schemaOf('/v5/order/create'),
    { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', qty: 0.001, price: 65000, positionIdx: '1', reduceOnly: 'false', isLeverage: true },
    { method: 'POST', strictUnknown: true },
  );
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.params, {
    category: 'linear',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    qty: '0.001',
    price: '65000',
    positionIdx: 1,
    reduceOnly: false,
    isLeverage: 1,
  });
  assert.equal(res.warnings.length, 1);
});

test('ордер: опечатка в имени и пропущенный обязательный параметр — ошибки', () => {
  const res = prepareParams(
    schemaOf('/v5/order/create'),
    { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', quantity: '1' },
    { method: 'POST', strictUnknown: true },
  );
  assert.ok(res.errors.some((e) => e.includes('unknown parameter "quantity"')));
  assert.ok(res.errors.some((e) => e.includes('missing required parameter "qty"')));
});

test('чтение: неизвестный параметр — только предупреждение; числа в GET остаются строками', () => {
  const res = prepareParams(schemaOf('/v5/market/kline'), { symbol: 'BTCUSDT', interval: 60, limit: '5', foo: 1 }, { method: 'GET' });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.params, { symbol: 'BTCUSDT', interval: '60', limit: '5', foo: 1 });
  assert.ok(res.warnings.some((w) => w.includes('"foo"')));
});

test('пакетный ордер: проверяются вложенные объекты', () => {
  const schema = schemaOf('/v5/order/create-batch');
  const ok = prepareParams(
    schema,
    { category: 'linear', request: [{ symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', qty: 0.01, price: '1' }] },
    { method: 'POST', strictUnknown: true },
  );
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.params.request[0].qty, '0.01');

  const bad = prepareParams(
    schema,
    { category: 'linear', request: [{ symbol: 'BTCUSDT', side: 'Buy', qty: '1', px: '1' }, 'x'] },
    { method: 'POST', strictUnknown: true },
  );
  assert.ok(bad.errors.includes('missing required parameter "request[0].orderType"'));
  assert.ok(bad.errors.includes('unknown parameter "request[0].px"'));
  assert.ok(bad.errors.includes('"request[1]" must be an object'));
});

test('массив, переданный строкой JSON, разбирается', () => {
  const res = prepareParams(
    schemaOf('/v5/order/create-batch'),
    { category: 'linear', request: '[{"symbol":"BTCUSDT","side":"Buy","orderType":"Market","qty":"1"}]' },
    { method: 'POST', strictUnknown: true },
  );
  assert.deepEqual(res.errors, []);
  assert.equal(res.params.request.length, 1);
});

test('неверные типы', () => {
  const res = prepareParams(
    schemaOf('/v5/position/set-leverage'),
    { category: 'linear', symbol: { a: 1 }, buyLeverage: '10', sellLeverage: '10' },
    { method: 'POST', strictUnknown: true },
  );
  assert.deepEqual(res.errors, ['"symbol" must be a string']);
  const res2 = prepareParams(schemaOf('/v5/order/create'), { positionIdx: 1.5, reduceOnly: 'maybe' }, { method: 'POST' });
  assert.ok(res2.errors.includes('"positionIdx" must be an integer, got 1.5'));
  assert.ok(res2.errors.includes('"reduceOnly" must be true or false'));
});

test('объединение схем: обязательно только то, что обязательно везде', () => {
  const merged = mergeParamSchemas([
    [
      { name: 'a', type: 'string', required: true },
      { name: 'b', type: 'string', required: true },
    ],
    [
      { name: 'a', type: 'string', required: true },
      { name: 'c', type: 'integer' },
    ],
  ]);
  assert.deepEqual(merged, [
    { name: 'a', type: 'string', required: true },
    { name: 'b', type: 'string' },
    { name: 'c', type: 'integer' },
  ]);
});

test('null и undefined не отправляются', () => {
  const res = prepareParams(schemaOf('/v5/market/tickers'), { category: 'spot', symbol: null, baseCoin: undefined });
  assert.deepEqual(res.params, { category: 'spot' });
});

test('опасные имена параметров и слишком большие числа', () => {
  const input = JSON.parse('{"category":"spot","__proto__":{"symbol":"X"}}');
  const res = prepareParams(schemaOf('/v5/market/orderbook'), input);
  assert.ok(res.errors.includes('parameter name "__proto__" is not allowed'));
  assert.ok(res.errors.includes('missing required parameter "symbol"'), 'унаследованное поле не засчитывается');
  const big = prepareParams(schemaOf('/v5/order/cancel'), { category: 'spot', symbol: 'BTCUSDT', orderId: 1234567890123456789 }, { method: 'POST' });
  assert.ok(big.errors.some((e) => e.includes('"orderId" is too large')));
});
