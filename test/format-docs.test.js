import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanDoc, fetchDoc } from '../server/docs.js';
import { fitJson } from '../server/format.js';

test('короткий JSON не меняется', () => {
  const v = { a: 1, list: [1, 2, 3] };
  assert.equal(fitJson(v, 1000), JSON.stringify(v));
});

test('обрезка затрагивает самый большой массив и остаётся валидным JSON', () => {
  const v = {
    env: 'demo',
    result: { small: [1, 2], list: Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(20) })) },
  };
  const text = fitJson(v, 8000);
  assert.ok(text.length <= 8000);
  const out = JSON.parse(text);
  assert.deepEqual(out.result.small, [1, 2]);
  assert.equal(out._output.truncated.length, 1);
  assert.equal(out._output.truncated[0].path, 'result.list');
  assert.equal(out._output.truncated[0].total, 2000);
  assert.equal(out.result.list.length, out._output.truncated[0].kept);
  assert.equal(v.result.list.length, 2000, 'исходный объект не тронут');
});

test('если массивов нет, текст обрезается с явной пометкой', () => {
  const text = fitJson({ blob: 'y'.repeat(10000) }, 5000);
  assert.ok(text.length < 5200);
  assert.match(text, /output cut at 5000 characters/);
});

test('очистка страницы документации', () => {
  const mdx = [
    '---',
    'title: Get Kline',
    '---',
    'Query klines.',
    '### HTTP Request',
    '<APIEndpoint method="GET" url="/v5/market/kline" />',
    '### Request Parameters',
    '|Parameter|Required|Type|Comments|',
    '|:-|:-|:-|:-|',
    '|symbol|<b>true</b>|string|Symbol<br/>name <ul><li>one</li></ul>|',
    '<a href="/api-explorer/v5/market/kline"><Button>RUN >></Button></a>',
    '### Request Example',
    '<Tabs><TabItem value="py">',
    '```python',
    'print(1)',
    '```',
    '</TabItem></Tabs>',
    '### Response Example',
    '```json',
    '{}',
    '```',
    '## Other',
    'Tail &amp; more',
  ].join('\n');
  const text = cleanDoc(mdx);
  assert.match(text, /^Query klines\./);
  assert.match(text, /GET \/v5\/market\/kline/);
  assert.match(text, /\|symbol\|true\|string\|Symbol; name  • one\|/);
  assert.doesNotMatch(text, /print\(1\)|Request Example|Response Example|RUN|title:/);
  assert.match(text, /## Other\nTail & more$/);
});

test('загрузка страницы документации кешируется, ошибки понятны', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.endsWith('missing.mdx')) return new Response('nope', { status: 404 });
    return new Response('---\ntitle: X\n---\nBody', { status: 200 });
  };
  const base = 'https://raw.example.test/docs/';
  assert.equal(await fetchDoc(base, 'docs/v5/a.mdx', { fetchImpl }), 'Body');
  assert.equal(await fetchDoc(base, 'docs/v5/a.mdx', { fetchImpl }), 'Body');
  assert.equal(calls, 1);
  await assert.rejects(fetchDoc(base, 'docs/v5/missing.mdx', { fetchImpl }), /HTTP 404/);
});

test('обработчик обрезки получает копию и может заменить пояснение', () => {
  const v = { result: { list: Array.from({ length: 500 }, (_, i) => ({ i, pad: 'z'.repeat(30) })), nextPageCursor: 'c' } };
  const text = fitJson(v, 5000, (clone, truncated) => {
    assert.equal(truncated[0].path, 'result.list');
    clone.result.nextPageCursor = null;
    return 'custom hint';
  });
  const out = JSON.parse(text);
  assert.equal(out.result.nextPageCursor, null);
  assert.equal(out._output.hint, 'custom hint');
  assert.equal(v.result.nextPageCursor, 'c');
});

test('загрузку документации можно отменить', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const controller = new AbortController();
  const pending = fetchDoc('https://raw.example.test/', 'docs/v5/slow.mdx', { fetchImpl, signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});
