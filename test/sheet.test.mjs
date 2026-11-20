// Проверки предметной операции. Запуск: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { buildSheet, fitSize, InputError } from '../src/sheet.mjs';
import { validateParams, ParamsError } from '../src/params.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const solid = (w, h, bg, channels = 3) =>
  sharp({ create: { width: w, height: h, channels, background: bg } }).png().toBuffer();
const pixel = async (png, x, y) => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

test('контрольный случай cases/01: лист 8×4, превью (0,1) и (5,0)', async () => {
  const params = { columns: 2, cellWidth: 4, cellHeight: 4, gap: 0 };
  const { png, layout } = await buildSheet([await fixture('red.png'), await fixture('blue.png')], params);
  assert.deepEqual([layout.sheet.width, layout.sheet.height], [8, 4]);
  const rects = layout.items.map((i) => [i.x, i.y, i.width, i.height]);
  assert.deepEqual(rects, [[0, 1, 4, 2], [5, 0, 2, 4]]);
  assert.deepEqual(await pixel(png, 0, 0), [255, 255, 255]); // фон белый
  assert.deepEqual(await pixel(png, 0, 1), [255, 0, 0]);     // красное превью
  assert.deepEqual(await pixel(png, 5, 0), [0, 0, 255]);     // синее превью
});

test('три входа при двух столбцах: вторая строка, пустая ячейка белая', async () => {
  const params = { columns: 2, cellWidth: 4, cellHeight: 4, gap: 2 };
  const inputs = [await solid(4, 2, '#ff0000'), await solid(2, 4, '#0000ff'), await solid(3, 3, '#00c800')];
  const { png, layout } = await buildSheet(inputs, params);
  assert.deepEqual([layout.sheet.width, layout.sheet.height], [10, 10]);
  assert.deepEqual(layout.items.at(2), { ...layout.items.at(2), x: 0, y: 6, width: 3, height: 3 });
  assert.deepEqual(await pixel(png, 8, 8), [255, 255, 255]); // пустая ячейка
});

test('уменьшение без увеличения и округление вниз', () => {
  assert.deepEqual(fitSize(2, 2, 64, 64), { width: 2, height: 2 });   // не увеличиваем
  assert.deepEqual(fitSize(800, 200, 64, 64), { width: 64, height: 16 });
  assert.deepEqual(fitSize(1000, 3, 4, 4), { width: 4, height: 1 });  // не меньше 1 px
  assert.deepEqual(fitSize(10, 3, 4, 4), { width: 4, height: 1 });    // 1.2 -> 1
});

test('прозрачность смешивается с белым', async () => {
  const half = await solid(4, 4, { r: 0, g: 0, b: 0, alpha: 0.5 }, 4);
  const { png } = await buildSheet([half], { columns: 1, cellWidth: 4, cellHeight: 4, gap: 0 });
  const [r] = await pixel(png, 1, 1);
  assert.ok(r > 120 && r < 135, `ожидался серый около 128, получено ${r}`);
});

test('нецелый отступ округляется вниз, неверные параметры отклоняются', () => {
  assert.equal(validateParams({ columns: 1, cellWidth: 4, cellHeight: 4, gap: 2.9 }).gap, 2);
  assert.throws(() => validateParams({ columns: 6, cellWidth: 4, cellHeight: 4, gap: 0 }), ParamsError);
  assert.throws(() => validateParams({ columns: 1, cellWidth: 3, cellHeight: 4, gap: 0 }), ParamsError);
  assert.throws(() => validateParams({ columns: 1, cellWidth: 4, cellHeight: 4 }), ParamsError);
  assert.throws(() => validateParams({ columns: 1, cellWidth: 4, cellHeight: 4, gap: 0, x: 1 }), ParamsError);
});

test('пустой файл и не-PNG дают понятную ошибку', async () => {
  const p = { columns: 1, cellWidth: 4, cellHeight: 4, gap: 0 };
  await assert.rejects(buildSheet([Buffer.alloc(0)], p), (e) => e instanceof InputError && e.code === 'empty_file');
  await assert.rejects(buildSheet([Buffer.from('hello')], p), (e) => e instanceof InputError && e.code === 'invalid_png');
});
