// Сервер API. Принимает файлы, создаёт задание и сразу отвечает 202.
// Саму обработку здесь НЕ выполняем: её забирает отдельный процесс worker.mjs.
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { config, limits, jobDir, log, appDir } from './src/config.mjs';
import { openDb, transaction, describeJob } from './src/db.mjs';
import { parseParams, ParamsError } from './src/params.mjs';

const db = openDb();
const app = express();
app.disable('x-powered-by');
// При разработке страницу отдаёт сам Node; на сервере её отдаёт Nginx из /var/www/filelab.
if (process.env.NODE_ENV !== 'production') app.use(express.static(path.join(appDir, 'public')));

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

// Перед разбором формы создаём номер задания и его каталог.
function prepareJob(req, res, next) {
  req.jobId = randomUUID();
  req.fileCounter = 0;
  mkdirSync(path.join(jobDir(req.jobId), 'input'), { recursive: true });
  next();
}

// Multer сохраняет файлы сразу на диск под НАШИМИ именами 01.png, 02.png ...
// Имя от пользователя (originalname) не участвует в пути.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(jobDir(req.jobId), 'input')),
    filename: (req, file, cb) => {
      req.fileCounter += 1;
      cb(null, `${String(req.fileCounter).padStart(2, '0')}.png`);
    },
  }),
  limits: {
    files: limits.maxFiles,
    fileSize: limits.maxFileBytes,
    fields: 5,
    fieldSize: 10_000,
    parts: limits.maxFiles + 5,
  },
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: config.version, topic: config.topic });
});

app.post('/api/jobs', prepareJob, upload.array('files', limits.maxFiles), (req, res) => {
  const id = req.jobId;
  const files = req.files ?? [];
  try {
    const params = parseParams(req.body?.params);
    if (files.length === 0) throw new ParamsError('Выберите хотя бы один файл');
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (total > limits.maxTotalBytes) {
      rmSync(jobDir(id), { recursive: true, force: true });
      log('job_rejected', { jobId: id, reason: 'total_too_large', bytes: total });
      return sendError(res, 413, 'too_large', 'Суммарный размер файлов больше 50 MiB');
    }
    const createdAt = new Date().toISOString();
    transaction(db, () => {
      db.prepare("INSERT INTO jobs (id, state, params, created_at) VALUES (?, 'queued', ?, ?)")
        .run(id, JSON.stringify(params), createdAt);
      const insert = db.prepare(
        'INSERT INTO job_inputs (job_id, position, original_name, stored_name, size) VALUES (?, ?, ?, ?, ?)');
      files.forEach((f, i) => insert.run(id, i + 1, cleanName(f.originalname), f.filename, f.size));
    });
    log('job_accepted', { jobId: id, files: files.length, bytes: total, params });
    res.status(202).json({ id, state: 'queued' });
  } catch (error) {
    rmSync(jobDir(id), { recursive: true, force: true });
    if (error instanceof ParamsError) {
      log('job_rejected', { jobId: id, reason: 'invalid_params', message: error.message });
      return sendError(res, 400, 'invalid_params', error.message);
    }
    throw error;
  }
});

app.get('/api/jobs', (req, res) => {
  const rows = db.prepare('SELECT * FROM jobs ORDER BY seq DESC LIMIT 100').all();
  res.json({ jobs: rows.map((row) => describeJob(db, row)) });
});

app.get('/api/jobs/:id', (req, res) => {
  const row = findJob(req.params.id);
  if (!row) return sendError(res, 404, 'not_found', 'Задание не найдено');
  res.json(describeJob(db, row));
});

app.get('/api/jobs/:id/results/:name', (req, res) => {
  const row = findJob(req.params.id);
  if (!row) return sendError(res, 404, 'not_found', 'Задание не найдено');
  if (row.state !== 'succeeded') return sendError(res, 409, 'not_ready', 'Результат ещё не готов');
  // Отдаём только файлы из списка результатов этого задания.
  const known = JSON.parse(row.results).find((r) => r.name === req.params.name);
  if (!known) return sendError(res, 404, 'not_found', 'Такого результата нет');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(known.name, { root: path.join(jobDir(row.id), 'results'), dotfiles: 'deny' });
});

// Ошибки загрузки: превышение размера — 413, прочие нарушения формы — 400.
app.use((err, req, res, next) => {
  if (req.jobId) rmSync(jobDir(req.jobId), { recursive: true, force: true });
  if (err instanceof multer.MulterError) {
    log('job_rejected', { jobId: req.jobId, reason: err.code });
    if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 413, 'too_large', 'Файл больше 10 MiB');
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return sendError(res, 400, 'too_many_files', 'Можно загрузить от 1 до 10 файлов в поле files');
    }
    return sendError(res, 400, 'bad_form', 'Неправильная форма загрузки');
  }
  log('api_error', { message: String(err?.message || err) });
  sendError(res, 500, 'internal_error', 'Внутренняя ошибка сервера');
});

function findJob(id) {
  if (!ID_RE.test(id)) return undefined;
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

// Подпись файла: только для показа пользователю, обрезаем управляющие символы и длину.
function cleanName(name) {
  const fixed = Buffer.from(name, 'latin1').toString('utf8');
  const chosen = fixed.includes('�') ? name : fixed;
  return chosen.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'file.png';
}

const server = app.listen(config.port, config.host, () => {
  log('api_started', { host: config.host, port: config.port, version: config.version, dataDir: config.dataDir });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log('api_stopping', { signal });
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
