import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { accessSummary, loadConfig, maskKey } from '../server/config.js';

test('значения по умолчанию: mainnet только чтение, demo — всё', () => {
  const c = loadConfig({});
  assert.equal(c.envs.mainnet.restUrl, 'https://api.bybit.com');
  assert.equal(c.envs.mainnet.publicStreamUrl, 'wss://stream.bybit.com');
  assert.equal(c.envs.demo.restUrl, 'https://api-demo.bybit.com');
  assert.equal(c.envs.demo.privateStreamUrl, 'wss://stream-demo.bybit.com');
  assert.equal(c.envs.demo.publicStreamUrl, 'wss://stream.bybit.com');
  assert.equal(c.envs.mainnet.allowTrade, false);
  assert.equal(c.envs.mainnet.allowFunds, false);
  assert.equal(c.envs.demo.allowTrade, true);
  assert.equal(c.envs.demo.allowFunds, true);
  assert.equal(c.defaultEnv, 'mainnet');
  assert.equal(c.recvWindow, 5000);
  assert.deepEqual(c.problems, []);
});

test('незаполненные поля Claude Desktop (${user_config.*}) считаются пустыми', () => {
  const c = loadConfig({
    BYBIT_MAINNET_API_KEY: '${user_config.mainnet_api_key}',
    BYBIT_MAINNET_API_SECRET: '${user_config.mainnet_api_secret}',
    BYBIT_MAINNET_ALLOW_TRADING: 'false',
    BYBIT_DEFAULT_ENV: 'auto',
    BYBIT_MAINNET_BASE_URL: '${user_config.mainnet_base_url}',
    BYBIT_REFERER: '${user_config.referer}',
    BYBIT_RECV_WINDOW: '5000',
  });
  assert.equal(c.envs.mainnet.hasKeys, false);
  assert.equal(c.envs.mainnet.restUrl, 'https://api.bybit.com');
  assert.equal(c.referer, '');
  assert.deepEqual(c.problems, []);
});

test('переключатели и контур по умолчанию', () => {
  const c = loadConfig({
    BYBIT_MAINNET_API_KEY: 'k',
    BYBIT_MAINNET_API_SECRET: 's',
    BYBIT_MAINNET_ALLOW_TRADING: 'true',
    BYBIT_MAINNET_ALLOW_FUNDS: '1',
    BYBIT_DEMO_API_KEY: 'dk',
    BYBIT_DEMO_API_SECRET: 'ds',
  });
  assert.equal(c.envs.mainnet.allowTrade, true);
  assert.equal(c.envs.mainnet.allowFunds, true);
  assert.equal(c.defaultEnv, 'demo');
  assert.equal(c.defaultEnvSource, 'auto');
  assert.equal(loadConfig({ BYBIT_DEFAULT_ENV: 'Demo' }).defaultEnv, 'demo');
  const bad = loadConfig({ BYBIT_DEFAULT_ENV: 'testnet', BYBIT_MAINNET_ALLOW_TRADING: 'maybe' });
  assert.equal(bad.defaultEnv, 'mainnet');
  assert.equal(bad.envs.mainnet.allowTrade, false);
  assert.equal(bad.problems.length, 2);
});

test('на демо-контуре торговля и операции со средствами разрешены всегда', () => {
  const c = loadConfig({ BYBIT_DEMO_ALLOW_TRADING: 'false', BYBIT_DEMO_ALLOW_FUNDS: 'false' });
  assert.equal(c.envs.demo.allowTrade, true);
  assert.equal(c.envs.demo.allowFunds, true);
});

test('региональный адрес и производный поток', () => {
  const eu = loadConfig({ BYBIT_MAINNET_BASE_URL: 'https://api.bybit.eu/' });
  assert.equal(eu.envs.mainnet.restUrl, 'https://api.bybit.eu');
  assert.equal(eu.envs.mainnet.publicStreamUrl, 'wss://stream.bybit.eu');
  assert.equal(eu.envs.demo.publicStreamUrl, 'wss://stream.bybit.eu');
  const custom = loadConfig({ BYBIT_MAINNET_BASE_URL: 'https://api.bytick.com', BYBIT_MAINNET_STREAM_URL: 'wss://stream.bybit.com' });
  assert.equal(custom.envs.mainnet.publicStreamUrl, 'wss://stream.bybit.com');
});

test('небезопасные и чужие адреса отклоняются, локальный http разрешён для тестов', () => {
  for (const url of [
    'http://api.bybit.com',
    'https://user:pass@api.bybit.com',
    'https://api.bybit.com/v5',
    'https://api.bybit.com?x=1',
    'nonsense',
    'https://api.bybit.com.evil.io',
    'https://api-demo.bybit.com',
    'https://api-testnet.bybit.com',
  ]) {
    const c = loadConfig({ BYBIT_MAINNET_BASE_URL: url });
    assert.equal(c.envs.mainnet.restUrl, 'https://api.bybit.com', url);
    assert.equal(c.problems.length, 1, url);
  }
  const local = loadConfig({ BYBIT_DEMO_BASE_URL: 'http://127.0.0.1:8080', BYBIT_DEMO_STREAM_URL: 'ws://localhost:8081' });
  assert.equal(local.envs.demo.restUrl, 'http://127.0.0.1:8080');
  assert.equal(local.envs.demo.privateStreamUrl, 'ws://localhost:8081');
});

test('секрет из файла и неполная пара ключей', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bybit-cfg-'));
  const file = join(dir, 'secret.pem');
  writeFileSync(file, 'file-secret\n');
  const c = loadConfig({ BYBIT_DEMO_API_KEY: 'dk', BYBIT_DEMO_API_SECRET_FILE: file });
  assert.equal(c.envs.demo.apiSecret, 'file-secret');
  assert.equal(c.envs.demo.hasKeys, true);
  const half = loadConfig({ BYBIT_MAINNET_API_KEY: 'k' });
  assert.equal(half.envs.mainnet.hasKeys, false);
  assert.match(half.problems[0], /задан только API Key/);
  const missing = loadConfig({ BYBIT_DEMO_API_KEY: 'dk', BYBIT_DEMO_API_SECRET_FILE: join(dir, 'nope') });
  assert.ok(missing.problems.some((p) => p.includes('не удалось прочитать файл')));
});

test('числовые настройки проверяются по диапазону', () => {
  const c = loadConfig({ BYBIT_RECV_WINDOW: '100', BYBIT_TIMEOUT_MS: '30000', BYBIT_MAX_OUTPUT_CHARS: 'abc' });
  assert.equal(c.recvWindow, 5000);
  assert.equal(c.timeoutMs, 30000);
  assert.equal(c.maxOutputChars, 60000);
  assert.equal(c.problems.length, 2);
});

test('маскирование ключа', () => {
  assert.equal(maskKey(''), null);
  assert.equal(maskKey('abc'), '***');
  assert.equal(maskKey('ABCDEFGHIJ'), 'ABCD…IJ');
});

test('демо-контур нельзя направить на боевой домен', () => {
  const c = loadConfig({ BYBIT_DEMO_BASE_URL: 'https://api.bybit.com', BYBIT_DEMO_STREAM_URL: 'wss://stream.bybit.com' });
  assert.equal(c.envs.demo.restUrl, 'https://api-demo.bybit.com');
  assert.equal(c.envs.demo.privateStreamUrl, 'wss://stream-demo.bybit.com');
  assert.equal(c.problems.length, 2);
  const stream = loadConfig({ BYBIT_MAINNET_STREAM_URL: 'wss://evil.example' });
  assert.equal(stream.envs.mainnet.publicStreamUrl, 'wss://stream.bybit.com');
});

test('в сообщениях о неверных настройках нет самих значений', () => {
  const secret = 'sk-live-0123456789abcdef';
  const c = loadConfig({
    BYBIT_MAINNET_BASE_URL: secret,
    BYBIT_MAINNET_ALLOW_TRADING: secret,
    BYBIT_DEFAULT_ENV: secret,
    BYBIT_RECV_WINDOW: secret,
  });
  assert.equal(c.problems.length, 4);
  assert.ok(c.problems.every((p) => !p.includes(secret)));
});

test('счёт по умолчанию можно назвать по-русски; без ключа выбранного счёта — предупреждение', () => {
  assert.equal(loadConfig({ BYBIT_DEFAULT_ENV: 'реальный' }).defaultEnv, 'mainnet');
  assert.equal(loadConfig({ BYBIT_DEFAULT_ENV: 'Демо' }).defaultEnv, 'demo');
  const auto = loadConfig({ BYBIT_DEFAULT_ENV: 'авто', BYBIT_DEMO_API_KEY: 'dk', BYBIT_DEMO_API_SECRET: 'ds' });
  assert.equal(auto.defaultEnv, 'demo');
  assert.equal(auto.defaultEnvSource, 'auto');
  // Выбран реальный счёт, но ключ есть только у демо-счёта.
  const mismatch = loadConfig({ BYBIT_DEFAULT_ENV: 'mainnet', BYBIT_DEMO_API_KEY: 'dk', BYBIT_DEMO_API_SECRET: 'ds' });
  assert.equal(mismatch.defaultEnv, 'mainnet');
  assert.equal(mismatch.problems.length, 1);
  assert.match(mismatch.problems[0], /«Счёт по умолчанию» = mainnet, но ключа этого счёта нет/);
  // Без ключей вовсе это не ошибка: открытые данные доступны с любого счёта.
  assert.deepEqual(loadConfig({ BYBIT_DEFAULT_ENV: 'demo' }).problems, []);
});

test('сводка доступа по счетам', () => {
  assert.deepEqual(accessSummary(loadConfig({})), { accounts: [], trade: [], funds: [] });
  const mainOnly = loadConfig({ BYBIT_MAINNET_API_KEY: 'k', BYBIT_MAINNET_API_SECRET: 's', BYBIT_MAINNET_ALLOW_TRADING: 'true' });
  assert.deepEqual(accessSummary(mainOnly), { accounts: ['mainnet'], trade: ['mainnet'], funds: [] });
  const both = loadConfig({ BYBIT_MAINNET_API_KEY: 'k', BYBIT_MAINNET_API_SECRET: 's', BYBIT_DEMO_API_KEY: 'dk', BYBIT_DEMO_API_SECRET: 'ds' });
  assert.deepEqual(accessSummary(both), { accounts: ['mainnet', 'demo'], trade: ['demo'], funds: ['demo'] });
  // Неполная пара ключей счёт не подключает.
  assert.deepEqual(accessSummary(loadConfig({ BYBIT_DEMO_API_KEY: 'dk' })).accounts, []);
});

test('битый RSA-ключ: счёт не считается подключённым, проблема названа без самого ключа', () => {
  const c = loadConfig({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: '-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----' });
  assert.equal(c.envs.demo.hasKeys, false);
  assert.match(c.envs.demo.keyError, /не удалось прочитать закрытый RSA-ключ/);
  assert.equal(c.problems.length, 1);
  assert.match(c.problems[0], /^demo: не удалось прочитать закрытый RSA-ключ/);
  assert.doesNotMatch(c.problems[0], /AAAA/);
  assert.deepEqual(accessSummary(c).accounts, []);
});
