#!/usr/bin/env node
// Вызов инструмента коннектора из терминала — для проверки без Claude Desktop.
// Настройки берутся из тех же переменных окружения, что и у сервера.
//
//   node scripts/call.mjs                       # список инструментов
//   node scripts/call.mjs bybit_get_tickers '{"category":"linear","symbol":"BTCUSDT"}'
//   BYBIT_DEMO_API_KEY=… BYBIT_DEMO_API_SECRET=… node scripts/call.mjs bybit_status '{"check_keys":true}'

import { createServer } from '../server/index.js';

const [name, rawArgs = '{}'] = process.argv.slice(2);
const { server } = createServer();

// process.exit() не ждёт записи в канал, поэтому код выхода задаём через exitCode.
if (!name) {
  for (const tool of server.listTools()) console.log(`${tool.name} — ${tool.title}`);
} else {
  await run(name);
}

async function run(toolName) {
  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch (err) {
    console.error(`Аргументы должны быть JSON: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  const reply = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
  if (reply.error) {
    console.error(`Ошибка протокола ${reply.error.code}: ${reply.error.message}`);
    process.exitCode = 1;
    return;
  }
  const text = reply.result.content.map((c) => c.text).join('\n');
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  process.exitCode = reply.result.isError ? 1 : 0;
}
