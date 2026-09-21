// Страница официальной документации по запросу: исходник из репозитория
// bybit-exchange/docs, очищенный от разметки и примеров кода.

const MAX_DOC_CHARS = 40_000;
const cache = new Map();

const ENTITIES = { '&gt;': '>', '&lt;': '<', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&emsp;': ' ' };

// Разделы «Request Example» / «Response Example» выбрасываются целиком — до
// следующего заголовка того же или более высокого уровня.
function dropExampleSections(text) {
  const out = [];
  let skipLevel = 0;
  for (const line of text.split('\n')) {
    const heading = line.match(/^(#{1,6})\s/);
    if (heading && skipLevel && heading[1].length <= skipLevel) skipLevel = 0;
    const example = line.match(/^(#{2,6})\s*(?:Request|Response)\s+Example/i);
    if (!skipLevel && example) {
      skipLevel = example[1].length;
      continue;
    }
    if (!skipLevel) out.push(line);
  }
  return out.join('\n');
}

export function cleanDoc(mdx) {
  let text = mdx.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
  text = dropExampleSections(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<\/?(Tabs|TabItem)[^>]*>/g, '')
    .replace(/<APIEndpoint\s+method="([A-Z]+)"\s+url="([^"]+)"\s*\/>/g, '$1 $2')
    .replace(/<a\s+href="\/api-explorer[^"]*">[\s\S]*?<\/a>/g, '')
    .replace(/<br\s*\/?>/gi, '; ')
    .replace(/<li>/gi, ' • ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > MAX_DOC_CHARS) text = `${text.slice(0, MAX_DOC_CHARS)}\n…(страница обрезана)`;
  return text;
}

export async function fetchDoc(baseUrl, source, { timeoutMs = 10_000, fetchImpl = globalThis.fetch, signal } = {}) {
  const url = new URL(source, baseUrl).toString();
  if (cache.has(url)) return cache.get(url);
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Документация недоступна: HTTP ${response.status} для ${url}`);
  const text = cleanDoc(await response.text());
  cache.set(url, text);
  return text;
}
