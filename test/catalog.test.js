import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalog } from './helpers.js';

const one = (path) => {
  const list = catalog.lookup(path);
  assert.ok(list.length, `нет в каталоге: ${path}`);
  return list[0];
};

test('каталог целостен', () => {
  assert.ok(catalog.endpoints.length >= 400, `методов: ${catalog.endpoints.length}`);
  assert.match(catalog.source.commit ?? '', /^[0-9a-f]{40}$/);
  const ids = new Set();
  for (const e of catalog.endpoints) {
    assert.ok(!ids.has(e.id), `повтор id ${e.id}`);
    ids.add(e.id);
    assert.ok(['GET', 'POST'].includes(e.method), e.id);
    assert.match(e.path, /^\/v5(\/[A-Za-z0-9_.-]+)+$/, e.id);
    assert.ok(['read', 'trade', 'funds'].includes(e.tier), e.id);
    assert.ok(['public', 'optional', 'private'].includes(e.auth), e.id);
    assert.match(e.docs, /^https:\/\/bybit-exchange\.github\.io\/docs\/v5\//, e.id);
    assert.ok(Array.isArray(e.params), e.id);
    if (e.method === 'GET') assert.equal(e.tier, 'read', `GET не может менять состояние: ${e.id}`);
  }
});

test('одинаковые пути документированы с одинаковым уровнем доступа', () => {
  for (const list of catalog.byPath.values()) {
    assert.equal(new Set(list.map((e) => `${e.method} ${e.tier} ${e.auth}`)).size, 1, list[0].path);
  }
});

test('ключевые методы классифицированы верно', () => {
  const expect = {
    '/v5/market/time': ['read', 'public'],
    '/v5/market/kline': ['read', 'public'],
    '/v5/spread/orderbook': ['read', 'public'],
    '/v5/account/wallet-balance': ['read', 'private'],
    '/v5/position/list': ['read', 'private'],
    '/v5/order/pre-check': ['read', 'private'],
    '/v5/order/create': ['trade', 'private'],
    '/v5/order/cancel-all': ['trade', 'private'],
    '/v5/position/set-leverage': ['trade', 'private'],
    '/v5/position/trading-stop': ['trade', 'private'],
    '/v5/account/set-margin-mode': ['trade', 'private'],
    '/v5/spread/order/create': ['trade', 'private'],
    '/v5/position/move-positions': ['funds', 'private'],
    '/v5/asset/withdraw/create': ['funds', 'private'],
    '/v5/asset/withdraw/cancel': ['funds', 'private'],
    '/v5/asset/transfer/inter-transfer': ['funds', 'private'],
    '/v5/asset/transfer/universal-transfer': ['funds', 'private'],
    '/v5/asset/exchange/convert-execute': ['funds', 'private'],
    '/v5/account/borrow': ['funds', 'private'],
    '/v5/account/upgrade-to-uta': ['funds', 'private'],
    '/v5/user/create-sub-api': ['funds', 'private'],
    '/v5/user/update-api': ['funds', 'private'],
    '/v5/user/delete-api': ['funds', 'private'],
    '/v5/earn/place-order': ['funds', 'private'],
    '/v5/account/demo-apply-money': ['funds', 'private'],
    '/v5/earn/product': ['read', 'public'],
    '/v5/earn/token/product': ['read', 'optional'],
    '/v5/earn/hold-to-earn/product': ['read', 'optional'],
    '/v5/spot-margin-trade/data': ['read', 'public'],
    '/v5/ins-loan/product-infos': ['read', 'optional'],
  };
  for (const [path, [tier, auth]] of Object.entries(expect)) {
    const e = one(path);
    assert.equal(e.tier, tier, `${path}: уровень`);
    assert.equal(e.auth, auth, `${path}: авторизация`);
  }
});

test('поддержка демо-контура и ограничения по контурам', () => {
  for (const path of ['/v5/order/create', '/v5/position/list', '/v5/account/wallet-balance', '/v5/market/tickers', '/v5/spot-margin-trade/state']) {
    assert.ok(one(path).demo, path);
  }
  assert.ok(!one('/v5/asset/withdraw/create').demo);
  assert.deepEqual(one('/v5/account/demo-apply-money').envs, ['demo']);
  assert.deepEqual(one('/v5/user/create-demo-member').envs, ['mainnet']);
});

test('параметры разобраны: вложенность, перечисления, значения по умолчанию', () => {
  const batch = one('/v5/order/create-batch').params.find((p) => p.name === 'request');
  assert.equal(batch.type, 'array');
  assert.ok(batch.required);
  assert.ok(batch.children.some((c) => c.name === 'symbol' && c.required));
  const kline = one('/v5/market/kline').params;
  assert.equal(kline.find((p) => p.name === 'limit').default, '200');
  assert.deepEqual(kline.find((p) => p.name === 'limit').range, [1, 1000]);
  assert.equal(kline.find((p) => p.name === 'interval').enum, 'interval');
  assert.deepEqual(catalog.enums.interval, ['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'W', 'M']);
  assert.ok(catalog.enums.timeinforce.includes('PostOnly'));
  assert.ok(one('/v5/order/pre-check').params.some((p) => p.name === 'orderType'), 'параметры по ссылке на Place Order');
  assert.ok(one('/v5/strategy/create').params.some((p) => p.name === 'strategyType' && p.required), 'HTML-таблица');
});

test('поиск', () => {
  const r = catalog.search({ query: 'funding rate history' });
  assert.equal(r.results[0].path, '/v5/market/funding/history');
  assert.ok(catalog.search({ query: 'withdraw', tier: 'funds' }).results.some((e) => e.path === '/v5/asset/withdraw/create'));
  assert.equal(catalog.search({ query: 'zzz qqq' }).total, 0);
  const partial = catalog.search({ query: 'wallet balance nonsenseword' });
  assert.ok(partial.partial && partial.total > 0);
  assert.ok(catalog.search({ group: 'market', limit: 500 }).results.every((e) => e.group === 'market'));
  assert.ok(catalog.search({ query: 'abandon', includeDeprecated: false }).results.every((e) => !e.deprecated));
});

test('описание метода', () => {
  const text = catalog.describe(catalog.lookup('/v5/order/create'));
  assert.match(text, /^POST \/v5\/order\/create — Place Order/);
  assert.match(text, /tool: send_trading_request/);
  assert.match(text, /- qty\* \(string\)/);
  assert.match(text, /timeinforce: GTC \| IOC \| FOK \| PostOnly \| RPI/);
  const multi = catalog.describe(catalog.lookup('/v5/earn/advance/place-order'));
  assert.match(multi, /documented on 4 pages/);
});

test('создание ботов помечено как перевод средств; POST-чтение без глаголов записи', () => {
  const bots = catalog.endpoints.filter((e) => e.movesFunds).map((e) => e.path).sort();
  assert.deepEqual(bots, ['/v5/dca/create-bot', '/v5/fcombobot/create', '/v5/fgridbot/create', '/v5/fmartingalebot/create', '/v5/grid/create-grid']);
  assert.ok(bots.every((p) => one(p).tier === 'trade'));
  const writeVerb = /(?:^|[/_-])(create|cancel|place|submit|execute|transfer|withdraw|redeem|purchase|borrow|repay|stake|buy|sell|apply|confirm|delete|update|modify|set|switch|close|claim|invest|subscribe)(?=$|[/_-])/i;
  const readPosts = catalog.endpoints.filter((e) => e.method === 'POST' && e.tier === 'read');
  assert.ok(readPosts.length > 0);
  for (const e of readPosts) assert.ok(!writeVerb.test(e.path), e.path);
});

test('поиск без учёта регистра пути', () => {
  assert.equal(catalog.lookupIgnoreCase('/V5/Order/CREATE')[0].path, '/v5/order/create');
  assert.deepEqual(catalog.lookupIgnoreCase('/v5/nope'), []);
});
