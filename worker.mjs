// Обработчик очереди. Отдельная служба: берёт задания из SQLite и на каждое
// запускает дочерний процесс process-job.mjs. Не больше MAX_CONCURRENT_JOBS одновременно.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { config, appDir, jobDir, log } from './src/config.mjs';
import { openDb, transaction } from './src/db.mjs';

const db = openDb();
const running = new Map(); // id задания -> дочерний процесс
let stopping = false;

const now = () => new Date().toISOString();

// 1. Восстановление после сбоя: задания, которые были running, когда обработчик
//    упал, переводим в failed с кодом interrupted. Сначала убеждаемся, что их
//    дочерние процессы точно завершены.
function recoverInterrupted() {
  const rows = db.prepare("SELECT id, child_pid FROM jobs WHERE state = 'running'").all();
  for (const row of rows) {
    if (row.child_pid && isOurChildAlive(row.child_pid)) {
      try { process.kill(row.child_pid, 'SIGKILL'); } catch {}
      log('orphan_killed', { jobId: row.id, childPid: row.child_pid });
    }
    db.prepare(`UPDATE jobs SET state = 'failed', finished_at = ?, error_code = 'interrupted',
                error_message = 'Обработка прервана: обработчик был остановлен аварийно. Отправьте файлы заново.'
                WHERE id = ? AND state = 'running'`).run(now(), row.id);
    rm(path.join(jobDir(row.id), 'output.tmp'), { recursive: true, force: true }).catch(() => {});
    log('job_interrupted', { jobId: row.id });
  }
}

function isOurChildAlive(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('process-job.mjs');
  } catch {
    return false; // процесса нет
  }
}

// 2. Атомарно забрать самое старое задание из очереди. Транзакция короткая:
//    только выбор и смена состояния, без обработки файла.
function claimNext() {
  return transaction(db, () => {
    const row = db.prepare(
      "SELECT id, params FROM jobs WHERE state = 'queued' ORDER BY created_at, seq LIMIT 1").get();
    if (!row) return null;
    const changed = db.prepare(
      "UPDATE jobs SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'")
      .run(now(), row.id);
    return changed.changes === 1 ? row : null;
  });
}

// 3. Запустить дочерний процесс для задания.
function startJob(job) {
  const names = db.prepare('SELECT original_name FROM job_inputs WHERE job_id = ? ORDER BY position')
    .all(job.id).map((r) => r.original_name);
  const child = spawn(
    process.execPath,
    [path.join(appDir, 'process-job.mjs'), jobDir(job.id), job.params, JSON.stringify(names)],
    { cwd: jobDir(job.id), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }, // без shell
  );
  running.set(job.id, child);
  db.prepare('UPDATE jobs SET child_pid = ? WHERE id = ?').run(child.pid, job.id);
  log('job_started', { jobId: job.id, childPid: child.pid, running: running.size });

  let stdout = '';
  child.stdout.on('data', (chunk) => { if (stdout.length < 10_000) stdout += chunk; });
  child.stderr.on('data', (chunk) => log('job_stderr', { jobId: job.id, text: String(chunk).slice(0, 500) }));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log('job_timeout', { jobId: job.id, childPid: child.pid, limitMs: config.jobTimeoutMs });
    child.kill('SIGKILL');
  }, config.jobTimeoutMs);

  child.on('close', async (code, signal) => {
    clearTimeout(timer);
    running.delete(job.id);
    try {
      await finishJob(job.id, { code, signal, timedOut, stdout });
    } catch (error) {
      log('worker_error', { jobId: job.id, message: String(error?.message || error) });
    }
  });
}

// 4. Записать итог. Успех объявляем только если каталог results действительно есть.
async function finishJob(id, { code, signal, timedOut, stdout }) {
  const last = stdout.trim().split('\n').pop() || '{}';
  let report = {};
  try { report = JSON.parse(last); } catch {}

  if (timedOut) return fail(id, 'timeout', `Обработка дольше ${config.jobTimeoutMs / 1000} с остановлена`);
  // Процесс убит сигналом (например, systemctl stop или kill) — работа прервана.
  if (signal) return fail(id, 'interrupted', `Обработка прервана сигналом ${signal}`);

  if (code === 0 && report.ok) {
    const outDir = path.join(jobDir(id), 'results');
    const names = (await readdir(outDir)).sort();
    const results = [];
    for (const name of names) results.push({ name, size: (await stat(path.join(outDir, name))).size });
    db.prepare(`UPDATE jobs SET state = 'succeeded', finished_at = ?, results = ?, summary = ?
                WHERE id = ? AND state = 'running'`)
      .run(now(), JSON.stringify(results), JSON.stringify(report.summary ?? null), id);
    log('job_succeeded', { jobId: id, results: names });
    return;
  }
  if (code === 3) return fail(id, report.code || 'invalid_input', report.message || 'Непригодный вход');
  return fail(id, 'processing_error', `Обработка завершилась с ошибкой (код ${code}, сигнал ${signal})`);
}

function fail(id, code, message) {
  db.prepare(`UPDATE jobs SET state = 'failed', finished_at = ?, error_code = ?, error_message = ?
              WHERE id = ? AND state = 'running'`).run(now(), code, message, id);
  rm(path.join(jobDir(id), 'output.tmp'), { recursive: true, force: true }).catch(() => {});
  log('job_failed', { jobId: id, code, message });
}

// 5. Главный цикл: пока есть свободные места — забираем задания.
function tick() {
  if (stopping) return;
  try {
    while (running.size < config.maxConcurrentJobs) {
      const job = claimNext();
      if (!job) break;
      startJob(job);
    }
  } catch (error) {
    // Например, SQLITE_BUSY: БД занята дольше busy_timeout. Повторим на следующем тике.
    log('claim_error', { message: String(error?.message || error) });
  }
}

recoverInterrupted();
log('worker_started', { maxConcurrentJobs: config.maxConcurrentJobs, timeoutMs: config.jobTimeoutMs,
  testDelayMs: config.testDelayMs, version: config.version });
const loop = setInterval(tick, config.pollIntervalMs);
tick();

// 6. Штатная остановка (systemctl stop): новые задания не берём, текущим даём
//    до 10 с, потом прерываем и честно помечаем interrupted.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(loop);
    log('worker_stopping', { signal, running: [...running.keys()] });
    const deadline = setTimeout(() => {
      for (const child of running.values()) child.kill('SIGKILL');
    }, 10_000);
    const waitAll = setInterval(() => {
      if (running.size === 0) {
        clearInterval(waitAll);
        clearTimeout(deadline);
        db.close();
        process.exit(0);
      }
    }, 100);
  });
}
