import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apiCalls, makeExecutor, TEST_KEYS } from './helpers.js';

const OK = (result = {}) => ({ json: { retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: 1 } });
const parse = (res) => JSON.parse(res.text);

test('публичное чтение без ключей идёт на mainnet без подписи', async () => {
  const { executor, calls } = makeExecutor({ handler: () => OK({ list: [{ symbol: 'BTCUSDT' }] }) });
  const res = await executor.call({ tool: 'read', path: '/v5/market/tickers', params: { category: 'linear', symbol: 'BTCUSDT' } });
  assert.equal(res.isError, false);
  const body = parse(res);
  assert.equal(body.env, 'mainnet');
  assert.equal(body.request, 'GET /v5/market/tickers');
  assert.equal(body.result.list[0].symbol, 'BTCUSDT');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'https://api.bybit.com');
  assert.equal(calls[0].headers['x-bapi-sign'], undefined);
});

test('приватное чтение без ключей — понятная ошибка без запроса', async () => {
  const { executor, calls } = makeExecutor();
  await assert.rejects(
    executor.call({ tool: 'read', path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' } }),
    /No API key configured for the real account \(api\.bybit\.com\).*"Реальный счёт: API Key"/s,
  );
  assert.equal(calls.length, 0);
});

test('контур по умолчанию: demo при наличии демо-ключей, настройка важнее', async () => {
  const auto = makeExecutor({ env: TEST_KEYS, handler: () => OK() });
  assert.equal(auto.config.defaultEnv, 'demo');
  await auto.executor.call({ tool: 'read', path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' } });
  assert.equal(apiCalls(auto.calls)[0].origin, 'https://api-demo.bybit.com');
  assert.equal(apiCalls(auto.calls)[0].headers['x-bapi-api-key'], 'DEMOKEY456');

  const pinned = makeExecutor({ env: { ...TEST_KEYS, BYBIT_DEFAULT_ENV: 'mainnet' }, handler: () => OK() });
  await pinned.executor.call({ tool: 'read', path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' } });
  assert.equal(apiCalls(pinned.calls)[0].headers['x-bapi-api-key'], 'MAINKEY123');
});

test('торговля на mainnet выключена по умолчанию и не доходит до сети', async () => {
  const { executor, calls } = makeExecutor({ env: TEST_KEYS });
  await assert.rejects(
    executor.call({
      tool: 'trade',
      env: 'mainnet',
      path: '/v5/order/create',
      params: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001' },
    }),
    /Trading on mainnet is disabled.*"Реальный счёт: разрешить торговлю"/s,
  );
  await assert.rejects(
    executor.call({ tool: 'funds', env: 'mainnet', path: '/v5/asset/transfer/inter-transfer', params: {} }),
    /Fund operations .* on mainnet are disabled.*"Реальный счёт: разрешить операции со средствами"/s,
  );
  assert.equal(calls.length, 0);
  // Без ключа демо-счёта подсказка говорит, что его нужно добавить.
  const mainOnly = makeExecutor({ env: { BYBIT_MAINNET_API_KEY: 'k', BYBIT_MAINNET_API_SECRET: 's' } });
  await assert.rejects(
    mainOnly.executor.call({ tool: 'trade', env: 'mainnet', path: '/v5/order/cancel-all', params: { category: 'linear' } }),
    /everything is allowed once its API key is added \("Демо-счёт: API Key" \(BYBIT_DEMO_API_KEY\)\)/,
  );
});

test('торговля на mainnet после включения переключателя; средства — отдельно', async () => {
  const { executor, calls } = makeExecutor({
    env: { ...TEST_KEYS, BYBIT_MAINNET_ALLOW_TRADING: 'true' },
    handler: () => OK({ orderId: 'x1' }),
  });
  const res = await executor.call({
    tool: 'trade',
    env: 'mainnet',
    path: '/v5/order/create',
    params: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', qty: 0.001, price: 50000, orderLinkId: 't-1' },
  });
  assert.equal(res.isError, false);
  const sent = apiCalls(calls)[0];
  assert.equal(sent.method, 'POST');
  assert.deepEqual(JSON.parse(sent.body), {
    category: 'linear',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    qty: '0.001',
    price: '50000',
    orderLinkId: 't-1',
  });
  await assert.rejects(
    executor.call({ tool: 'funds', env: 'mainnet', path: '/v5/asset/withdraw/create', params: {} }),
    /Fund operations/,
  );
});

test('на демо-счёте разрешено всё', async () => {
  const { executor, calls } = makeExecutor({ env: TEST_KEYS, handler: () => OK() });
  await executor.call({
    tool: 'funds',
    env: 'demo',
    path: '/v5/account/demo-apply-money',
    params: { adjustType: 0, utaDemoApplyMoney: [{ coin: 'USDT', amountStr: '100000' }] },
  });
  const sent = apiCalls(calls)[0];
  assert.equal(sent.origin, 'https://api-demo.bybit.com');
  assert.equal(sent.path, '/v5/account/demo-apply-money');
});

test('скрытый уровень: подсказка называет причину и поле настроек', async () => {
  const pub = makeExecutor();
  await assert.rejects(
    pub.executor.call({ tool: 'read', path: '/v5/order/create', params: {} }),
    /"trade" endpoint — it needs send_trading_request, which is not available with the current settings \(mainnet: no API key; demo: no API key\); the user can change this in Claude Desktop → Settings → Extensions → Bybit V5/,
  );
  const mainOnly = makeExecutor({ env: { BYBIT_MAINNET_API_KEY: 'k', BYBIT_MAINNET_API_SECRET: 's', BYBIT_MAINNET_ALLOW_TRADING: 'true' } });
  assert.equal(mainOnly.executor.tierBlocker('trade'), null);
  assert.equal(
    mainOnly.executor.tierBlocker('funds'),
    'mainnet: switch "Реальный счёт: разрешить операции со средствами" (BYBIT_MAINNET_ALLOW_FUNDS) is off; demo: no API key',
  );
  assert.equal(pub.calls.length + mainOnly.calls.length, 0);
});

test('инструмент должен соответствовать уровню метода', async () => {
  const { executor } = makeExecutor({ env: TEST_KEYS });
  await assert.rejects(
    executor.call({ tool: 'read', path: '/v5/order/create', params: {} }),
    /"trade" endpoint — call it with send_trading_request/,
  );
  await assert.rejects(
    executor.call({ tool: 'trade', env: 'demo', path: '/v5/asset/withdraw/create', params: {} }),
    /"funds" endpoint — call it with send_funds_request/,
  );
  await assert.rejects(
    executor.call({ tool: 'funds', env: 'demo', path: '/v5/order/realtime', params: {} }),
    /"read" endpoint — call it with send_read_request/,
  );
  await assert.rejects(
    executor.call({ tool: 'trade', env: 'demo', path: '/v5/brand-new/thing', params: {} }),
    /not in the endpoint catalog/,
  );
  await assert.rejects(
    executor.call({ tool: 'read', path: '/v5/market/tickers', method: 'POST', params: {} }),
    /is a GET endpoint, not POST/,
  );
});

test('метод вне каталога: GET — через чтение, POST — только через send_funds_request', async () => {
  const { executor, calls } = makeExecutor({ env: TEST_KEYS, handler: () => OK() });
  const r = await executor.call({ tool: 'read', env: 'demo', path: '/v5/brand-new/list', params: { a: 1 } });
  assert.match(r.text, /not in the local catalog/);
  await assert.rejects(executor.call({ tool: 'read', env: 'demo', path: '/v5/brand-new/do', method: 'POST' }), /call it with send_funds_request/);
  await executor.call({ tool: 'funds', env: 'demo', path: '/v5/brand-new/do', params: { a: 1 } });
  const sent = apiCalls(calls);
  assert.equal(sent[0].headers['x-bapi-api-key'], 'DEMOKEY456', 'неизвестный метод подписывается');
  assert.equal(sent[1].method, 'POST');
});

test('ограничение по контуру', async () => {
  const { executor } = makeExecutor({ env: { ...TEST_KEYS, BYBIT_MAINNET_ALLOW_FUNDS: 'true' } });
  await assert.rejects(
    executor.call({ tool: 'funds', env: 'mainnet', path: '/v5/account/demo-apply-money', params: {} }),
    /works only with env="demo"/,
  );
});

test('разбор пути: префикс метода, полный URL (хост игнорируется), query, id каталога', async () => {
  const { executor, calls } = makeExecutor({ handler: () => OK() });
  await executor.call({ tool: 'read', path: 'https://evil.example.com/v5/market/tickers?category=spot&symbol=ETHUSDT' });
  assert.equal(calls[0].origin, 'https://api.bybit.com');
  assert.equal(calls[0].rawQuery, 'category=spot&symbol=ETHUSDT');
  await executor.call({ tool: 'read', path: 'GET v5/market/time' });
  assert.equal(calls[1].path, '/v5/market/time');
  await executor.call({ tool: 'read', path: 'market/tickers', params: { category: 'spot' } });
  assert.equal(calls[2].path, '/v5/market/tickers');
  for (const bad of ['/v3/public/time', '/v5/../x', 'ftp://x/v5/a', '', '/v5/market/time/../../x']) {
    await assert.rejects(executor.call({ tool: 'read', path: bad }), /not a Bybit V5 path|Invalid URL/, bad);
  }
});

test('ошибки параметров возвращаются до отправки', async () => {
  const { executor, calls } = makeExecutor({ env: TEST_KEYS });
  await assert.rejects(
    executor.call({ tool: 'trade', env: 'demo', path: '/v5/order/create', params: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', qty: '1', typo: 1 } }),
    (err) => /missing required parameter "orderType"/.test(err.message) && /unknown parameter "typo"/.test(err.message),
  );
  assert.equal(apiCalls(calls).length, 0);
});

test('allow_unknown_params и skip_validation', async () => {
  const { executor, calls } = makeExecutor({ env: TEST_KEYS, handler: () => OK() });
  await executor.call({
    tool: 'trade',
    env: 'demo',
    path: '/v5/order/cancel',
    params: { category: 'linear', symbol: 'BTCUSDT', orderId: '1', newField: 'x' },
    allowUnknownParams: true,
  });
  assert.equal(JSON.parse(apiCalls(calls)[0].body).newField, 'x');
  await executor.call({ tool: 'trade', env: 'demo', path: '/v5/order/cancel', params: { anything: 1 }, skipValidation: true });
  assert.equal(apiCalls(calls)[1].body, '{"anything":1}');
});

test('ошибка Bybit помечается и получает подсказку', async () => {
  const { executor } = makeExecutor({
    env: TEST_KEYS,
    handler: () => ({ json: { retCode: 10003, retMsg: 'API key is invalid.', result: {}, retExtInfo: {}, time: 1 } }),
  });
  const res = await executor.call({ tool: 'read', env: 'demo', path: '/v5/asset/withdraw/query-record', params: {} });
  assert.equal(res.isError, true);
  const body = parse(res);
  assert.equal(body.retCode, 10003);
  assert.match(body.hint, /Demo Trading keys work only with env="demo"/);
  assert.ok(body.notes.some((n) => n.includes('not in Bybit\'s list of Demo Trading endpoints')));
});

test('ответ не в JSON (403 от CDN)', async () => {
  const { executor } = makeExecutor({ handler: () => ({ status: 403, text: '<html>403 Forbidden</html>' }) });
  const res = await executor.call({ tool: 'read', path: '/v5/market/tickers', params: { category: 'spot' } });
  assert.equal(res.isError, true);
  const body = parse(res);
  assert.equal(body.httpStatus, 403);
  assert.match(body.hint, /access too frequent/);
});

test('HTTP 401 с пустым телом: подсказка про ключ и traceId', async () => {
  const { executor } = makeExecutor({
    env: TEST_KEYS,
    handler: () => ({ status: 401, text: '', headers: { traceid: 'abc123' } }),
  });
  const res = await executor.call({ tool: 'read', env: 'demo', path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' } });
  assert.equal(res.isError, true);
  const body = parse(res);
  assert.equal(body.error, 'Empty response');
  assert.equal(body.body, undefined);
  assert.equal(body.traceId, 'abc123');
  assert.match(body.hint, /Demo Trading keys work only with env="demo"/);
  const status = parse(await executor.status({ checkKeys: true }));
  assert.equal(status.envs.demo.key.ok, false);
  assert.equal(status.envs.demo.key.retMsg, 'HTTP 401');
  assert.match(status.envs.demo.key.hint, /did not accept the API key/);
});

test('постраничный вывод склеивает list и останавливается на повторе курсора', async () => {
  const pages = {
    '': { list: [1, 2], nextPageCursor: 'c1' },
    c1: { list: [3], nextPageCursor: 'c2' },
    c2: { list: [4], nextPageCursor: 'c2' },
  };
  const { executor, calls } = makeExecutor({
    env: TEST_KEYS,
    handler: (call) => OK({ category: 'linear', ...pages[new URL(call.url).searchParams.get('cursor') ?? ''] }),
  });
  const res = await executor.call({
    tool: 'read',
    env: 'demo',
    path: '/v5/order/history',
    params: { category: 'linear' },
    paginate: true,
    maxPages: 10,
  });
  const body = parse(res);
  assert.deepEqual(body.result.list, [1, 2, 3, 4]);
  assert.equal(body.pages, 3);
  assert.equal(apiCalls(calls).length, 3);
  assert.equal(body.result.category, 'linear');
});

test('постраничный вывод ограничен max_pages', async () => {
  let n = 0;
  const { executor } = makeExecutor({ handler: () => OK({ list: [++n], nextPageCursor: `c${n}` }) });
  const res = await executor.call({ tool: 'read', path: '/v5/market/instruments-info', params: { category: 'linear' }, paginate: true, maxPages: 2 });
  const body = parse(res);
  assert.deepEqual(body.result.list, [1, 2]);
  assert.equal(body.result.nextPageCursor, 'c2');
});

test('длинный ответ укорачивается с пометкой', async () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ symbol: `SYM${i}`, lastPrice: '1.2345', volume24h: '123456.789' }));
  const { executor } = makeExecutor({ env: { BYBIT_MAX_OUTPUT_CHARS: '20000' }, handler: () => OK({ list: big }) });
  const res = await executor.call({ tool: 'read', path: '/v5/market/tickers', params: { category: 'spot' } });
  assert.ok(res.text.length <= 20000);
  const body = parse(res);
  assert.equal(body._output.truncated[0].path, 'result.list');
  assert.equal(body._output.truncated[0].total, 5000);
  assert.equal(body.result.list.length, body._output.truncated[0].kept);
});

test('битый RSA-ключ: подсказка вместо падения', async () => {
  const { executor } = makeExecutor({
    env: { BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: '-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----' },
  });
  await assert.rejects(
    executor.call({ tool: 'read', env: 'demo', path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' } }),
    /не удалось прочитать закрытый RSA-ключ/,
  );
});

test('статус не раскрывает ключи', async () => {
  const { executor } = makeExecutor({
    env: { ...TEST_KEYS, BYBIT_MAINNET_API_KEY: 'ABCDEFGHIJKL' },
    handler: (call) =>
      call.path === '/v5/user/query-api'
        ? OK({ apiKey: 'ABCDEFGHIJKL', secret: '', readOnly: 1, permissions: { Spot: ['SpotTrade'] }, note: 'x' })
        : OK(),
  });
  const plain = parse(await executor.status());
  assert.equal(plain.envs.mainnet.apiKey, 'ABCD…KL');
  assert.equal(plain.envs.mainnet.trade, false);
  assert.equal(plain.envs.demo.trade, true);
  const checked = await executor.status({ checkKeys: true });
  assert.ok(!checked.text.includes('ABCDEFGHIJKL'));
  assert.ok(!checked.text.includes('main-secret') && !checked.text.includes('demo-secret'));
  const body = parse(checked);
  assert.equal(body.envs.mainnet.key.readOnly, 1);
  assert.equal(typeof body.envs.demo.clock.offsetMs, 'number');
});

test('неизвестный POST на mainnet требует обоих переключателей', async () => {
  const onlyFunds = makeExecutor({ env: { ...TEST_KEYS, BYBIT_MAINNET_ALLOW_FUNDS: 'true' }, handler: () => OK() });
  await assert.rejects(
    onlyFunds.executor.call({ tool: 'funds', env: 'mainnet', path: '/v5/order/create-twap', params: {} }),
    /not in the catalog, so it needs both mainnet switches.*Currently disabled: "Реальный счёт: разрешить торговлю"/s,
  );
  assert.equal(onlyFunds.calls.length, 0);
  const both = makeExecutor({
    env: { ...TEST_KEYS, BYBIT_MAINNET_ALLOW_FUNDS: 'true', BYBIT_MAINNET_ALLOW_TRADING: 'true' },
    handler: () => OK(),
  });
  await both.executor.call({ tool: 'funds', env: 'mainnet', path: '/v5/order/create-twap', params: {} });
  assert.equal(apiCalls(both.calls).length, 1);
});

test('создание бота на mainnet требует и торговли, и операций со средствами', async () => {
  const onlyTrade = makeExecutor({ env: { ...TEST_KEYS, BYBIT_MAINNET_ALLOW_TRADING: 'true' } });
  await assert.rejects(
    onlyTrade.executor.call({ tool: 'trade', env: 'mainnet', path: '/v5/fgridbot/create', params: {}, skipValidation: true }),
    /moves funds to a trading bot and needs both mainnet switches.*Currently disabled: "Реальный счёт: разрешить операции со средствами"/s,
  );
  const demo = makeExecutor({ env: TEST_KEYS, handler: () => OK({ status_code: 200, bot_id: '1' }) });
  const res = await demo.executor.call({ tool: 'trade', env: 'demo', path: '/v5/fgridbot/create', params: {}, skipValidation: true });
  assert.equal(res.isError, false);
});

test('путь в другом регистре — тот же метод и тот же уровень доступа', async () => {
  const { executor, calls } = makeExecutor({ env: { ...TEST_KEYS, BYBIT_MAINNET_ALLOW_FUNDS: 'true' } });
  await assert.rejects(
    executor.call({ tool: 'funds', env: 'mainnet', path: '/v5/Order/Create', params: {} }),
    /POST \/v5\/order\/create is a "trade" endpoint — call it with send_trading_request/,
  );
  assert.equal(calls.length, 0);
});

test('orderLinkId задаётся, если его не передали, и не перетирается', async () => {
  const { executor, calls } = makeExecutor({ env: TEST_KEYS, handler: () => OK({ orderId: '1' }) });
  const base = { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.01' };
  const res = await executor.call({ tool: 'trade', env: 'demo', path: '/v5/order/create', params: base });
  const sent = JSON.parse(apiCalls(calls)[0].body);
  assert.match(sent.orderLinkId, /^mcp-[a-z0-9]+-[0-9a-f]{8}$/);
  assert.ok(sent.orderLinkId.length <= 36);
  assert.ok(parse(res).notes.some((n) => n.includes(sent.orderLinkId)));

  await executor.call({ tool: 'trade', env: 'demo', path: '/v5/order/create', params: { ...base, orderLinkId: 'mine-1' } });
  assert.equal(JSON.parse(apiCalls(calls)[1].body).orderLinkId, 'mine-1');

  const { category, ...item } = base;
  await executor.call({
    tool: 'trade',
    env: 'demo',
    path: '/v5/order/create-batch',
    params: { category, request: [{ ...item }, { ...item, orderLinkId: 'keep' }] },
  });
  const batch = JSON.parse(apiCalls(calls)[2].body).request;
  assert.match(batch[0].orderLinkId, /^mcp-/);
  assert.equal(batch[1].orderLinkId, 'keep');

  await executor.call({ tool: 'trade', env: 'demo', path: '/v5/order/cancel', params: { category: 'linear', symbol: 'BTCUSDT', orderId: '1' } });
  assert.equal(JSON.parse(apiCalls(calls)[3].body).orderLinkId, undefined, 'для отмены id не придумывается');
});

test('исход неизвестен: таймаут и ошибка сервера на POST, но не отказ в доступе', async () => {
  const scenarios = [
    [{ json: { retCode: 10000, retMsg: 'Server Timeout', result: {} } }, true],
    [{ json: { retCode: 10016, retMsg: 'Server error', result: {} } }, true],
    [{ status: 502, text: '<html>Bad Gateway</html>' }, true],
    [{ status: 504, text: '' }, true],
    [{ status: 401, text: '' }, false],
    [{ status: 403, text: 'Forbidden' }, false],
    [{ json: { retCode: 110007, retMsg: 'insufficient balance', result: {} } }, false],
  ];
  for (const [reply, unknown] of scenarios) {
    const { executor } = makeExecutor({ env: TEST_KEYS, handler: () => reply });
    const res = await executor.call({
      tool: 'trade',
      env: 'demo',
      path: '/v5/order/create',
      params: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '1', orderLinkId: 'x' },
    });
    const body = parse(res);
    assert.equal(res.isError, true);
    assert.equal(Boolean(body.outcome), unknown, JSON.stringify(reply));
    if (unknown) assert.match(body.outcome, /outcome is unknown/);
    assert.doesNotMatch(body.hint ?? '', /retr/i, 'подсказка не предлагает повторить');
  }
  const { executor } = makeExecutor({ handler: () => ({ status: 502, text: 'x' }) });
  const read = parse(await executor.call({ tool: 'read', path: '/v5/market/tickers', params: { category: 'spot' } }));
  assert.equal(read.outcome, undefined, 'для чтения исход не важен');
});

test('частичные ошибки пакета и ботов', async () => {
  const batch = makeExecutor({
    env: TEST_KEYS,
    handler: () => ({
      json: {
        retCode: 0,
        retMsg: 'OK',
        result: { list: [{ orderId: '1' }, { orderId: '' }] },
        retExtInfo: { list: [{ code: 0, msg: 'OK' }, { code: 10001, msg: 'params error' }] },
      },
    }),
  });
  const request = [
    { symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '1', orderLinkId: 'a' },
    { symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '1', orderLinkId: 'b' },
  ];
  const partial = await batch.executor.call({ tool: 'trade', env: 'demo', path: '/v5/order/create-batch', params: { category: 'linear', request } });
  assert.equal(partial.isError, false);
  const body = parse(partial);
  assert.deepEqual(body.itemErrors, [{ index: 1, code: 10001, msg: 'params error' }]);
  assert.ok(body.notes.some((n) => n.includes('1 of 2 items failed')));

  const allFailed = makeExecutor({
    env: TEST_KEYS,
    handler: () => ({ json: { retCode: 0, retMsg: 'OK', result: { list: [{}] }, retExtInfo: { list: [{ code: 170131, msg: 'Insufficient balance' }] } } }),
  });
  const res2 = await allFailed.executor.call({ tool: 'trade', env: 'demo', path: '/v5/order/create-batch', params: { category: 'linear', request: [request[0]] } });
  assert.equal(res2.isError, true);

  const bot = makeExecutor({ env: TEST_KEYS, handler: () => OK({ status_code: 421, debug_msg: 'user banned' }) });
  const res3 = await bot.executor.call({ tool: 'trade', env: 'demo', path: '/v5/fgridbot/create', params: {}, skipValidation: true });
  assert.equal(res3.isError, true);
  assert.deepEqual(parse(res3).itemErrors, [{ field: 'result.status_code', code: 421, msg: 'user banned' }]);

  const check = makeExecutor({ env: TEST_KEYS, handler: () => OK({ check_code: 'FGRID_CHECK_CODE_PRICE_INVALID' }) });
  const res4 = await check.executor.call({ tool: 'read', env: 'demo', path: '/v5/fgridbot/validate', params: {}, skipValidation: true });
  assert.equal(res4.isError, false, 'результат проверки ввода — это ответ, а не сбой');
  assert.ok(parse(res4).notes.some((n) => n.includes('failed check')));
});

test('пагинация по rows и по nextCursor с признаком конца "0"', async () => {
  const rowsPages = { '': { rows: [1], nextPageCursor: 'p2' }, p2: { rows: [2], nextPageCursor: '' } };
  const rows = makeExecutor({
    env: TEST_KEYS,
    handler: (call) => OK(rowsPages[new URL(call.url).searchParams.get('cursor') ?? '']),
  });
  const r1 = parse(await rows.executor.call({ tool: 'read', env: 'demo', path: '/v5/asset/withdraw/query-record', params: {}, paginate: true }));
  assert.deepEqual(r1.result.rows, [1, 2]);
  assert.equal(r1.pages, 2);

  const subPages = { '': { subMembers: [{ uid: '1' }], nextCursor: '5' }, 5: { subMembers: [{ uid: '2' }], nextCursor: '0' } };
  const subs = makeExecutor({
    env: TEST_KEYS,
    handler: (call) => OK(subPages[new URL(call.url).searchParams.get('nextCursor') ?? '']),
  });
  const r2 = parse(await subs.executor.call({ tool: 'read', env: 'demo', path: '/v5/user/submembers', params: {}, paginate: true }));
  assert.deepEqual(r2.result.subMembers.map((m) => m.uid), ['1', '2']);
  assert.equal(r2.result.nextCursor, '0');
  assert.equal(apiCalls(subs.calls).length, 2);

  const none = makeExecutor({ handler: () => OK({ list: [1] }) });
  const r3 = parse(await none.executor.call({ tool: 'read', path: '/v5/market/tickers', params: { category: 'spot' }, paginate: true }));
  assert.ok(r3.notes.some((n) => n.includes('no cursor pagination')));
});

test('переданный курсор не запрашивается повторно', async () => {
  const { executor, calls } = makeExecutor({ env: TEST_KEYS, handler: () => OK({ list: [1], nextPageCursor: 'same' }) });
  await executor.call({ tool: 'read', env: 'demo', path: '/v5/order/history', params: { category: 'linear', cursor: 'same' }, paginate: true });
  assert.equal(apiCalls(calls).length, 1);
});

test('при обрезке списка курсор убирается, чтобы не пропустить записи', async () => {
  const list = Array.from({ length: 3000 }, (_, i) => ({ execId: `e${i}`, pad: 'x'.repeat(30) }));
  const { executor } = makeExecutor({
    env: { ...TEST_KEYS, BYBIT_MAX_OUTPUT_CHARS: '20000' },
    handler: () => OK({ category: 'linear', list, nextPageCursor: 'next-page' }),
  });
  const body = parse(await executor.call({ tool: 'read', env: 'demo', path: '/v5/execution/list', params: { category: 'linear' } }));
  assert.equal(body.result.nextPageCursor, null);
  assert.match(body._output.hint, /cursor was removed/);
  assert.ok(body.result.list.length < 3000);
});

test('WebSocket: темы dcp запрещены, канал и числа проверяются', async () => {
  const { executor } = makeExecutor({ env: TEST_KEYS });
  for (const topics of [['dcp.future'], ['order', 'DCP.spot'], ['dcp']]) {
    await assert.rejects(executor.stream({ env: 'mainnet', channel: 'private', topics }), /dcp topics are refused/);
  }
  await assert.rejects(executor.stream({ channel: '../trade', topics: ['a'] }), /channel must be one of/);
  let seen;
  executor.WebSocketImpl = class {
    constructor(url) {
      seen = url;
      setTimeout(() => this.onopen?.(), 1);
    }
    send() {}
    close() {}
  };
  const started = Date.now();
  const res = await executor.stream({ channel: 'spot', topics: ['tickers.BTCUSDT'], durationSeconds: 0.001, maxMessages: 'x', depth: -5 });
  assert.equal(seen, 'wss://stream.bybit.com/v5/public/spot');
  assert.ok(Date.now() - started < 3000, 'длительность ограничена снизу 1 с');
  assert.equal(parse(res).received, 0);
});

test('коды проверки ботов: SUCCESS и UNSPECIFIED — успех', async () => {
  for (const code of ['FGRID_CHECK_CODE_UNSPECIFIED', 'FGRID_CHECK_CODE_SUCCESS', 'SPOT_CHECK_CODE_SUCCESS_UNSPECIFIED', 'F_MART_LIMIT_CHECK_CODE_F_MART_CHECK_CODE_SUCCESS_UNSPECIFIED']) {
    const { executor } = makeExecutor({ env: TEST_KEYS, handler: () => OK({ status_code: 200, bot_id: '6123', check_code: code, debug_msg: '' }) });
    const res = await executor.call({ tool: 'trade', env: 'demo', path: '/v5/fgridbot/create', params: {}, skipValidation: true });
    assert.equal(res.isError, false, code);
    assert.equal(parse(res).itemErrors, undefined, code);
  }
  const { executor } = makeExecutor({ env: TEST_KEYS, handler: () => OK({ status_code: 200, check_code: 'SPOT_CHECK_CODE_GRID_NO_TOO_HIGH' }) });
  const failed = await executor.call({ tool: 'trade', env: 'demo', path: '/v5/grid/create-grid', params: {}, skipValidation: true });
  assert.equal(failed.isError, true);
  assert.ok(parse(failed).notes.some((n) => n.includes('Before retrying, check whether')));
});

test('сбой сети после отправки ордера: сгенерированный orderLinkId в тексте ошибки', async () => {
  const { executor } = makeExecutor({
    env: TEST_KEYS,
    handler: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
  });
  await assert.rejects(
    executor.call({
      tool: 'trade',
      env: 'demo',
      path: '/v5/order/create',
      params: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '1' },
    }),
    (err) => /Неизвестно, выполнил ли Bybit/.test(err.message) && /orderLinkId generated for this request: mcp-/.test(err.message),
  );
});

test('склейка страниц: курсор берётся только с последней страницы', async () => {
  const pages = { '': { list: [1], nextPageCursor: 'c1' }, c1: { list: [2] } };
  const { executor } = makeExecutor({
    env: TEST_KEYS,
    handler: (call) => OK(pages[new URL(call.url).searchParams.get('cursor') ?? '']),
  });
  const body = parse(await executor.call({ tool: 'read', env: 'demo', path: '/v5/order/history', params: { category: 'linear' }, paginate: true }));
  assert.deepEqual(body.result.list, [1, 2]);
  assert.equal(Object.hasOwn(body.result, 'nextPageCursor'), false);
});

test('POST-методы чтения не получают пометку «исход неизвестен»', async () => {
  const { executor } = makeExecutor({ env: TEST_KEYS, handler: () => ({ status: 502, text: 'Bad Gateway' }) });
  const res = await executor.call({
    tool: 'read',
    env: 'demo',
    path: '/v5/order/pre-check',
    params: { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '1' },
  });
  assert.equal(res.isError, true);
  assert.equal(parse(res).outcome, undefined);
});

test('открытый метод вне списка демо-сервиса без явного счёта идёт на mainnet без подписи', async () => {
  // Ключи обоих счетов, счёт по умолчанию — demo (auto).
  const { executor, calls, config } = makeExecutor({ env: TEST_KEYS, handler: () => OK({ list: [] }) });
  assert.equal(config.defaultEnv, 'demo');
  const routed = parse(await executor.call({ tool: 'read', path: '/v5/announcements/index', params: { locale: 'en-US' } }));
  assert.equal(routed.env, 'mainnet');
  assert.match(routed.notes.join(' '), /served from mainnet/);
  let sent = apiCalls(calls);
  assert.equal(sent[0].origin, 'https://api.bybit.com');
  assert.equal(sent[0].headers['x-bapi-sign'], undefined);
  // Метод с необязательной подписью тоже не подписывается ключом счёта, о котором не просили.
  await executor.call({ tool: 'read', path: '/v5/earn/token/product', params: { coin: 'USDT' } });
  sent = apiCalls(calls);
  assert.equal(sent[1].origin, 'https://api.bybit.com');
  assert.equal(sent[1].headers['x-bapi-api-key'], undefined);
  // Рыночные данные остаются на счёте по умолчанию, явный env уважается.
  await executor.call({ tool: 'read', path: '/v5/market/tickers', params: { category: 'spot' } });
  await executor.call({ tool: 'read', env: 'demo', path: '/v5/announcements/index', params: { locale: 'en-US' } });
  sent = apiCalls(calls);
  assert.equal(sent[2].origin, 'https://api-demo.bybit.com');
  assert.equal(sent[3].origin, 'https://api-demo.bybit.com');
});

test('нет ключа у счёта по умолчанию — подсказка про счёт, у которого он есть', async () => {
  const { executor, calls } = makeExecutor({
    env: { BYBIT_DEMO_API_KEY: 'dk', BYBIT_DEMO_API_SECRET: 'ds', BYBIT_DEFAULT_ENV: 'mainnet' },
  });
  await assert.rejects(
    executor.call({ tool: 'read', path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' } }),
    /No API key configured for the real account.*\(BYBIT_MAINNET_API_KEY\).*The demo account has an API key: pass env="demo" to use it/s,
  );
  assert.equal(calls.length, 0);
});

test('доступность метода по счетам', () => {
  const entry = (path) => makeExecutor().executor.catalog.lookup(path)[0];
  const demoOnly = makeExecutor({ env: { BYBIT_DEMO_API_KEY: 'dk', BYBIT_DEMO_API_SECRET: 'ds' } }).executor;
  assert.deepEqual(demoOnly.availability(entry('/v5/user/create-demo-member')), {
    ok: [],
    blocked: ['mainnet: no API key', 'demo: the endpoint does not exist there'],
  });
  assert.deepEqual(demoOnly.availability(entry('/v5/order/create')), { ok: ['demo'], blocked: ['mainnet: no API key'] });
  assert.deepEqual(demoOnly.availability(entry('/v5/market/tickers')), { ok: ['mainnet', 'demo'], blocked: [] });
  const mainTrade = makeExecutor({ env: { BYBIT_MAINNET_API_KEY: 'k', BYBIT_MAINNET_API_SECRET: 's', BYBIT_MAINNET_ALLOW_TRADING: 'true' } }).executor;
  const bot = mainTrade.availability(entry('/v5/fgridbot/create'));
  assert.deepEqual(bot.ok, []);
  assert.match(bot.blocked[0], /^mainnet: switch "Реальный счёт: разрешить операции со средствами" \(BYBIT_MAINNET_ALLOW_FUNDS\) is off$/);
});
