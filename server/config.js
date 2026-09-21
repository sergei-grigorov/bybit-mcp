// Настройки коннектора. Источник — переменные окружения: Claude Desktop заполняет их
// из настроек расширения (manifest.json → user_config), при ручном подключении их
// задают в claude_desktop_config.json. Незаполненное необязательное поле Claude
// Desktop передаёт буквальной строкой «${user_config.…}» — такое значение считаем пустым.

import { readFileSync } from 'node:fs';

import { TOOL } from './names.js';
import { createSigner } from './signer.js';
import { TITLE } from './version.js';

export const ENV_NAMES = ['mainnet', 'demo'];

const DEFAULTS = {
  mainnet: { rest: 'https://api.bybit.com', stream: 'wss://stream.bybit.com' },
  demo: { rest: 'https://api-demo.bybit.com', stream: 'wss://stream-demo.bybit.com' },
};

// Ключи и подписи уходят только на домены Bybit (основной, bytick и региональные
// из docs/v5/guide). Demo Trading — только свой домен: иначе «на демо разрешено всё»
// можно было бы направить на боевой счёт.
const MAINNET_API_HOSTS = [
  'api.bybit.com',
  'api.bytick.com',
  'api.bybit.nl',
  'api.bybit.tr',
  'api.bybit.kz',
  'api.bybitgeorgia.ge',
  'api.bybit.ae',
  'api.bybit.eu',
  'api.bybit.id',
  'api.manepa.jp',
  'api.spark-fintech.com',
];
const ALLOWED_HOSTS = {
  mainnet: {
    rest: MAINNET_API_HOSTS,
    stream: MAINNET_API_HOSTS.map((h) => h.replace(/^api\./, 'stream.')),
  },
  demo: { rest: ['api-demo.bybit.com'], stream: ['stream-demo.bybit.com'] },
};

// Где пользователь меняет настройки и как называются поля — так, как он их видит
// в Claude Desktop (manifest.json → user_config). При ручном подключении те же
// настройки задаются переменными окружения, поэтому подсказки называют и их.
export const SETTINGS_PATH = `Claude Desktop → Settings → Extensions → ${TITLE}`;
export const SETTING_TITLES = {
  mainnetKey: 'Реальный счёт: API Key',
  mainnetSecret: 'Реальный счёт: API Secret',
  trade: 'Реальный счёт: разрешить торговлю',
  funds: 'Реальный счёт: разрешить операции со средствами',
  demoKey: 'Демо-счёт: API Key',
  demoSecret: 'Демо-счёт: API Secret',
  defaultEnv: 'Счёт по умолчанию',
};
export const SETTING_ENV_VARS = {
  mainnetKey: 'BYBIT_MAINNET_API_KEY',
  mainnetSecret: 'BYBIT_MAINNET_API_SECRET',
  trade: 'BYBIT_MAINNET_ALLOW_TRADING',
  funds: 'BYBIT_MAINNET_ALLOW_FUNDS',
  demoKey: 'BYBIT_DEMO_API_KEY',
  demoSecret: 'BYBIT_DEMO_API_SECRET',
  defaultEnv: 'BYBIT_DEFAULT_ENV',
};

// Поле настроек в тексте для модели: «"Реальный счёт: разрешить торговлю" (BYBIT_MAINNET_ALLOW_TRADING)».
export function settingRef(key) {
  return `"${SETTING_TITLES[key]}" (${SETTING_ENV_VARS[key]})`;
}

// Как счёт можно назвать в поле «Счёт по умолчанию».
const ENV_ALIASES = {
  auto: ['auto', 'авто'],
  mainnet: ['mainnet', 'real', 'live', 'реальный', 'основной'],
  demo: ['demo', 'демо'],
};

function readVar(env, name) {
  const value = env[name];
  if (value == null) return '';
  const s = String(value).trim();
  if (s === '' || /^\$\{[^}]*\}$/.test(s)) return '';
  return s;
}

function readBool(env, name, fallback, problems) {
  const s = readVar(env, name).toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'on', 'да'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'нет'].includes(s)) return false;
  // Само значение не выводим: в поле мог по ошибке попасть секрет.
  problems.push(`${name}: ожидается true или false; использую ${fallback}`);
  return fallback;
}

function readInt(env, name, fallback, min, max, problems) {
  const s = readVar(env, name);
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) {
    problems.push(`${name}: ожидается число от ${min} до ${max}; использую ${fallback}`);
    return fallback;
  }
  return Math.round(n);
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// Базовый адрес: https/wss на домене из списка (http/ws — лишь для локальных
// тестовых серверов), без пути, запроса и учётных данных.
function readBaseUrl(env, name, fallback, { protocol, hosts }, problems) {
  const s = readVar(env, name);
  if (!s) return fallback;
  let url;
  try {
    url = new URL(s);
  } catch {
    problems.push(`${name}: значение не похоже на адрес; использую ${fallback}`);
    return fallback;
  }
  const local = isLocalHost(url.hostname);
  const insecure = protocol === 'https:' ? 'http:' : 'ws:';
  const protocolOk = url.protocol === protocol || (local && url.protocol === insecure);
  const shapeOk = !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '');
  if (!protocolOk || !shapeOk) {
    problems.push(`${name}: нужен адрес вида ${protocol}//host без пути; использую ${fallback}`);
    return fallback;
  }
  if (!local && !hosts.includes(url.hostname)) {
    problems.push(`${name}: ${url.hostname} не входит в список доменов Bybit (${hosts.join(', ')}); использую ${fallback}`);
    return fallback;
  }
  return url.origin;
}

// Поток mainnet выводится из REST-адреса: api.bybit.eu → stream.bybit.eu.
function deriveStream(restUrl) {
  const url = new URL(restUrl);
  if (isLocalHost(url.hostname)) return `ws://${url.host}`;
  if (url.hostname.startsWith('api.')) return `wss://stream.${url.hostname.slice(4)}`;
  return DEFAULTS.mainnet.stream;
}

function readSecret(env, prefix, problems) {
  const direct = readVar(env, `${prefix}_API_SECRET`);
  if (direct) return direct;
  const file = readVar(env, `${prefix}_API_SECRET_FILE`);
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    problems.push(`${prefix}_API_SECRET_FILE: не удалось прочитать файл (${err.code ?? err.message})`);
    return '';
  }
}

function readDefaultEnv(env, problems) {
  const s = readVar(env, 'BYBIT_DEFAULT_ENV').toLowerCase();
  if (!s) return 'auto';
  const found = Object.keys(ENV_ALIASES).find((name) => ENV_ALIASES[name].includes(s));
  if (found) return found;
  problems.push(`BYBIT_DEFAULT_ENV («${SETTING_TITLES.defaultEnv}»): ожидается auto, mainnet или demo; использую auto`);
  return 'auto';
}

export function loadConfig(env = process.env) {
  const problems = [];
  const envs = {};
  for (const name of ENV_NAMES) {
    const prefix = `BYBIT_${name.toUpperCase()}`;
    const apiKey = readVar(env, `${prefix}_API_KEY`);
    const apiSecret = readSecret(env, prefix, problems);
    if (Boolean(apiKey) !== Boolean(apiSecret)) {
      problems.push(`${name}: задан только ${apiKey ? 'API Key' : 'API Secret'} — данные счёта недоступны`);
    }
    // Секретом подписать нельзя (например, битый PEM) — счёт не считается подключённым.
    let keyError = null;
    if (apiKey && apiSecret) {
      try {
        createSigner(apiSecret);
      } catch (err) {
        keyError = `не удалось прочитать закрытый RSA-ключ: ${err.message}`;
        problems.push(`${name}: ${keyError}`);
      }
    }
    const hosts = ALLOWED_HOSTS[name];
    const restUrl = readBaseUrl(env, `${prefix}_BASE_URL`, DEFAULTS[name].rest, { protocol: 'https:', hosts: hosts.rest }, problems);
    const derived = name === 'mainnet' ? deriveStream(restUrl) : DEFAULTS.demo.stream;
    const streamUrl = readBaseUrl(env, `${prefix}_STREAM_URL`, derived, { protocol: 'wss:', hosts: hosts.stream }, problems);
    const isDemo = name === 'demo';
    envs[name] = {
      name,
      restUrl,
      // Публичные потоки демо-контура совпадают с mainnet, приватные — свои.
      privateStreamUrl: streamUrl,
      publicStreamUrl: isDemo ? null : streamUrl,
      apiKey,
      apiSecret,
      keyError,
      hasKeys: Boolean(apiKey && apiSecret && !keyError),
      // На демо-счёте разрешено всё; на mainnet — только то, что включил пользователь.
      allowTrade: isDemo ? true : readBool(env, `${prefix}_ALLOW_TRADING`, false, problems),
      allowFunds: isDemo ? true : readBool(env, `${prefix}_ALLOW_FUNDS`, false, problems),
    };
  }
  envs.demo.publicStreamUrl = envs.mainnet.publicStreamUrl;

  const requested = readDefaultEnv(env, problems);
  const defaultEnvSource = requested === 'auto' ? 'auto' : 'setting';
  const defaultEnv = requested === 'auto' ? (envs.demo.hasKeys ? 'demo' : 'mainnet') : requested;
  if (defaultEnvSource === 'setting' && !envs[defaultEnv].hasKeys && ENV_NAMES.some((n) => envs[n].hasKeys)) {
    problems.push(
      `«${SETTING_TITLES.defaultEnv}» = ${defaultEnv}, но ключа этого счёта нет: данные счёта без явного env не прочитать`,
    );
  }

  return {
    envs,
    defaultEnv,
    defaultEnvSource,
    recvWindow: readInt(env, 'BYBIT_RECV_WINDOW', 5000, 1000, 60000, problems),
    timeoutMs: readInt(env, 'BYBIT_TIMEOUT_MS', 15000, 1000, 120000, problems),
    maxOutputChars: readInt(env, 'BYBIT_MAX_OUTPUT_CHARS', 60000, 5000, 1000000, problems),
    referer: readVar(env, 'BYBIT_REFERER'),
    docsBaseUrl:
      readVar(env, 'BYBIT_DOCS_BASE_URL') || 'https://raw.githubusercontent.com/bybit-exchange/docs/master/',
    problems,
  };
}

// Что доступно при текущих настройках: счета с ключами и счета, где разрешены
// торговля и операции со средствами. От этого зависит и набор инструментов.
export function accessSummary(config) {
  const pick = (test) => ENV_NAMES.filter((name) => test(config.envs[name]));
  return {
    accounts: pick((e) => e.hasKeys),
    trade: pick((e) => e.hasKeys && e.allowTrade),
    funds: pick((e) => e.hasKeys && e.allowFunds),
  };
}

// Почему у счёта нет рабочего ключа — для текстов модели.
export function keyProblem(envConfig) {
  return envConfig.keyError ? `the API secret could not be read (see ${TOOL.status})` : 'no API key';
}

// Почему уровень trade или funds недоступен ни на одном счёте — с названием нужного
// поля настроек: «mainnet: switch "…" is off; demo: no API key».
export function accessBlockers(config, level) {
  return ENV_NAMES.map((name) => {
    const e = config.envs[name];
    if (!e.hasKeys) return `${name}: ${keyProblem(e)}`;
    if (level === 'trade' && !e.allowTrade) return `${name}: switch ${settingRef('trade')} is off`;
    if (level === 'funds' && !e.allowFunds) return `${name}: switch ${settingRef('funds')} is off`;
    return null;
  })
    .filter(Boolean)
    .join('; ');
}

// Ключ в выводе — только первые символы.
export function maskKey(key) {
  if (!key) return null;
  return key.length <= 6 ? '***' : `${key.slice(0, 4)}…${key.slice(-2)}`;
}
