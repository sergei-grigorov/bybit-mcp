import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from '../server/index.js';
import {
  LEGACY_PROTOCOL_VERSIONS,
  McpServer,
  META,
  MODERN_PROTOCOL_VERSIONS,
  normalizeArgs,
  requestEra,
  UNSUPPORTED_PROTOCOL_VERSION,
  validateArgs,
} from '../server/mcp.js';
import { silentLogger, TEST_KEYS } from './helpers.js';

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));
const INFO = { name: 'toy', version: '0' };

function toyServer(tools) {
  return new McpServer({ info: INFO, instructions: 'x', tools, logger: silentLogger });
}

// _meta современного запроса (протокол 2026-07-28).
function modernMeta(version = MODERN_PROTOCOL_VERSIONS[0]) {
  return {
    [META.protocolVersion]: version,
    [META.clientInfo]: { name: 'test-client', version: '1' },
    [META.clientCapabilities]: {},
  };
}

test('прежняя эпоха: согласование версии в initialize', async () => {
  const s = toyServer([]);
  for (const v of LEGACY_PROTOCOL_VERSIONS) {
    const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } });
    assert.equal(r.result.protocolVersion, v);
  }
  // Современная версия через initialize не выбирается: у неё нет рукопожатия.
  for (const v of ['2099-01-01', MODERN_PROTOCOL_VERSIONS[0]]) {
    const r = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: v } });
    assert.equal(r.result.protocolVersion, LEGACY_PROTOCOL_VERSIONS[0]);
  }
  const r = await s.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.instructions, 'x');
  assert.deepEqual(r.result.serverInfo, INFO);
  assert.equal(r.result.resultType, undefined, 'в прежней эпохе результат без resultType');
});

test('определение эпохи запроса', () => {
  assert.equal(requestEra('initialize', { _meta: modernMeta() }), 'legacy');
  assert.equal(requestEra('tools/list', { _meta: modernMeta() }), 'modern');
  assert.equal(requestEra('tools/list', {}), 'legacy');
  assert.equal(requestEra('tools/list', undefined), 'legacy');
  assert.equal(requestEra('server/discover', {}), 'modern');
});

test('современная эпоха: server/discover', async () => {
  const s = toyServer([]);
  const r = await s.handle({ jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: modernMeta() } });
  assert.deepEqual(r, {
    jsonrpc: '2.0',
    id: 'd1',
    result: {
      resultType: 'complete',
      supportedVersions: MODERN_PROTOCOL_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      instructions: 'x',
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { [META.serverInfo]: INFO },
    },
  });
});

test('современная эпоха: список и вызов инструментов', async () => {
  const s = toyServer([{ name: 'ok', title: 'OK', description: 'test tool', inputSchema: { type: 'object' }, handler: async () => 'done' }]);
  const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } });
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.ttlMs, 0);
  assert.equal(list.result.cacheScope, 'private');
  assert.deepEqual(list.result._meta, { [META.serverInfo]: INFO });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['ok']);
  const call = await s.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'ok', arguments: {}, _meta: modernMeta() },
  });
  assert.deepEqual(call.result, {
    resultType: 'complete',
    content: [{ type: 'text', text: 'done' }],
    isError: false,
    _meta: { [META.serverInfo]: INFO },
  });
  // Пустые списки ресурсов и подсказок — тоже с полями кеша.
  const prompts = await s.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: { _meta: modernMeta() } });
  assert.deepEqual(prompts.result.prompts, []);
  assert.equal(prompts.result.cacheScope, 'private');
});

test('современная эпоха: ошибки конверта _meta', async () => {
  const s = toyServer([]);
  const unsupported = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta('2099-01-01') } });
  assert.deepEqual(unsupported.error, {
    code: UNSUPPORTED_PROTOCOL_VERSION,
    message: 'Unsupported protocol version',
    data: { supported: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS], requested: '2099-01-01' },
  });
  const noCaps = await s.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: { _meta: { [META.protocolVersion]: MODERN_PROTOCOL_VERSIONS[0] } },
  });
  assert.equal(noCaps.error.code, -32602);
  assert.match(noCaps.error.message, /clientCapabilities/);
  const bareDiscover = await s.handle({ jsonrpc: '2.0', id: 3, method: 'server/discover' });
  assert.equal(bareDiscover.error.code, -32602);
  assert.match(bareDiscover.error.message, /protocolVersion/);
  const unknown = await s.handle({ jsonrpc: '2.0', id: 4, method: 'nope', params: { _meta: modernMeta() } });
  assert.equal(unknown.error.code, -32601);
});

test('клиент обеих эпох: проба server/discover удаётся, прежний клиент работает через initialize', async () => {
  const s = toyServer([{ name: 'ok', inputSchema: { type: 'object' }, handler: async () => 'done' }]);
  // Прежний клиент: initialize → initialized → tools/list без _meta.
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const legacyList = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(Object.keys(legacyList.result), ['tools']);
  // Современный запрос на том же процессе обслуживается без состояния.
  const modernList = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: modernMeta() } });
  assert.equal(modernList.result.resultType, 'complete');
});

test('прежняя версия в _meta обслуживается по прежним правилам', async () => {
  const s = toyServer([{ name: 'ok', inputSchema: { type: 'object' }, handler: async () => 'done' }]);
  const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta('2025-11-25') } });
  assert.deepEqual(Object.keys(list.result), ['tools']);
  // server/discover прежним версиям неизвестен: клиент поймёт, что нужен initialize.
  const discover = await s.handle({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: modernMeta('2025-06-18') } });
  assert.equal(discover.error.code, -32601);
});

test('подписка subscriptions/listen: подтверждение и отмена клиентом', async () => {
  const s = toyServer([]);
  const sent = [];
  s.emit = (m) => sent.push(m);
  const pending = s.handle({
    jsonrpc: '2.0',
    id: 'sub1',
    method: 'subscriptions/listen',
    params: { _meta: modernMeta(), notifications: { toolsListChanged: true } },
  });
  await new Promise((r) => setImmediate(r));
  // Список инструментов не меняется — подписка подтверждается с пустым набором.
  assert.deepEqual(sent, [
    { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: { [META.subscriptionId]: 'sub1' }, notifications: {} } },
  ]);
  const dup = await s.handle({ jsonrpc: '2.0', id: 'sub1', method: 'tools/call', params: { name: 'x', arguments: {} } });
  assert.equal(dup, null, 'повторный id при открытой подписке игнорируется');
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'sub1' } }), null);
  assert.equal(await pending, null, 'отменённая подписка ответа не получает');
  const legacy = await s.handle({ jsonrpc: '2.0', id: 3, method: 'subscriptions/listen', params: {} });
  assert.equal(legacy.error.code, -32601);
});

test('подписка закрывается штатно при завершении сервера', async () => {
  const s = toyServer([]);
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => (out += d));
  const closed = new Promise((resolve) => s.start({ input, output, onClose: resolve }));
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'subscriptions/listen', params: { _meta: modernMeta(), notifications: {} } })}\n`);
  await new Promise((r) => setTimeout(r, 20));
  input.end();
  await closed;
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].method, 'notifications/subscriptions/acknowledged');
  assert.deepEqual(lines[1], {
    jsonrpc: '2.0',
    id: 7,
    result: { resultType: 'complete', _meta: { [META.subscriptionId]: 7, [META.serverInfo]: INFO } },
  });
  assert.deepEqual(lines[2], { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'Server shutting down' } });
});

test('обработчик, закончивший работу после отмены, ответа не отправляет', async () => {
  let finish;
  const s = toyServer([{ name: 'stubborn', inputSchema: { type: 'object' }, handler: () => new Promise((r) => (finish = r)) }]);
  const pending = s.handle({ jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'stubborn', arguments: {} } });
  await new Promise((r) => setImmediate(r));
  await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'x' } });
  finish('done anyway');
  assert.equal(await pending, null);
});

test('служебные методы и ошибки JSON-RPC', async () => {
  const s = toyServer([]);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/whatever' }), null);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 2, method: 'nope' })).error.code, -32601);
  assert.equal((await s.handle({ jsonrpc: '1.0', id: 3, method: 'ping' })).error.code, -32600);
  assert.equal((await s.handleLine('{oops')).error.code, -32700);
  assert.equal(await s.handle({ jsonrpc: '2.0', id: 9, result: {} }), null);
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 4, method: 'prompts/list' })).result, { prompts: [] });
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).result, { resources: [] });
  const batch = await s.handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]));
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 6, result: {} }]);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'missing' } })).error.code, -32602);
  // Запрос без id — уведомление: не выполняется и ответа не получает.
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'tools/list' }), null);
});

test('аргументы: приведение и проверка по схеме', async () => {
  const schema = {
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 5 },
      b: { type: 'boolean' },
      e: { type: 'string', enum: ['a', 'b'] },
      o: { type: 'object' },
      list: { type: 'array', items: { type: 'string' }, minItems: 1 },
      sn: { type: ['string', 'number'] },
    },
    required: ['e'],
    additionalProperties: false,
  };
  assert.deepEqual(normalizeArgs(schema, { n: '3', b: 'TRUE', e: 'a', o: '{"x":1}', sn: '5', z: null }), {
    n: 3,
    b: true,
    e: 'a',
    o: { x: 1 },
    sn: '5',
  });
  const problems = validateArgs(schema, { n: 9, e: 'c', list: [], extra: 1, sn: true });
  assert.deepEqual(problems, [
    'arguments.n: must be ≤ 5',
    'arguments.e: must be one of "a", "b"',
    'arguments.list: needs at least 1 item(s)',
    'arguments.extra: unknown argument',
    'arguments.sn: expected string or number, got boolean',
  ]);
  assert.deepEqual(validateArgs(schema, { b: false }), ['arguments.e: required']);
});

test('вызов инструмента: текст, ошибки, исключения', async () => {
  const s = toyServer([
    { name: 'ok', inputSchema: { type: 'object', properties: {} }, handler: async () => 'done' },
    { name: 'soft', inputSchema: { type: 'object' }, handler: async () => ({ text: 'bad', isError: true }) },
    {
      name: 'tool-error',
      inputSchema: { type: 'object' },
      handler: async () => {
        throw Object.assign(new Error('explain to model'), { name: 'ToolError' });
      },
    },
    {
      name: 'crash',
      inputSchema: { type: 'object' },
      handler: async () => {
        throw new TypeError('boom');
      },
    },
    {
      name: 'strict',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
      handler: async () => 'never',
    },
  ]);
  const call = async (name, args = {}) => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  assert.deepEqual(await call('ok'), { content: [{ type: 'text', text: 'done' }], isError: false });
  assert.equal((await call('soft')).isError, true);
  assert.deepEqual(await call('tool-error'), { content: [{ type: 'text', text: 'explain to model' }], isError: true });
  assert.deepEqual(await call('crash'), { content: [{ type: 'text', text: 'Internal error: boom' }], isError: true });
  const strict = await call('strict', { b: 1 });
  assert.equal(strict.isError, true);
  assert.match(strict.content[0].text, /arguments\.a: required/);
});

test('отменённый вызов не получает ответа (обе эпохи)', async () => {
  for (const meta of [undefined, modernMeta()]) {
    let aborted = false;
    const s = toyServer([
      {
        name: 'slow',
        inputSchema: { type: 'object' },
        handler: (args, { signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
      },
    ]);
    const params = { name: 'slow', arguments: {}, ...(meta ? { _meta: meta } : {}) };
    const pending = s.handle({ jsonrpc: '2.0', id: 'r1', method: 'tools/call', params });
    await new Promise((r) => setImmediate(r));
    assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'r1' } }), null);
    assert.equal(await pending, null);
    assert.ok(aborted);
  }
});

test('транспорт stdio: ответы дописываются после закрытия входа', async () => {
  const s = toyServer([
    { name: 'wait', inputSchema: { type: 'object' }, handler: () => new Promise((r) => setTimeout(() => r('late'), 50)) },
  ]);
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => (out += d));
  const closed = new Promise((resolve) => s.start({ input, output, onClose: resolve }));
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } })}\n`);
  await closed;
  assert.equal(JSON.parse(out.trim()).result.content[0].text, 'late');
});

test('короткие инструменты собирают параметры и путь', async () => {
  const seen = [];
  const { server, executor } = createServer({ env: { BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' } });
  executor.call = async (req) => {
    seen.push(req);
    return { text: '{}', isError: false };
  };
  const call = (name, args) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  await call('bybit_get_kline', { symbol: 'BTCUSDT', interval: '60', price_type: 'premium', env: 'demo' });
  assert.deepEqual(seen[0], { tool: 'read', path: '/v5/market/premium-index-price-kline', params: { symbol: 'BTCUSDT', interval: '60' }, env: 'demo', signal: seen[0].signal });
  await call('bybit_get_wallet_balance', {});
  assert.deepEqual(seen[1].params, { accountType: 'UNIFIED' });
  await call('bybit_place_order', {
    env: 'demo',
    category: 'linear',
    symbol: 'BTCUSDT',
    side: 'Sell',
    orderType: 'Market',
    qty: 1,
    extra: { slippageToleranceType: 'Percent', symbol: 'IGNORED' },
  });
  assert.equal(seen[2].tool, 'trade');
  assert.equal(seen[2].path, '/v5/order/create');
  assert.deepEqual(seen[2].params, { slippageToleranceType: 'Percent', symbol: 'BTCUSDT', category: 'linear', side: 'Sell', orderType: 'Market', qty: 1 });
  await call('bybit_get_open_interest', { category: 'linear', symbol: 'BTCUSDT', intervalTime: '1h', limit: 24 });
  assert.deepEqual(seen[3], {
    tool: 'read',
    path: '/v5/market/open-interest',
    params: { category: 'linear', symbol: 'BTCUSDT', intervalTime: '1h', limit: 24 },
    env: undefined,
    signal: seen[3].signal,
  });
  const noEnv = await call('bybit_cancel_order', { category: 'linear', symbol: 'BTCUSDT', orderId: '1' });
  assert.match(noEnv.result.content[0].text, /arguments\.env: required/);
});

// Настоящий процесс: всё, что пишется в stdout, — сообщения JSON-RPC.
async function runProcess(messages, env = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  return { code, byId: Object.fromEntries(lines.map((l) => [l.id, l])), lines, stderr };
}

test('настоящий процесс, прежняя эпоха: stdout содержит только JSON-RPC', async () => {
  const { code, byId, lines, stderr } = await runProcess([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bybit_describe_endpoint', arguments: { endpoint: 'POST /v5/order/create' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bybit_trade', arguments: { env: 'mainnet', path: '/v5/order/cancel-all', params: { category: 'linear' } } } },
  ], { BYBIT_MAINNET_API_KEY: 'k', BYBIT_MAINNET_API_SECRET: 's', BYBIT_DEMO_API_KEY: 'k2', BYBIT_DEMO_API_SECRET: 's2' });
  assert.equal(code, 0);
  assert.deepEqual(lines.map((l) => l.id).sort(), [1, 2, 3, 4]);
  assert.equal(byId[1].result.serverInfo.name, 'bybit-mcp');
  assert.ok(byId[2].result.tools.length >= 20);
  assert.match(byId[3].result.content[0].text, /tool: bybit_trade/);
  assert.equal(byId[4].result.isError, true);
  assert.match(byId[4].result.content[0].text, /Trading on mainnet is disabled/);
  assert.match(stderr, /\[bybit-mcp\]/);
});

test('настоящий процесс, современная эпоха: проба, список и вызов без рукопожатия', async () => {
  const meta = modernMeta();
  const { code, byId, stderr } = await runProcess([
    { jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bybit_search_endpoints', arguments: { query: 'funding rate history', public_only: true }, _meta: meta } },
  ]);
  assert.equal(code, 0);
  const discover = byId['discover-1'].result;
  assert.deepEqual(discover.supportedVersions, MODERN_PROTOCOL_VERSIONS);
  assert.equal(discover._meta[META.serverInfo].name, 'bybit-mcp');
  assert.match(discover.instructions, /No account is connected/);
  const tools = byId[2].result.tools.map((t) => t.name);
  assert.ok(tools.includes('bybit_get_tickers'));
  assert.ok(!tools.includes('bybit_trade'), 'без ключей торговых инструментов нет');
  assert.equal(byId[3].result.resultType, 'complete');
  assert.match(byId[3].result.content[0].text, /GET \/v5\/market\/funding\/history/);
  assert.match(stderr, /server\/discover: test-client 1, protocol 2026-07-28/);
});

test('ключ __proto__ в аргументах отклоняется на любой глубине', async () => {
  const seen = [];
  const s = toyServer([
    {
      name: 'guarded',
      inputSchema: { type: 'object', properties: { env: { type: 'string' }, params: { type: 'object' } }, required: ['env'], additionalProperties: false },
      handler: async (args) => {
        seen.push(args);
        return 'ran';
      },
    },
  ]);
  const call = async (argsJson) =>
    (await s.handleLine(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"guarded","arguments":${argsJson}}}`)).result;
  const top = await call('{"__proto__":{"env":"mainnet"}}');
  assert.equal(top.isError, true);
  assert.match(top.content[0].text, /arguments\.__proto__ is not allowed/);
  const nested = await call('{"env":"demo","params":{"a":{"constructor":{"x":1}}}}');
  assert.match(nested.content[0].text, /arguments\.params\.a\.constructor is not allowed/);
  assert.equal(seen.length, 0);
  const ok = await call('{"env":"demo","params":{"proto":1}}');
  assert.equal(ok.content[0].text, 'ran');
});

test('tools/call без id не выполняется; повторный id игнорируется', async () => {
  let runs = 0;
  let release;
  const s = toyServer([
    {
      name: 'hold',
      inputSchema: { type: 'object' },
      handler: () => {
        runs++;
        return new Promise((r) => (release = () => r('done')));
      },
    },
  ]);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'hold', arguments: {} } }), null);
  assert.equal(runs, 0);
  const first = s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hold', arguments: {} } });
  await new Promise((r) => setImmediate(r));
  const dup = await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hold', arguments: {} } });
  assert.equal(dup, null, 'ответ с тем же id клиент принял бы за ответ на первый вызов');
  release();
  assert.equal((await first).result.content[0].text, 'done');
  assert.equal(runs, 1);
});

test('ключи из настроек не попадают в инструкции и описания инструментов', () => {
  const { server } = createServer({ env: TEST_KEYS });
  const text = JSON.stringify({ tools: server.listTools(), instructions: server.instructions });
  for (const value of Object.values(TEST_KEYS)) assert.ok(!text.includes(value), value);
});
