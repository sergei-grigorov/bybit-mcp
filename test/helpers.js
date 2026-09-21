// Общие заготовки тестов: поддельный fetch, исполнитель с тестовыми настройками.

import { Catalog } from '../server/catalog.js';
import { loadConfig } from '../server/config.js';
import { Executor } from '../server/executor.js';

export const silentLogger = { info() {}, warn() {}, error() {} };

export const catalog = Catalog.load();

// handler(call) → { status?, json?, text?, headers? } | Error (бросается как сетевой сбой)
export function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = {
      url,
      origin: u.origin,
      path: u.pathname,
      rawQuery: url.includes('?') ? url.slice(url.indexOf('?') + 1) : '',
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body,
      redirect: init.redirect,
    };
    calls.push(call);
    if (call.path === '/v5/market/time' && !handler.handlesTime) {
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { timeNano: `${Date.now()}000000` }, time: Date.now() }), {
        status: 200,
      });
    }
    const out = await handler(call, calls);
    if (out instanceof Error) throw out;
    const body = out.text ?? JSON.stringify(out.json ?? { retCode: 0, retMsg: 'OK', result: {}, retExtInfo: {}, time: Date.now() });
    return new Response(body, { status: out.status ?? 200, headers: out.headers ?? {} });
  };
  return { fetchImpl, calls };
}

export const TEST_KEYS = {
  BYBIT_MAINNET_API_KEY: 'MAINKEY123',
  BYBIT_MAINNET_API_SECRET: 'main-secret',
  BYBIT_DEMO_API_KEY: 'DEMOKEY456',
  BYBIT_DEMO_API_SECRET: 'demo-secret',
};

export function makeExecutor({ env = {}, handler = () => ({}) } = {}) {
  const config = loadConfig(env);
  const { fetchImpl, calls } = mockFetch(handler);
  const executor = new Executor({ config, catalog, logger: silentLogger, fetchImpl });
  return { executor, calls, config };
}

export const apiCalls = (calls) => calls.filter((c) => c.path !== '/v5/market/time');
