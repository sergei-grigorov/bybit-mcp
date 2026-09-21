// Каталог REST-методов Bybit V5 (server/catalog.json, собирается
// scripts/build-catalog.mjs из официальной документации): поиск и описание.

import { readFileSync } from 'node:fs';

export const TIER_TOOL = { read: 'bybit_read', trade: 'bybit_trade', funds: 'bybit_funds' };

const TIER_LABEL = {
  read: 'read (no side effects)',
  trade: 'trade (orders, positions, trading settings)',
  funds: 'funds (transfers, withdrawals, conversions, loans, earn, sub-accounts, API keys)',
};
const AUTH_LABEL = {
  public: 'public (no API key needed)',
  optional: 'optional (public data without a key, account data with a key)',
  private: 'private (API key required)',
};

export class Catalog {
  constructor(data) {
    this.source = data.source ?? {};
    this.enums = data.enums ?? {};
    this.endpoints = data.endpoints ?? [];
    this.byId = new Map();
    this.byPath = new Map();
    this.byLowerPath = new Map();
    for (const e of this.endpoints) {
      this.byId.set(e.id, e);
      if (!this.byPath.has(e.path)) this.byPath.set(e.path, []);
      this.byPath.get(e.path).push(e);
      const lower = e.path.toLowerCase();
      if (!this.byLowerPath.has(lower)) this.byLowerPath.set(lower, []);
      this.byLowerPath.get(lower).push(e);
    }
  }

  static load(url = new URL('./catalog.json', import.meta.url)) {
    return new Catalog(JSON.parse(readFileSync(url, 'utf8')));
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  lookup(path, method) {
    const list = this.byPath.get(path) ?? [];
    return method ? list.filter((e) => e.method === method) : list;
  }

  lookupIgnoreCase(path) {
    return this.byLowerPath.get(path.toLowerCase()) ?? [];
  }

  groups() {
    const counts = {};
    for (const e of this.endpoints) counts[e.group] = (counts[e.group] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  // Поиск по словам: все слова должны встретиться (в названии, пути, id, правах
  // или именах параметров); если так ничего не нашлось — хотя бы одно.
  search({ query = '', group, tier, method, publicOnly = false, demoOnly = false, includeDeprecated = false, limit = 25 } = {}) {
    const tokens = query
      .toLowerCase()
      .split(/[\s,/._:-]+/)
      .filter((t) => t && t !== 'v5');
    const pool = this.endpoints.filter(
      (e) =>
        (!group || e.group === group || e.id.startsWith(`${group}/`)) &&
        (!tier || e.tier === tier) &&
        (!method || e.method === method) &&
        (!publicOnly || e.auth !== 'private') &&
        (!demoOnly || e.demo) &&
        (includeDeprecated || !e.deprecated),
    );
    const score = (e, token) => {
      let s = 0;
      if (e.title.toLowerCase().includes(token)) s += 3;
      if (e.path.toLowerCase().includes(token)) s += 3;
      if (e.id.toLowerCase().includes(token)) s += 2;
      if (e.permission?.toLowerCase().includes(token)) s += 1;
      if (e.params.some((p) => p.name.toLowerCase() === token)) s += 1;
      return s;
    };
    const rank = (requireAll) =>
      pool
        .map((e) => {
          const scores = tokens.map((t) => score(e, t));
          const matched = scores.filter((s) => s > 0).length;
          const ok = tokens.length === 0 || (requireAll ? matched === tokens.length : matched > 0);
          return ok ? { e, s: scores.reduce((a, b) => a + b, 0) + matched * 2 } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.s - a.s || a.e.path.localeCompare(b.e.path));
    let ranked = rank(true);
    let partial = false;
    if (!ranked.length && tokens.length > 1) {
      ranked = rank(false);
      partial = ranked.length > 0;
    }
    return { total: ranked.length, partial, results: ranked.slice(0, limit).map((r) => r.e) };
  }

  describe(entries) {
    const e = entries[0];
    const lines = [
      `${e.method} ${e.path} — ${e.title}`,
      `tool: ${TIER_TOOL[e.tier]} · access level: ${TIER_LABEL[e.tier]}`,
      `auth: ${AUTH_LABEL[e.auth]}`,
      `Demo Trading (api-demo.bybit.com): ${e.demo ? 'listed as supported' : 'not listed as supported'}`,
    ];
    if (e.envs) lines.push(`works only on: ${e.envs.join(', ')}`);
    if (e.movesFunds) lines.push('moves funds to a bot account: on mainnet needs both the trading and the fund-operations switches');
    if (e.permission) lines.push(`API key permission: ${e.permission}`);
    if (e.rateLimit) lines.push(`rate limit: ${e.rateLimit}`);
    if (e.deprecated) lines.push('status: deprecated in Bybit docs');
    lines.push(`docs: ${entries.map((x) => x.docs).filter((v, i, a) => a.indexOf(v) === i).join(' , ')}`);
    if (entries.length > 1) {
      lines.push('', `This path is documented on ${entries.length} pages (the same endpoint used by different products):`);
      for (const x of entries) lines.push(`  - ${x.id}: ${x.title}`);
    }
    lines.push('');
    const usedEnums = new Set();
    for (const [i, x] of entries.entries()) {
      if (entries.length > 1) lines.push(`Parameters for ${x.id} (* = required):`);
      else lines.push('Parameters (* = required):');
      if (!x.params.length) lines.push('  (none)');
      renderParams(x.params, '  ', lines, usedEnums);
      if (i < entries.length - 1) lines.push('');
    }
    if (usedEnums.size) {
      lines.push('', 'Enums (full lists from docs/v5/enum):');
      for (const name of usedEnums) lines.push(`  ${name}: ${this.enums[name].join(' | ')}`);
    }
    lines.push(
      '',
      'Notes: "mentioned" lists values quoted on the docs page (may include unrelated remarks such as product types).',
      'Numbers-as-strings (qty, price, …) are sent as strings; pass include_docs=true for the full official page.',
    );
    return lines.join('\n');
  }
}

function renderParams(params, indent, lines, usedEnums) {
  for (const p of params) {
    const bits = [];
    if (p.enum) {
      bits.push(`enum ${p.enum}`);
      usedEnums.add(p.enum);
    }
    if (p.mentions?.length) bits.push(`mentioned: ${p.mentions.join(', ')}`);
    if (p.default !== undefined) bits.push(`default: ${p.default}`);
    if (p.range) bits.push(`range: ${p.range[0]}..${p.range[1]}`);
    if (p.deprecated) bits.push('deprecated');
    const type = p.type === 'array' && p.children ? 'array of objects' : p.type;
    lines.push(`${indent}- ${p.name}${p.required ? '*' : ''} (${type})${bits.length ? ` — ${bits.join('; ')}` : ''}`);
    if (p.children) renderParams(p.children, `${indent}    `, lines, usedEnums);
  }
}

export function summarizeEntry(e) {
  const flags = [e.tier, e.auth];
  if (e.demo) flags.push('demo');
  if (e.envs) flags.push(`${e.envs.join('/')} only`);
  if (e.movesFunds) flags.push('needs trade+funds');
  if (e.deprecated) flags.push('deprecated');
  return `${e.method} ${e.path} — ${e.title} [${flags.join(', ')}] (${e.id})`;
}
