// Настройки коннектора на сервере. В Claude Desktop их хранит сам Claude (поля
// user_config из manifest.json), а на сервере — файл settings.json в папке данных.
// Поля, типы, названия и значения по умолчанию берутся из того же manifest.json,
// поэтому страница настроек и Claude Desktop показывают одно и то же. Значения
// превращаются в переменные окружения по mcp_config.env манифеста — дальше
// коннектор читает их как обычно (config.js).
//
// Файл даёт полный доступ к счетам: права 0600, папка 0700.

import fs from 'node:fs';
import path from 'node:path';

const FILE_VERSION = 1;
const TEMPLATE = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/;

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Значение поля по типу из манифеста; undefined — «не задано».
function coerce(field, value) {
  if (value === undefined || value === null) return undefined;
  switch (field.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (/^(true|1|yes|on)$/i.test(String(value))) return true;
      if (/^(false|0|no|off)$/i.test(String(value))) return false;
      return undefined;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      return String(value).trim() === '' || !Number.isFinite(n) ? undefined : n;
    }
    default:
      if (field.multiple) return Array.isArray(value) ? value.map(String) : undefined;
      return String(value);
  }
}

function stringify(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export class SettingsStore {
  // hidden — поля, которые на сервере не настраиваются (например, папки на диске);
  // их переменные окружения задаёт fixedEnv.
  constructor({ file, manifest, hidden = [], fixedEnv = {}, logger }) {
    this.file = file;
    this.manifest = manifest;
    this.hidden = new Set(hidden);
    this.fixedEnv = fixedEnv;
    this.logger = logger;
    this.values = {};
    this.updated = null;
  }

  // Поля страницы настроек в порядке манифеста.
  get fields() {
    return Object.entries(this.manifest.user_config ?? {})
      .filter(([key]) => !this.hidden.has(key))
      .map(([key, f]) => ({ key, ...f }));
  }

  field(key) {
    const f = this.manifest.user_config?.[key];
    return f ? { key, ...f } : null;
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.values = {};
      this.updated = null;
      return this.values;
    }
    const data = JSON.parse(text);
    const values = {};
    for (const [key, raw] of Object.entries(data?.values ?? {})) {
      const field = this.field(key);
      if (!field) continue; // поле убрали из манифеста
      const v = coerce(field, raw);
      if (v !== undefined) values[key] = v;
    }
    this.values = values;
    this.updated = data?.updated ?? null;
    return values;
  }

  save(values) {
    const clean = {};
    for (const [key, raw] of Object.entries(values)) {
      const field = this.field(key);
      if (!field) continue;
      const v = coerce(field, raw);
      if (v !== undefined) clean[key] = v;
    }
    const updated = new Date().toISOString();
    writeFileAtomic(this.file, `${JSON.stringify({ version: FILE_VERSION, updated, values: clean }, null, 1)}\n`);
    this.values = clean;
    this.updated = updated;
    return clean;
  }

  // Значение для коннектора: сохранённое или значение по умолчанию из манифеста.
  effective(key, values = this.values) {
    if (Object.hasOwn(values, key)) return values[key];
    return this.field(key)?.default;
  }

  // Окружение коннектора: переменные процесса, поверх — значения из настроек (как их
  // подставил бы Claude Desktop), поверх — постоянные значения сервера. Переменные
  // полей без значения удаляются: единственный источник этих настроек — страница.
  env(values = this.values, base = process.env) {
    const env = { ...base };
    for (const [name, template] of Object.entries(this.manifest.server?.mcp_config?.env ?? {})) {
      const m = String(template).match(TEMPLATE);
      if (!m) {
        env[name] = String(template);
        continue;
      }
      const key = m[1];
      if (this.hidden.has(key)) {
        delete env[name];
        continue;
      }
      const v = this.effective(key, values);
      if (v === undefined || v === '') delete env[name];
      else env[name] = stringify(v);
    }
    return { ...env, ...this.fixedEnv };
  }

  // Разбор формы страницы настроек (URLSearchParams) поверх текущих значений.
  // Секретное поле: пустое — оставить прежнее значение, отметка clear:<ключ> — стереть.
  parseForm(form) {
    const values = { ...this.values };
    const errors = [];
    for (const field of this.fields) {
      const { key } = field;
      if (field.type === 'boolean') {
        values[key] = form.get(key) === 'on';
        continue;
      }
      const raw = form.get(key);
      if (field.sensitive) {
        if (form.get(`clear:${key}`) === 'on') delete values[key];
        else if (raw !== null && raw.trim() !== '') values[key] = raw.trim();
        continue;
      }
      if (raw === null) continue;
      const s = raw.trim();
      if (s === '') {
        delete values[key];
        continue;
      }
      if (field.type === 'number') {
        const n = Number(s.replace(',', '.'));
        if (!Number.isFinite(n)) {
          errors.push(`«${field.title}»: нужно число`);
          continue;
        }
        if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
          errors.push(`«${field.title}»: число от ${field.min ?? '−∞'} до ${field.max ?? '∞'}`);
          continue;
        }
        values[key] = n;
        continue;
      }
      values[key] = s;
    }
    for (const field of this.fields) {
      if (field.required && this.effective(field.key, values) === undefined) errors.push(`«${field.title}»: обязательное поле`);
    }
    return { values, errors };
  }
}
