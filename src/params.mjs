// Проверка параметров темы 01. Вызывается сервером при приёме задания (ответ 400)
// и ещё раз обработчиком, чтобы дочерний процесс не доверял чужим данным.
export class ParamsError extends Error {}

const RULES = {
  columns: { min: 1, max: 5, integer: true },
  cellWidth: { min: 4, max: 256, integer: true },
  cellHeight: { min: 4, max: 256, integer: true },
  gap: { min: 0, max: 20, integer: false }, // нецелый отступ допустим и округляется вниз
};

export function parseParams(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ParamsError('Поле params обязательно и должно содержать JSON');
  }
  if (text.length > 1000) throw new ParamsError('Поле params слишком длинное');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ParamsError('Поле params не является корректным JSON');
  }
  return validateParams(value);
}

export function validateParams(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ParamsError('params должен быть JSON-объектом');
  }
  for (const key of Object.keys(value)) {
    if (!(key in RULES)) throw new ParamsError(`Неизвестный параметр: ${key}`);
  }
  const result = {};
  for (const [key, rule] of Object.entries(RULES)) {
    const v = value[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ParamsError(`${key} обязателен и должен быть числом`);
    }
    if (rule.integer && !Number.isInteger(v)) {
      throw new ParamsError(`${key} должен быть целым числом`);
    }
    if (v < rule.min || v > rule.max) {
      throw new ParamsError(`${key} должен быть от ${rule.min} до ${rule.max}`);
    }
    result[key] = v;
  }
  result.gap = Math.floor(result.gap);
  return result;
}
