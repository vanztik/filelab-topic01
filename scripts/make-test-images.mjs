// Создаёт набор учебных входов для собственных испытаний в каталоге, указанном аргументом.
// Запуск: node scripts/make-test-images.mjs my-tests
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2] || 'my-tests';
await mkdir(out, { recursive: true });
const solid = (w, h, r, g, b, alpha) => sharp({
  create: { width: w, height: h, channels: alpha === undefined ? 3 : 4,
            background: alpha === undefined ? { r, g, b } : { r, g, b, alpha } },
}).png().toBuffer();

const files = {
  'red-4x2.png': await solid(4, 2, 255, 0, 0),
  'blue-2x4.png': await solid(2, 4, 0, 0, 255),
  'green-3x3.png': await solid(3, 3, 0, 200, 0),
  'big-800x200.png': await solid(800, 200, 255, 165, 0),
  'half-transparent-black-8x8.png': await solid(8, 8, 0, 0, 0, 0.5),
  'empty.png': Buffer.alloc(0),
  'not-a-png.png': Buffer.from('это текст, а не картинка\n'),
  'gray-4x4.png': await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } })
    .toColourspace('b-w').png().toBuffer(),
};
for (const [name, data] of Object.entries(files)) await writeFile(path.join(out, name), data);
console.log(`Создано ${Object.keys(files).length} файлов в ${out}`);
