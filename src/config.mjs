// Общие настройки сервера и обработчика. Значения берутся из /etc/filelab.env
// (systemd передаёт их как переменные окружения), иначе — значения для разработки.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(here, '..');

function readVersion() {
  try {
    return readFileSync(path.join(appDir, 'VERSION'), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
}

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} должен быть целым от ${min} до ${max}, получено: ${raw}`);
  }
  return value;
}

export const config = {
  topic: '01',
  version: readVersion(),
  host: process.env.HOST || '127.0.0.1',
  port: intFromEnv('PORT', 3000, 1, 65535),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(appDir, 'data')),
  maxConcurrentJobs: intFromEnv('MAX_CONCURRENT_JOBS', 1, 1, 8),
  jobTimeoutMs: intFromEnv('JOB_TIMEOUT_MS', 120_000, 1_000, 600_000),
  // Только для испытаний очереди: искусственная пауза перед обработкой.
  testDelayMs: intFromEnv('TEST_DELAY_MS', 0, 0, 10_000),
  pollIntervalMs: 500,
};

export const limits = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,   // 10 MiB
  maxTotalBytes: 50 * 1024 * 1024,  // 50 MiB
  maxPixels: 4_000_000,
};

export const jobsDir = () => path.join(config.dataDir, 'jobs');
export const jobDir = (id) => path.join(jobsDir(), id);

// Единая запись журнала: одна строка JSON в stdout, её собирает journald.
export function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, pid: process.pid, ...fields }));
}
