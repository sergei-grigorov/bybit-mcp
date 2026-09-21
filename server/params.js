// Проверка и приведение параметров запроса по схеме из каталога.
// Bybit строг к типам в теле POST: qty и price — строки, positionIdx — число,
// reduceOnly — логическое. Модель же может прислать 0.01 вместо "0.01" или "1"
// вместо 1 — такие случаи приводим, а явные ошибки возвращаем до отправки.

// Число без экспоненты: 1e-7 → "0.0000001".
export function plainNumber(n) {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const [mantissa, expPart] = s.toLowerCase().split('e');
  const exp = Number(expPart);
  const negative = mantissa.startsWith('-');
  const [intPart, fracPart = ''] = mantissa.replace('-', '').split('.');
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  let out;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/, '');
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return (negative ? '-' : '') + out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Схема для нескольких страниц документации с одним путём (например,
// /v5/earn/advance/place-order у четырёх продуктов): объединение параметров,
// обязательно только то, что обязательно везде.
export function mergeParamSchemas(variants) {
  const merged = new Map();
  for (const list of variants) {
    for (const p of list) {
      const prev = merged.get(p.name);
      if (!prev) {
        merged.set(p.name, { ...p, children: p.children ? [p.children] : undefined, seen: 1 });
      } else {
        prev.seen++;
        prev.required = Boolean(prev.required && p.required);
        if (p.children) prev.children = [...(prev.children ?? []), p.children];
        if (prev.type !== p.type) prev.type = 'any';
      }
    }
  }
  return [...merged.values()].map(({ seen, children, ...p }) => {
    const out = { ...p };
    if (seen < variants.length) delete out.required;
    if (children) out.children = mergeParamSchemas(children);
    else delete out.children;
    return out;
  });
}

function coerce(spec, value, name, ctx) {
  const { method, errors, warnings } = ctx;
  const isPost = method !== 'GET';
  switch (spec.type) {
    case 'string': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number') {
        // Длинные id (spot orderId и т. п.) теряют цифры ещё при разборе JSON.
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
          errors.push(`"${name}" is too large for a JSON number and has lost precision — pass it as a string`);
          return value;
        }
        return plainNumber(value);
      }
      if (typeof value === 'boolean') return String(value);
      if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) {
        warnings.push(`"${name}" is a string parameter; the array was joined with commas`);
        return value.join(',');
      }
      errors.push(`"${name}" must be a string`);
      return value;
    }
    case 'integer': {
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) errors.push(`"${name}" must be an integer, got ${value}`);
        return value;
      }
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        const n = Number(value.trim());
        return isPost && Number.isSafeInteger(n) ? n : value.trim();
      }
      if (typeof value === 'boolean') {
        warnings.push(`"${name}" is an integer parameter; ${value} was sent as ${value ? 1 : 0}`);
        return value ? 1 : 0;
      }
      errors.push(`"${name}" must be an integer`);
      return value;
    }
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return isPost ? Number(value) : value.trim();
      }
      errors.push(`"${name}" must be a number`);
      return value;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
      if (value === 0 || value === 1) {
        warnings.push(`"${name}" is a boolean parameter; ${value} was sent as ${value === 1}`);
        return value === 1;
      }
      errors.push(`"${name}" must be true or false`);
      return value;
    }
    case 'array': {
      let arr = value;
      if (typeof arr === 'string') {
        const t = arr.trim();
        if (!isPost) return t; // в строке запроса список передаётся через запятую
        if (t.startsWith('[')) {
          try {
            arr = JSON.parse(t);
          } catch {
            errors.push(`"${name}" must be an array (the string is not valid JSON)`);
            return value;
          }
        } else {
          arr = t.split(',').map((s) => s.trim()).filter(Boolean);
          warnings.push(`"${name}" was given as a string and split by commas into an array`);
        }
      }
      if (!Array.isArray(arr)) {
        if (isPlainObject(arr) && spec.children) {
          warnings.push(`"${name}" must be an array; the single object was wrapped into one`);
          arr = [arr];
        } else {
          errors.push(`"${name}" must be an array`);
          return value;
        }
      }
      if (!spec.children) return isPost ? arr : arr.join(',');
      return arr.map((item, i) => {
        if (!isPlainObject(item)) {
          errors.push(`"${name}[${i}]" must be an object`);
          return item;
        }
        return prepareInto(spec.children, item, `${name}[${i}].`, ctx);
      });
    }
    case 'object': {
      let obj = value;
      if (typeof obj === 'string' && obj.trim().startsWith('{')) {
        try {
          obj = JSON.parse(obj);
        } catch {
          errors.push(`"${name}" must be an object (the string is not valid JSON)`);
          return value;
        }
      }
      if (!isPlainObject(obj)) {
        errors.push(`"${name}" must be an object`);
        return value;
      }
      return spec.children ? prepareInto(spec.children, obj, `${name}.`, ctx) : obj;
    }
    default:
      return value;
  }
}

function prepareInto(schema, input, prefix, ctx) {
  const known = new Map(schema.map((p) => [p.name, p]));
  const out = {};
  for (const [name, value] of Object.entries(input)) {
    if (UNSAFE_KEYS.has(name)) {
      ctx.errors.push(`parameter name "${prefix}${name}" is not allowed`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const spec = known.get(name);
    if (!spec) {
      (ctx.strictUnknown ? ctx.errors : ctx.warnings).push(`unknown parameter "${prefix}${name}"`);
      out[name] = value;
      continue;
    }
    if (spec.deprecated) ctx.warnings.push(`"${prefix}${name}" is marked deprecated in Bybit docs`);
    out[name] = coerce(spec, value, `${prefix}${name}`, ctx);
  }
  for (const spec of schema) {
    if (spec.required && !Object.hasOwn(out, spec.name)) ctx.errors.push(`missing required parameter "${prefix}${spec.name}"`);
  }
  return out;
}

// strictUnknown: неизвестный параметр — ошибка (для торговых и денежных методов,
// где опечатка молча меняет смысл операции), иначе — предупреждение.
export function prepareParams(schema, input, { method = 'GET', strictUnknown = false } = {}) {
  const ctx = { method: method.toUpperCase(), strictUnknown, errors: [], warnings: [] };
  const params = prepareInto(schema, isPlainObject(input) ? input : {}, '', ctx);
  return { params, errors: ctx.errors, warnings: ctx.warnings };
}
