#!/usr/bin/env node
// Собирает server/catalog.json — каталог REST-методов Bybit V5 — из исходников
// официальной документации (github.com/bybit-exchange/docs, папка docs/v5).
//
// Из документации берутся только факты интерфейса: метод, путь, название страницы,
// имена и типы параметров, обязательность, перечисления, упомянутые значения,
// лимиты и требуемые права ключа. Текст описаний не копируется — полную страницу
// коннектор подтягивает по запросу (describe_endpoint с include_docs).
//
// Запуск:
//   node scripts/build-catalog.mjs <путь к клону bybit-exchange/docs> [--out server/catalog.json]

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_SITE = 'https://bybit-exchange.github.io/docs/v5/';

// ---------------------------------------------------------------------------
// Классификация

// Пути, которые точно не требуют подписи, хотя страница об этом не пишет.
const PUBLIC_PATHS = [
  /^\/v5\/market\//,
  /^\/v5\/spread\/(instrument|orderbook|tickers|recent-trade)$/,
  /^\/v5\/rfq\/public-trades$/,
  /^\/v5\/announcements\/index$/,
  /^\/v5\/system\/status$/,
  /^\/v5\/spot-lever-token\/(info|reference)$/,
];
// Рыночные данные «событийных» контрактов: подпись не мешает, но и не нужна.
const OPTIONAL_AUTH_PATHS = [/^\/v5\/event\/(instruments-info|orderbook)$/];

const PUBLIC_PHRASES = [
  /does\s+not\s+(?:need|require)\s+(?:any\s+)?authentication/i,
  /authentication\s+is\s+(?:\*\*)?not(?:\*\*)?\s+required/i,
  /no\s+authentication\s+(?:is\s+)?required/i,
  /without\s+authentication/i,
];
// «Без ключа — публичные данные», «гостевой доступ», «без авторизации поле пустое»:
// метод отвечает и без подписи, но с подписью отдаёт данные счёта.
const OPTIONAL_AUTH_PHRASES = [
  /without\s+an\s+api\s+key/i,
  /guest\s+access/i,
  /authenticated\s+users\s+(?:receive|get|see)/i,
  /return(?:s|ed)?\s[^|\n]{0,40}\swithout\s+authentication/i,
];

// Создание бота переводит средства на его счёт и запускает автоматическую торговлю:
// на mainnet нужны оба переключателя.
const MOVES_FUNDS_PATHS = [/^\/v5\/(grid\/create-grid|fgridbot\/create|fmartingalebot\/create|fcombobot\/create|dca\/create-bot)$/];

// Глаголы записи в пути: такой POST не считается чтением, даже если название начинается с Get.
const WRITE_VERB = /(?:^|[/_-])(create|cancel|place|submit|execute|transfer|withdraw|redeem|purchase|borrow|repay|stake|buy|sell|apply|confirm|delete|del|update|modify|set|switch|close|add|remove|claim|invest|subscribe|commit|report|bind|upgrade|renew|reinvest|mint|distribute|save|reset|move|freeze|frozen|agreement)(?=$|[/_-])/i;

// Методы, которые работают только на одном из контуров.
const ENV_ONLY = {
  '/v5/account/demo-apply-money': ['demo'],
  '/v5/user/create-demo-member': ['mainnet'],
};

// POST-методы, которые только читают данные, узнаются по названию.
const READ_TITLE = /^(get|query|obtain|validate|pre[\s-]?check|check)\b/i;

// Торговый уровень: ордера, позиции и торговые настройки.
const TRADE_PATHS = [
  /^\/v5\/order\//,
  /^\/v5\/position\/(?!move-positions$)/,
  /^\/v5\/spread\/order\//,
  /^\/v5\/rfq\//,
  /^\/v5\/event\/(quotes|cancel)$/,
  /^\/v5\/account\/(set-margin-mode|set-hedging-mode|set-collateral-switch|set-collateral-switch-batch|mmp-modify|mmp-reset|set-delta-mode|set-limit-px-action)$/,
  /^\/v5\/spot-margin-trade\/(switch-mode|set-leverage|set-auto-repay-mode)$/,
  /^\/v5\/strategy\//,
  /^\/v5\/(grid|fgridbot|fmartingalebot|fcombobot|dca)\//,
  /^\/v5\/rwa\/stocks\/order(\/cancel)?$/,
  /^\/v5\/alpha\/trade\/(purchase|redeem)$/,
  /^\/v5\/alpha\/prediction\/(buy|sell)$/,
  /^\/v5\/spot-lever-token\/(purchase|redeem)$/,
];

function classifyTier(method, path, title) {
  if (method === 'GET') return 'read';
  if (READ_TITLE.test(title) && !WRITE_VERB.test(path)) return 'read';
  if (TRADE_PATHS.some((re) => re.test(path))) return 'trade';
  // Всё остальное — переводы, вывод, конвертация, займы, earn, управление
  // субаккаунтами и ключами — самый строгий уровень.
  return 'funds';
}

// requestText — страница до описания ответа: фразы о публичности ищем только там,
// иначе «поле пустое without authentication» в ответе делает метод публичным.
function classifyAuth(path, requestText, fullText) {
  if (PUBLIC_PATHS.some((re) => re.test(path))) return 'public';
  if (OPTIONAL_AUTH_PATHS.some((re) => re.test(path))) return 'optional';
  if (OPTIONAL_AUTH_PHRASES.some((re) => re.test(fullText))) return 'optional';
  if (PUBLIC_PHRASES.some((re) => re.test(requestText))) return 'public';
  return 'private';
}

// ---------------------------------------------------------------------------
// Разбор markdown

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.mdx')) out.push(full);
  }
  return out.sort();
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*\n?/);
  const data = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: m ? text.slice(m[0].length) : text };
}

// Разметка → простой текст (для служебного разбора, не для хранения).
function plain(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&emsp;|&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

// Якорь заголовка так же, как его строит Docusaurus (github-slugger).
function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function parseEnums(enumText) {
  const enums = {};
  let current = null;
  for (const line of enumText.split('\n')) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      current = slugifyHeading(h[1]);
      enums[current] = [];
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    // Пункт может перечислять несколько значений подряд: * `1` `3` `5` minute
    const item = line.match(/^\s*[*-]\s+((?:`[^`]+`[\s,]*)+)/);
    // …или быть ссылкой: - [RPI](…), - <a href="…">PostOnly</a> (только верхний уровень списка)
    const link = line.match(/^[*-]\s+(?:\[([A-Za-z0-9_]+)\]\(|<a\s[^>]*>([A-Za-z0-9_]+)<\/a>)/);
    const values = item ? [...item[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : link ? [link[1] ?? link[2]] : [];
    for (const v of values) {
      if (!enums[current].includes(v)) enums[current].push(v);
    }
  }
  // Раздел symbol — примеры названий, а не перечисление.
  delete enums.symbol;
  for (const [k, v] of Object.entries(enums)) if (v.length === 0) delete enums[k];
  return enums;
}

function normType(raw, stats) {
  const t = plain(raw).toLowerCase();
  let type;
  if (/^(string|str)\b/.test(t)) type = 'string';
  else if (/^(integer|int|long|int32|int64)\b/.test(t)) type = 'integer';
  else if (/^(number|float|double|decimal|bigdecimal)\b/.test(t)) type = 'number';
  else if (/^(bool|boolean)\b/.test(t)) type = 'boolean';
  else if (/array|list|\[\]/.test(t)) type = 'array';
  else if (/^(object|map|json|dict)/.test(t)) type = 'object';
  else type = 'string';
  if (!['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(t.split(/\W/)[0])) {
    stats.oddTypes[t] = (stats.oddTypes[t] || 0) + 1;
  }
  return type;
}

function parseNameCell(raw) {
  let s = raw.trim();
  let level = 0;
  const lead = s.match(/^(?:(?:>|&gt;)\s*)+/);
  if (lead) {
    level = (lead[0].match(/>|&gt;/g) || []).length;
    s = s.slice(lead[0].length);
  }
  const deprecated = /~~/.test(s) || /deprecated/i.test(s);
  const enumRef = (s.match(/\]\((?:\.\.\/)*(?:\.\/)?enum#([^)\s]+)\)/) || [])[1];
  const text = plain(s).replace(/~~/g, '').replace(/`/g, '');
  const name = (text.match(/^[A-Za-z_$][\w.$[\]-]*/) || [])[0];
  return { level, name, deprecated, enumRef };
}

const CATEGORY_WORDS = new Set(['spot', 'linear', 'inverse', 'option']);

// Подсказки из столбца Comments: упомянутые в `кавычках` значения (это не строгий
// список — туда попадают и оговорки вроде «только для linear»), значение по
// умолчанию и допустимый диапазон.
function extractHints(name, comment, siblingNames) {
  const hints = {};
  const src = comment.replace(/<code>([^<]*)<\/code>/gi, '`$1`').replace(/<[^>]+>/g, ' ');
  const categoryLike = /category/i.test(name);
  const mentions = [];
  for (const m of src.matchAll(/`([^`\n]{1,40})`/g)) {
    const v = m[1].trim();
    if (!v || siblingNames.has(v) || /\s{2,}|=|:\/\//.test(v)) continue;
    if (!categoryLike && CATEGORY_WORDS.has(v)) continue;
    if (!mentions.includes(v)) mentions.push(v);
    if (mentions.length >= 30) break;
  }
  if (mentions.length) hints.mentions = mentions;
  const def =
    src.match(/default(?:\s+value)?\s*(?:is|:|：)\s*`([^`]+)`/i) ||
    src.match(/default(?:\s+value)?\s*(?:is|:|：)\s*(-?\d+(?:\.\d+)?)\b/i) ||
    src.match(/`([^`]+)`\s*\(\s*default\s*\)/i) ||
    src.match(/`([^`]+)`\s*(?:is\s+)?(?:used\s+)?by\s+default/i);
  if (def) hints.default = def[1].trim();
  const range = src.match(/\[\s*`?(-?\d+(?:\.\d+)?)`?\s*,\s*`?(-?\d+(?:\.\d+)?)`?\s*\]/);
  if (range) hints.range = [Number(range[1]), Number(range[2])];
  return hints;
}

function columnsOf(header) {
  const h = header.map((c) => plain(c).toLowerCase());
  return {
    name: h.findIndex((x) => x.startsWith('parameter')),
    required: h.findIndex((x) => x.startsWith('required')),
    type: h.findIndex((x) => x.startsWith('type')),
    comment: h.findIndex((x) => x.startsWith('comment') || x.startsWith('description')),
  };
}

function rowFromCells(cells, col, stats) {
  const nameInfo = parseNameCell(cells[col.name] ?? '');
  if (!nameInfo.name) return null;
  return {
    ...nameInfo,
    required: col.required >= 0 ? /true/i.test(plain(cells[col.required] ?? '')) : false,
    type: col.type >= 0 ? normType(cells[col.type] ?? '', stats) : 'string',
    comment: col.comment >= 0 ? (cells[col.comment] ?? '') : '',
  };
}

// Строки markdown-таблицы, начиная с заголовка в lines[start].
function markdownRows(lines, start, stats, file) {
  let i = start;
  const col = columnsOf(splitRow(lines[i]));
  if (col.name < 0) {
    stats.warnings.push(`${file}: таблица без столбца Parameter`);
    return [];
  }
  i++;
  if (i < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i])) i++;
  const rows = [];
  for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const row = rowFromCells(splitRow(lines[i]), col, stats);
    if (row) rows.push(row);
  }
  return rows;
}

// Строки HTML-таблиц (<table><tr><th|td>…). Если таблиц несколько (вкладки с
// вариантами запроса), параметры объединяются; обязательным остаётся только то,
// что обязательно во всех вариантах.
function htmlRows(html, stats) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const perTable = [];
  for (const t of tables) {
    const trs = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    if (!trs.length) continue;
    const cellsOf = (tr) => [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => m[1].trim());
    const col = columnsOf(cellsOf(trs[0]));
    if (col.name < 0) continue;
    const rows = [];
    for (const tr of trs.slice(1)) {
      const row = rowFromCells(cellsOf(tr), col, stats);
      if (row) rows.push(row);
    }
    perTable.push(rows);
  }
  if (perTable.length <= 1) return perTable[0] ?? [];
  const merged = [];
  for (const rows of perTable) {
    for (const r of rows) {
      const same = merged.find((m) => m.name === r.name && m.level === r.level);
      if (same) same.required = same.required && r.required;
      else merged.push({ ...r });
    }
  }
  for (const m of merged) {
    if (m.level === 0 && !perTable.every((rows) => rows.some((r) => r.name === m.name))) m.required = false;
  }
  return merged;
}

// Плоский список строк с уровнями вложенности → дерево параметров.
function buildParamTree(rows, stats, file) {
  const siblingNames = new Set(rows.map((r) => r.name));
  const root = [];
  const stack = [{ level: -1, children: root }];
  for (const r of rows) {
    const param = { name: r.name, type: r.type };
    if (r.required) param.required = true;
    if (r.deprecated) param.deprecated = true;
    if (r.enumRef) param.enum = r.enumRef.toLowerCase();
    Object.assign(param, extractHints(r.name, r.comment, siblingNames));
    while (stack.length > 1 && stack[stack.length - 1].level >= r.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (r.level > parent.level + 1) stats.warnings.push(`${file}: скачок вложенности у ${r.name}`);
    parent.children.push(param);
    if (parent.param && parent.param.type !== 'array' && parent.param.type !== 'object') {
      parent.param.type = 'object';
    }
    param.children = [];
    stack.push({ level: r.level, children: param.children, param });
  }
  const prune = (list) => {
    for (const p of list) {
      if (p.children.length === 0) delete p.children;
      else prune(p.children);
    }
  };
  prune(root);
  return root;
}

function findHeading(lines, from, to, re) {
  for (let i = from; i < to; i++) if (re.test(lines[i])) return i;
  return -1;
}

const HTTP_HEADING = /^#{2,4}\s*HTTP\s+Request\b/i;
const REQ_PARAMS_HEADING = /^#{2,4}\s*Request\s+Param/i;

function extractIntroFacts(intro) {
  const facts = {};
  const perm = intro.match(/permission[s]?\**\s*[:：]\s*\**\s*([^\n]+)/i);
  if (perm) {
    const v = plain(perm[1].split(/<br/i)[0]).replace(/^["'`]|["'`.]$/g, '').replace(/["`]/g, '');
    if (v && v.length <= 80) facts.permission = v;
  }
  const rl = intro.match(/rate\s+limit\**\s*[:：]\s*\**\s*([^\n]+)/i);
  if (rl) {
    const v = plain(rl[1].split(/<br/i)[0]);
    if (v && v.length <= 80) facts.rateLimit = v;
  }
  return facts;
}

function parseDoc(file, docsDir, stats) {
  const rel = relative(docsDir, file).split(sep).join('/');
  const raw = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const { data, body } = parseFrontmatter(raw);
  const lines = body.split('\n');
  const title = data.title || data.sidebar_label || rel;
  const slug = rel.replace(/\.mdx$/, '');
  const found = [];
  const headings = [];
  lines.forEach((l, i) => HTTP_HEADING.test(l) && headings.push(i));
  headings.forEach((h, k) => {
    const end = k + 1 < headings.length ? headings[k + 1] : lines.length;
    let method;
    let path;
    for (let i = h + 1; i < Math.min(h + 8, end); i++) {
      const m =
        lines[i].match(/<APIEndpoint\s+method="([A-Z]+)"\s+url="([^"]+)"/) ||
        lines[i].match(/^\s*(GET|POST|PUT|DELETE)\s+`([^`]+)`/);
      if (m) {
        method = m[1];
        path = m[2].trim().split('?')[0];
        break;
      }
    }
    if (!method) {
      stats.warnings.push(`${rel}: не найден метод после HTTP Request`);
      return;
    }
    // На странице демо-сервиса два метода, каждый в своём разделе уровнем выше.
    let introStart = 0;
    let sectionTitle = title;
    if (headings.length > 1) {
      const level = lines[h].match(/^#+/)[0].length;
      const lower = k === 0 ? 0 : headings[k - 1];
      for (let i = h - 1; i >= lower; i--) {
        const m = lines[i].match(/^(#+)\s+(.*)$/);
        if (m && m[1].length < level) {
          introStart = i;
          sectionTitle = plain(m[2]);
          break;
        }
      }
    }
    const intro = lines.slice(introStart, h).join('\n');
    const rp = findHeading(lines, h, end, REQ_PARAMS_HEADING);
    let params = [];
    let paramsFrom;
    if (rp >= 0) {
      const next = findHeading(lines, rp + 1, end, /^#{2,4}\s/);
      const section = lines.slice(rp + 1, next >= 0 ? next : end);
      const sectionText = section.join('\n');
      const mdStart = section.findIndex((l) => l.trim().startsWith('|'));
      if (mdStart >= 0) {
        params = buildParamTree(markdownRows(section, mdStart, stats, rel), stats, rel);
      } else if (/<table/i.test(sectionText)) {
        params = buildParamTree(htmlRows(sectionText, stats), stats, rel);
      } else {
        // «refer to [create order request](../order/create-order#request-parameters)»
        const ref = sectionText.match(/refer\s+to\s+\[[^\]]*\]\(([^)#]+)#request-param/i);
        if (ref) paramsFrom = posix.normalize(posix.join(posix.dirname(slug), ref[1]));
        else if (!/\bnone\b|no\s+(?:request\s+)?param/i.test(sectionText)) {
          stats.noTable.push(`${rel} (${method} ${path})`);
        }
      }
    } else {
      stats.noParamsHeading.push(`${rel} (${method} ${path})`);
    }
    const deprecated =
      slug.startsWith('abandon/') ||
      /deprecated/i.test(`${data.title ?? ''} ${data.sidebar_label ?? ''}`) ||
      /this\s+(?:endpoint|api|interface)\s+(?:has\s+been|is|will\s+be)\s+(?:deprecated|discontinued|offline)/i.test(intro);
    const respHeading = findHeading(lines, h, end, /^#{2,4}\s*Response\s+Param/i);
    const requestText = lines.slice(introStart, respHeading >= 0 ? respHeading : end).join('\n');
    const auth = classifyAuth(path, requestText, raw);
    if (auth !== 'private' && !PUBLIC_PATHS.some((re) => re.test(path))) stats.phraseAuth.push(`${auth}: ${method} ${path}`);
    found.push({
      slug,
      idBase: headings.length > 1 ? `${slug}/${slugifyHeading(sectionTitle)}` : slug,
      source: `docs/v5/${rel}`,
      title: sectionTitle,
      method,
      path,
      auth,
      deprecated,
      ...extractIntroFacts(intro),
      params,
      paramsFrom,
    });
  });
  return found;
}

// Таблица «Available API List» на странице демо-сервиса: в ней и пути методов,
// и ссылки на страницы документации (путь в таблице иногда устаревший).
function parseDemoTable(demoText) {
  const table = demoText.slice(demoText.search(/Available API List/i));
  const paths = new Set(['/v5/account/demo-apply-money']);
  const slugs = new Set();
  for (const m of table.matchAll(/<td[^>]*>\s*(\/v5\/[A-Za-z0-9/_-]+)/g)) {
    if (!m[1].startsWith('/v5/private')) paths.add(m[1]);
  }
  for (const m of table.matchAll(/<a\s+href="\/v5\/([^"#]+)"/g)) slugs.add(m[1].replace(/\/$/, ''));
  return { paths, slugs };
}

function uniqueId(base, used) {
  let id = base.replace(/\s+copy$/i, '').replace(/\s+/g, '-');
  if (used.has(id)) {
    let n = 2;
    while (used.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  used.add(id);
  return id;
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith('--'));
  if (!repo) {
    console.error('Использование: node scripts/build-catalog.mjs <клон bybit-exchange/docs> [--out файл]');
    process.exit(2);
  }
  const outIdx = args.indexOf('--out');
  const out = resolve(outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'server', 'catalog.json'));
  const docsDir = join(resolve(repo), 'docs', 'v5');

  let commit = null;
  let committedAt = null;
  try {
    [commit, committedAt] = execFileSync('git', ['-C', resolve(repo), 'log', '-1', '--format=%H %cI'], {
      encoding: 'utf8',
    })
      .trim()
      .split(' ');
  } catch {
    // не git-клон — версию просто не указываем
  }

  const stats = { warnings: [], noTable: [], noParamsHeading: [], oddTypes: {}, phraseAuth: [] };
  const enums = parseEnums(readFileSync(join(docsDir, 'enum.mdx'), 'utf8'));
  const demoTable = parseDemoTable(readFileSync(join(docsDir, 'demo.mdx'), 'utf8'));

  const parsed = walk(docsDir).flatMap((file) => parseDoc(file, docsDir, stats));
  for (const ep of parsed) {
    if (!ep.paramsFrom) continue;
    const donor = parsed.find((d) => d.slug === ep.paramsFrom);
    if (donor) ep.params = structuredClone(donor.params);
    else stats.warnings.push(`${ep.source}: ссылка на параметры ${ep.paramsFrom} не найдена`);
  }

  const endpoints = [];
  const usedIds = new Set();
  for (const ep of parsed) {
    const id = uniqueId(ep.idBase, usedIds);
    const entry = {
      id,
      title: ep.title,
      method: ep.method,
      path: ep.path,
      group: id.split('/')[0],
      tier: classifyTier(ep.method, ep.path, ep.title),
      auth: ep.auth,
      demo:
        ep.path.startsWith('/v5/market/') ||
        demoTable.paths.has(ep.path) ||
        demoTable.slugs.has(ep.slug) ||
        demoTable.slugs.has(ep.slug.replace(/\/([^/]+)$/, '')) && ep.slug.endsWith(`/${ep.slug.split('/').at(-2)}`),
    };
    if (MOVES_FUNDS_PATHS.some((re) => re.test(ep.path))) entry.movesFunds = true;
    if (ep.deprecated) entry.deprecated = true;
    if (ep.permission) entry.permission = ep.permission;
    if (ep.rateLimit) entry.rateLimit = ep.rateLimit;
    // position/position.mdx публикуется как /docs/v5/position
    const parts = ep.slug.split('/');
    if (parts.length > 1 && parts.at(-1) === parts.at(-2)) parts.pop();
    entry.docs = DOCS_SITE + parts.map(encodeURIComponent).join('/');
    if (ENV_ONLY[ep.path]) entry.envs = ENV_ONLY[ep.path];
    entry.source = ep.source;
    entry.params = ep.params;
    endpoints.push(entry);
  }

  for (const p of demoTable.paths) {
    if (!endpoints.some((e) => e.path === p)) stats.warnings.push(`demo.mdx: путь ${p} не найден в каталоге`);
  }
  for (const s of demoTable.slugs) {
    const known = parsed.some((e) => e.slug === s || e.slug === `${s}/${s.split('/').at(-1)}`);
    if (!known && !s.startsWith('websocket/')) stats.warnings.push(`demo.mdx: страница ${s} не найдена`);
  }
  const usedEnums = new Set();
  const collect = (list) => {
    for (const p of list) {
      if (p.enum) {
        if (enums[p.enum]) usedEnums.add(p.enum);
        else delete p.enum;
      }
      if (p.children) collect(p.children);
    }
  };
  endpoints.forEach((e) => collect(e.params));
  const keptEnums = Object.fromEntries(Object.entries(enums).filter(([k]) => usedEnums.has(k)));

  const catalog = {
    source: {
      repository: 'https://github.com/bybit-exchange/docs',
      commit,
      committedAt,
      generatedAt: new Date().toISOString(),
    },
    enums: keptEnums,
    endpoints,
  };
  writeFileSync(out, `${JSON.stringify(catalog)}\n`);

  const byTier = {};
  const byAuth = {};
  for (const e of endpoints) {
    byTier[e.tier] = (byTier[e.tier] || 0) + 1;
    byAuth[e.auth] = (byAuth[e.auth] || 0) + 1;
  }
  const report = {
    out: relative(process.cwd(), out),
    commit,
    endpoints: endpoints.length,
    uniquePaths: new Set(endpoints.map((e) => `${e.method} ${e.path}`)).size,
    byTier,
    byAuth,
    demo: endpoints.filter((e) => e.demo).length,
    deprecated: endpoints.filter((e) => e.deprecated).length,
    enums: Object.keys(keptEnums).length,
    warnings: stats.warnings,
    noTable: stats.noTable,
    noParamsHeading: stats.noParamsHeading,
    oddTypes: stats.oddTypes,
    phraseAuth: stats.phraseAuth,
    // POST-методы уровня «чтение»: их можно разрешить в Claude Desktop навсегда — просматривать при каждой пересборке.
    readPosts: endpoints.filter((e) => e.method === 'POST' && e.tier === 'read').map((e) => `${e.path} — ${e.title}`),
    movesFunds: endpoints.filter((e) => e.movesFunds).map((e) => e.path),
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
