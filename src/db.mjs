// Работа с SQLite через встроенный модуль node:sqlite.
// В БД хранятся только сведения о заданиях; сами файлы лежат в каталогах на диске.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- порядковый номер приёма
  id            TEXT NOT NULL UNIQUE,               -- UUID, виден пользователю
  state         TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed')),
  params        TEXT NOT NULL,                      -- JSON параметров темы
  created_at    TEXT NOT NULL,                      -- время в UTC, ISO 8601
  started_at    TEXT,
  finished_at   TEXT,
  error_code    TEXT,
  error_message TEXT,
  child_pid     INTEGER,                            -- PID дочернего процесса обработки
  results       TEXT NOT NULL DEFAULT '[]',         -- JSON [{name,size}]
  summary       TEXT                                -- JSON с итогами обработки
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (state, created_at, seq);

CREATE TABLE IF NOT EXISTS job_inputs (
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  position      INTEGER NOT NULL,                   -- 1, 2, 3 ... порядок загрузки
  original_name TEXT NOT NULL,                      -- имя от пользователя, только подпись
  stored_name   TEXT NOT NULL,                      -- имя на диске, создаёт сервер
  size          INTEGER NOT NULL,
  PRIMARY KEY (job_id, position)
);
`;

export function openDb() {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, 'filelab.db'));
  db.exec('PRAGMA journal_mode = WAL');   // чтение не блокируется записью
  db.exec('PRAGMA busy_timeout = 5000');  // ждать до 5 с, если БД занята другим процессом
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// Выполнить fn внутри короткой транзакции. BEGIN IMMEDIATE сразу берёт блокировку
// записи, поэтому два процесса не могут одновременно забрать одно задание.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Описание задания в формате общего API.
export function describeJob(db, row) {
  const inputs = db
    .prepare('SELECT position, original_name, size FROM job_inputs WHERE job_id = ? ORDER BY position')
    .all(row.id)
    .map((i) => ({ position: i.position, name: i.original_name, size: i.size }));
  const results = row.state === 'succeeded' ? JSON.parse(row.results) : [];
  return {
    id: row.id,
    state: row.state,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    results: results.map((r) => ({
      name: r.name,
      size: r.size,
      url: `/api/jobs/${row.id}/results/${encodeURIComponent(r.name)}`,
    })),
    params: JSON.parse(row.params),
    inputs,
    summary: row.summary ? JSON.parse(row.summary) : null,
  };
}
