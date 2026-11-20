// Дочерний процесс: обрабатывает ОДНО задание и завершается.
// Запускает его worker.mjs:  node process-job.mjs <каталог задания> <params JSON> <имена JSON>
// Последняя строка stdout — JSON с итогом: {"ok":true,...} или {"ok":false,"code":...,"message":...}.
// Коды выхода: 0 — успех, 3 — непригодный вход (ошибка данных), остальное — сбой программы.
import { readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSheet, InputError } from './src/sheet.mjs';
import { validateParams, ParamsError } from './src/params.mjs';

const [dir, paramsText, namesText] = process.argv.slice(2);

function finish(result, exitCode) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = exitCode;
}

try {
  const params = validateParams(JSON.parse(paramsText));
  const names = JSON.parse(namesText ?? '[]');

  const testDelay = Number(process.env.TEST_DELAY_MS || 0);
  if (testDelay > 0) await delay(testDelay); // ТЕСТОВАЯ задержка для испытаний очереди

  // Входы лежат как input/01.png, input/02.png ... — имена создал сервер.
  const inputDir = path.join(dir, 'input');
  const files = (await readdir(inputDir)).filter((n) => /^\d{2}\.png$/.test(n)).sort();
  const buffers = await Promise.all(files.map((n) => readFile(path.join(inputDir, n))));

  const { png, layout } = await buildSheet(buffers, params, names);

  // Сначала пишем во временный каталог, потом одним rename публикуем результат.
  const tmpDir = path.join(dir, 'output.tmp');
  const outDir = path.join(dir, 'results');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir);
  await writeFile(path.join(tmpDir, 'sheet.png'), png, { flush: true });
  await writeFile(path.join(tmpDir, 'layout.json'), JSON.stringify(layout, null, 2) + '\n', { flush: true });
  await rename(tmpDir, outDir); // атомарно: каталог results появляется сразу целиком

  finish({ ok: true, summary: { inputs: buffers.length, sheet: [layout.sheet.width, layout.sheet.height] } }, 0);
} catch (error) {
  if (error instanceof InputError || error instanceof ParamsError) {
    finish({ ok: false, code: error.code || 'invalid_params', message: error.message }, 3);
  } else {
    process.stderr.write(String(error?.stack || error) + '\n');
    finish({ ok: false, code: 'processing_error', message: 'Внутренняя ошибка обработки' }, 1);
  }
}
