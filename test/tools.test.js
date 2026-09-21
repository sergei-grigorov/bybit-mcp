// Набор инструментов по настройкам и согласованность с manifest.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SETTING_TITLES } from '../server/config.js';
import { buildInstructions, createServer } from '../server/index.js';
import { ALL_TOOL_NAMES } from '../server/tools.js';
import { NAME, VERSION } from '../server/version.js';
import { TEST_KEYS } from './helpers.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const PUBLIC_TOOLS = [
  'bybit_search_endpoints',
  'bybit_describe_endpoint',
  'bybit_read',
  'bybit_stream',
  'bybit_status',
  'bybit_get_tickers',
  'bybit_get_kline',
  'bybit_get_orderbook',
  'bybit_get_recent_trades',
  'bybit_get_funding_history',
  'bybit_get_open_interest',
  'bybit_get_instruments',
];
const ACCOUNT_TOOLS = ['bybit_get_wallet_balance', 'bybit_get_positions', 'bybit_get_open_orders', 'bybit_get_order_history', 'bybit_get_executions'];
const TRADE_TOOLS = ['bybit_trade', 'bybit_place_order', 'bybit_amend_order', 'bybit_cancel_order', 'bybit_cancel_all_orders', 'bybit_set_leverage', 'bybit_set_trading_stop'];

const MAINNET = { BYBIT_MAINNET_API_KEY: TEST_KEYS.BYBIT_MAINNET_API_KEY, BYBIT_MAINNET_API_SECRET: TEST_KEYS.BYBIT_MAINNET_API_SECRET };
const DEMO = { BYBIT_DEMO_API_KEY: TEST_KEYS.BYBIT_DEMO_API_KEY, BYBIT_DEMO_API_SECRET: TEST_KEYS.BYBIT_DEMO_API_SECRET };

function toolsFor(env) {
  const { server } = createServer({ env });
  const list = server.listTools();
  return { names: list.map((t) => t.name), byName: Object.fromEntries(list.map((t) => [t.name, t])), server };
}

const sorted = (a) => [...a].sort();

test('без ключей — только открытые методы', () => {
  const { names, byName, server } = toolsFor({});
  assert.deepEqual(sorted(names), sorted(PUBLIC_TOOLS));
  assert.ok(!byName.bybit_stream.inputSchema.properties.channel.enum.includes('private'));
  assert.match(byName.bybit_read.description, /No API key is configured, so only public endpoints work/);
  assert.match(server.instructions, /No account is connected, so only public data is available/);
  assert.match(server.instructions, /Settings → Extensions → Bybit V5/);
  assert.doesNotMatch(server.instructions, /explicit user|confirmation/i);
});

test('описание метода говорит, если его уровень недоступен при текущих настройках', async () => {
  const { server } = createServer({ env: {} });
  const describe = async (endpoint) =>
    (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bybit_describe_endpoint', arguments: { endpoint } } }))
      .result.content[0].text;
  assert.match(await describe('POST /v5/order/create'), /Not available with the current connector settings \(mainnet: no API key; demo: no API key\)/);
  assert.doesNotMatch(await describe('/v5/market/tickers'), /Not available/);
});

test('битый ключ: инструменты счёта скрыты, инструкции объясняют', () => {
  const { names, server } = toolsFor({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: '-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----' });
  assert.deepEqual(sorted(names), sorted(PUBLIC_TOOLS));
  assert.match(server.instructions, /"demo" = Demo Trading account at api-demo\.bybit\.com \(API key set, but the secret could not be read;/);
});

test('вызов скрытого инструмента объясняет, чего не хватает', async () => {
  const { server } = createServer({ env: MAINNET });
  const call = (name) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
  const hidden = await call('bybit_place_order');
  assert.equal(hidden.result.isError, true);
  assert.ok(
    hidden.result.content[0].text.startsWith(
      'bybit_place_order is not available with the current connector settings (mainnet: switch "Реальный счёт: разрешить торговлю" (BYBIT_MAINNET_ALLOW_TRADING) is off; demo: no API key).',
    ),
  );
  const pub = createServer({ env: {} }).server;
  const wallet = await pub.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bybit_get_wallet_balance', arguments: {} } });
  assert.match(wallet.result.content[0].text, /\(mainnet: no API key; demo: no API key\)/);
  assert.equal((await call('bybit_nope')).error.code, -32602);
});

test('описание метода: где он работает при текущих настройках', async () => {
  const describe = async (env, endpoint) =>
    (await createServer({ env }).server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bybit_describe_endpoint', arguments: { endpoint } } }))
      .result.content[0].text;
  assert.match(
    await describe(DEMO, 'POST /v5/user/create-demo-member'),
    /Not available with the current connector settings \(mainnet: no API key; demo: the endpoint does not exist there\)/,
  );
  assert.match(
    await describe({ ...MAINNET, ...DEMO }, 'POST /v5/order/create'),
    /With the current connector settings: works with env "demo"; not with mainnet: switch "Реальный счёт: разрешить торговлю" \(BYBIT_MAINNET_ALLOW_TRADING\) is off\./,
  );
});

test('демо-счёт — все инструменты, на демо разрешено всё', () => {
  const { names, byName, server } = toolsFor(DEMO);
  assert.deepEqual(sorted(names), sorted([...PUBLIC_TOOLS, ...ACCOUNT_TOOLS, ...TRADE_TOOLS, 'bybit_funds']));
  assert.ok(byName.bybit_stream.inputSchema.properties.channel.enum.includes('private'));
  assert.match(byName.bybit_trade.inputSchema.properties.env.description, /Allowed by the connector settings: "demo"\./);
  assert.match(byName.bybit_funds.description, /Allowed by the connector settings on: "demo"/);
  assert.match(server.instructions, /Read calls without "env" go to "demo"/);
  assert.doesNotMatch(server.instructions, /Not available with the current settings/);
});

test('реальный счёт по умолчанию — только чтение, скрытое объясняется', () => {
  const { names, server } = toolsFor(MAINNET);
  assert.deepEqual(sorted(names), sorted([...PUBLIC_TOOLS, ...ACCOUNT_TOOLS]));
  assert.ok(
    server.instructions.includes(`trading tools (mainnet: switch "${SETTING_TITLES.trade}" (BYBIT_MAINNET_ALLOW_TRADING) is off; demo: no API key)`),
  );
  assert.ok(
    server.instructions.includes(`the funds tool (mainnet: switch "${SETTING_TITLES.funds}" (BYBIT_MAINNET_ALLOW_FUNDS) is off; demo: no API key)`),
  );
});

test('реальный счёт с торговлей — торговля есть, операций со средствами нет', () => {
  const { names, byName } = toolsFor({ ...MAINNET, BYBIT_MAINNET_ALLOW_TRADING: 'true' });
  assert.deepEqual(sorted(names), sorted([...PUBLIC_TOOLS, ...ACCOUNT_TOOLS, ...TRADE_TOOLS]));
  assert.match(byName.bybit_place_order.inputSchema.properties.env.description, /Allowed by the connector settings: "mainnet"\./);
});

test('оба счёта и все переключатели — полный набор в детерминированном порядке', () => {
  const env = { ...MAINNET, ...DEMO, BYBIT_MAINNET_ALLOW_TRADING: 'true', BYBIT_MAINNET_ALLOW_FUNDS: 'true' };
  const first = toolsFor(env);
  assert.deepEqual(sorted(first.names), sorted(ALL_TOOL_NAMES));
  assert.deepEqual(toolsFor(env).names, first.names);
  assert.match(first.byName.bybit_funds.inputSchema.properties.env.description, /"mainnet", "demo"/);
});

test('инструменты коннектора: схемы и аннотации', () => {
  const env = { ...MAINNET, ...DEMO, BYBIT_MAINNET_ALLOW_TRADING: 'true', BYBIT_MAINNET_ALLOW_FUNDS: 'true' };
  const { names, byName } = toolsFor(env);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    const t = byName[name];
    assert.match(t.name, /^bybit_[a-z_]+$/);
    assert.ok(t.name.length <= 64);
    assert.ok(t.title, name);
    assert.equal(t.annotations.title, t.title, name);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, name);
    assert.ok(t.description.length > 20, name);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', name);
    for (const r of t.inputSchema.required ?? []) assert.ok(t.inputSchema.properties[r], `${name}: ${r}`);
  }
  for (const n of ['bybit_trade', 'bybit_funds', 'bybit_place_order', 'bybit_cancel_all_orders']) {
    assert.equal(byName[n].annotations.readOnlyHint, false, n);
    assert.equal(byName[n].annotations.destructiveHint, true, n);
    assert.ok(byName[n].inputSchema.required.includes('env'), `${n}: env обязателен`);
  }
  for (const n of [...PUBLIC_TOOLS, ...ACCOUNT_TOOLS]) {
    assert.equal(byName[n].annotations.readOnlyHint, true, n);
  }
  // Инструменты с произвольным путём ссылаются на документацию API.
  for (const n of ['bybit_read', 'bybit_trade', 'bybit_funds', 'bybit_search_endpoints']) {
    assert.match(byName[n].description, /https:\/\/bybit-exchange\.github\.io\/docs\/v5\/intro/, n);
  }
});

test('manifest.json согласован с кодом', () => {
  assert.equal(manifest.name, NAME);
  assert.equal(pkg.name, NAME);
  assert.equal(manifest.version, VERSION);
  assert.equal(pkg.version, VERSION);
  assert.deepEqual(manifest.tools.map((t) => t.name), ALL_TOOL_NAMES);
  // Каждое поле настроек передаётся серверу, и каждая переменная берётся из поля.
  const env = manifest.server.mcp_config.env;
  const referenced = Object.values(env).map((v) => v.match(/^\$\{user_config\.([a-z_]+)\}$/)?.[1]);
  assert.deepEqual(sorted(referenced), sorted(Object.keys(manifest.user_config)));
  // Названия полей в сообщениях сервера совпадают с тем, что видит пользователь.
  const titles = Object.values(manifest.user_config).map((f) => f.title);
  for (const title of Object.values(SETTING_TITLES)) assert.ok(titles.includes(title), title);
  for (const [key, field] of Object.entries(manifest.user_config)) {
    if (/api_(key|secret)$/.test(key)) assert.equal(field.sensitive, true, key);
    assert.notEqual(field.required, true, `${key}: без ключей коннектор должен работать`);
  }
  assert.equal(manifest.user_config.mainnet_allow_trading.default, false);
  assert.equal(manifest.user_config.mainnet_allow_funds.default, false);
});

test('инструкции не упоминают недоступные инструменты', () => {
  const { config } = createServer({ env: MAINNET });
  const text = buildInstructions(config);
  assert.doesNotMatch(text, /bybit_trade|bybit_funds|bybit_place_order/);
});
