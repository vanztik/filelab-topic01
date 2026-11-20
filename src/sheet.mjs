// Предметная операция темы 01: контактный лист изображений.
// sharp декодирует PNG, смешивает прозрачность с белым и уменьшает картинки;
// расчёт размеров, координат и порядка выполняется здесь.
import sharp from 'sharp';
import { limits } from './config.mjs';

export class InputError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const WHITE = { r: 255, g: 255, b: 255 };

// Размер превью: вписать в ячейку без увеличения, округлить вниз, не меньше 1 px.
// Считаем целыми числами, чтобы не получить 3.9999 вместо 4 из-за дробей.
export function fitSize(w, h, cellW, cellH) {
  if (w <= cellW && h <= cellH) return { width: w, height: h };
  if (w * cellH >= h * cellW) {
    // Ограничивает ширина.
    return { width: cellW, height: Math.max(1, Math.floor((h * cellW) / w)) };
  }
  // Ограничивает высота.
  return { width: Math.max(1, Math.floor((w * cellH) / h)), height: cellH };
}

// Раскладка: где на листе окажется каждое превью. Зависит только от номера входа,
// а не от того, какая картинка обработалась раньше.
export function computeLayout(sizes, params) {
  const { columns, cellWidth, cellHeight, gap } = params;
  const rows = Math.ceil(sizes.length / columns);
  const sheetWidth = columns * cellWidth + (columns - 1) * gap;
  const sheetHeight = rows * cellHeight + (rows - 1) * gap;
  const items = sizes.map((s, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const fit = fitSize(s.width, s.height, cellWidth, cellHeight);
    const cellX = col * (cellWidth + gap);
    const cellY = row * (cellHeight + gap);
    return {
      input: index + 1,
      x: cellX + Math.floor((cellWidth - fit.width) / 2),
      y: cellY + Math.floor((cellHeight - fit.height) / 2),
      width: fit.width,
      height: fit.height,
    };
  });
  return { sheetWidth, sheetHeight, rows, columns, cellWidth, cellHeight, gap, items };
}

// Прочитать размеры входа и убедиться, что это PNG RGB/RGBA допустимого размера.
async function inspect(buffer, position) {
  if (buffer.length === 0) throw new InputError('empty_file', `Файл №${position} пустой`);
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: limits.maxPixels }).metadata();
  } catch {
    throw new InputError('invalid_png', `Файл №${position} не является корректным PNG`);
  }
  if (meta.format !== 'png') throw new InputError('invalid_png', `Файл №${position} не является PNG`);
  if (meta.channels < 3) {
    throw new InputError('unsupported_png', `Файл №${position}: нужен PNG RGB или RGBA, а не оттенки серого`);
  }
  if (meta.width * meta.height > limits.maxPixels) {
    throw new InputError('too_many_pixels', `Файл №${position} больше 4 000 000 пикселей`);
  }
  return { width: meta.width, height: meta.height };
}

// Подготовить одно превью: убрать прозрачность (смешать с белым) и уменьшить.
async function makeThumb(buffer, item, position) {
  try {
    return await sharp(buffer, { limitInputPixels: limits.maxPixels, failOn: 'error' })
      .flatten({ background: WHITE })
      .resize(item.width, item.height, { fit: 'fill' })
      .png()
      .toBuffer();
  } catch {
    throw new InputError('invalid_png', `Файл №${position} повреждён и не может быть прочитан`);
  }
}

// buffers — содержимое входов в порядке загрузки. Возвращает PNG листа и раскладку.
export async function buildSheet(buffers, params, names = []) {
  if (buffers.length < 1 || buffers.length > limits.maxFiles) {
    throw new InputError('bad_file_count', 'Нужно от 1 до 10 файлов');
  }
  const sizes = await Promise.all(buffers.map((b, i) => inspect(b, i + 1)));
  const layout = computeLayout(sizes, params);
  // Превью готовятся параллельно и завершаются в любом порядке, но Promise.all
  // возвращает массив в исходном порядке, а координаты уже посчитаны по номеру входа.
  const thumbs = await Promise.all(layout.items.map((item, i) => makeThumb(buffers[i], item, i + 1)));
  const png = await sharp({
    create: { width: layout.sheetWidth, height: layout.sheetHeight, channels: 3, background: WHITE },
  })
    .composite(thumbs.map((input, i) => ({ input, left: layout.items[i].x, top: layout.items[i].y })))
    .png()
    .toBuffer();
  const layoutJson = {
    topic: '01',
    sheet: { width: layout.sheetWidth, height: layout.sheetHeight },
    grid: {
      columns: layout.columns,
      rows: layout.rows,
      cellWidth: layout.cellWidth,
      cellHeight: layout.cellHeight,
      gap: layout.gap,
    },
    items: layout.items.map((item, i) => ({
      input: item.input,
      name: names[i] ?? null,
      sourceWidth: sizes[i].width,
      sourceHeight: sizes[i].height,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    })),
  };
  return { png, layout: layoutJson };
}
