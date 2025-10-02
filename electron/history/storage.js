const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let dbInstance = null;
let dbFilePath = null;

const PREVIEW_MAX_LENGTH = 400;

const ensureInitialized = () => {
  if (!dbInstance) {
    throw new Error('History storage has not been initialized yet.');
  }
  return dbInstance;
};

const resolveUserDataDir = (app) => {
  const dirName = app.isPackaged ? 'Revoice' : 'Revoice-dev';
  const base = app.getPath('appData');
  const target = path.join(base, dirName);
  app.setPath('userData', target);
  const resolved = app.getPath('userData');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
};

const applyMigrations = (db) => {
  const userVersion = db.pragma('user_version', { simple: true });

  if (userVersion < 1) {
    const migrateToV1 = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY,
          input_path TEXT,
          output_path TEXT,
          transcript_preview TEXT,
          model TEXT,
          language TEXT,
          created_at TEXT NOT NULL,
          duration REAL,
          status TEXT,
          notes TEXT
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions(created_at);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transcriptions_status ON transcriptions(status);');

      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TEXT
        );
      `);

      db.pragma('user_version = 1');
    });
    migrateToV1();
  }
};

const generatePreview = (text) => {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, PREVIEW_MAX_LENGTH)}…`;
};

const recordFromRow = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    inputPath: row.inputPath ?? null,
    outputPath: row.outputPath ?? null,
    transcriptPreview: row.transcriptPreview ?? '',
    model: row.model ?? null,
    language: row.language ?? null,
    createdAt: row.createdAt,
    duration: typeof row.duration === 'number' ? row.duration : row.duration === null ? null : Number(row.duration),
    status: row.status ?? null,
    notes: row.notes ?? null,
  };
};

const initialize = (app) => {
  if (dbInstance) {
    return { db: dbInstance, path: dbFilePath };
  }
  const userDataDir = resolveUserDataDir(app);
  dbFilePath = path.join(userDataDir, 'history.db');
  dbInstance = new Database(dbFilePath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  applyMigrations(dbInstance);
  return { db: dbInstance, path: dbFilePath };
};

const storeTranscription = (entry) => {
  const db = ensureInitialized();
  const now = entry.createdAt || new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO transcriptions (
      input_path,
      output_path,
      transcript_preview,
      model,
      language,
      created_at,
      duration,
      status,
      notes
    ) VALUES (@inputPath, @outputPath, @transcriptPreview, @model, @language, @createdAt, @duration, @status, @notes)
  `);

  const transcriptPreview = entry.transcriptPreview ?? generatePreview(entry.transcript ?? entry.transcriptPreview ?? '');

  const runResult = stmt.run({
    inputPath: entry.inputPath ?? null,
    outputPath: entry.outputPath ?? null,
    transcriptPreview,
    model: entry.model ?? null,
    language: entry.language ?? null,
    createdAt: now,
    duration: typeof entry.duration === 'number' ? entry.duration : null,
    status: entry.status ?? 'completed',
    notes: entry.notes ?? null,
  });

  return {
    id: Number(runResult.lastInsertRowid),
    inputPath: entry.inputPath ?? null,
    outputPath: entry.outputPath ?? null,
    transcriptPreview,
    model: entry.model ?? null,
    language: entry.language ?? null,
    createdAt: now,
    duration: typeof entry.duration === 'number' ? entry.duration : null,
    status: entry.status ?? 'completed',
    notes: entry.notes ?? null,
  };
};

const listTranscriptions = ({ limit = 20, offset = 0 } = {}) => {
  const db = ensureInitialized();
  const stmt = db.prepare(`
    SELECT
      id,
      input_path AS inputPath,
      output_path AS outputPath,
      transcript_preview AS transcriptPreview,
      model,
      language,
      created_at AS createdAt,
      duration,
      status,
      notes
    FROM transcriptions
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT @limit OFFSET @offset
  `);
  return stmt.all({ limit, offset }).map(recordFromRow);
};

const countTranscriptions = () => {
  const db = ensureInitialized();
  const row = db.prepare('SELECT COUNT(*) AS total FROM transcriptions').get();
  return Number(row?.total ?? 0);
};

const getTranscription = (id) => {
  const db = ensureInitialized();
  const stmt = db.prepare(`
    SELECT
      id,
      input_path AS inputPath,
      output_path AS outputPath,
      transcript_preview AS transcriptPreview,
      model,
      language,
      created_at AS createdAt,
      duration,
      status,
      notes
    FROM transcriptions
    WHERE id = @id
  `);
  return recordFromRow(stmt.get({ id }));
};

const clearAll = () => {
  const db = ensureInitialized();
  const stmt = db.prepare('DELETE FROM transcriptions');
  const result = stmt.run();
  return { changes: result.changes };
};

const deleteByIds = (ids) => {
  const db = ensureInitialized();
  if (!Array.isArray(ids) || ids.length === 0) {
    return { changes: 0 };
  }
  const stmt = db.prepare(`DELETE FROM transcriptions WHERE id IN (${ids.map(() => '?').join(',')})`);
  const result = stmt.run(ids);
  return { changes: result.changes };
};

const pruneBeforeISO = (isoString) => {
  if (!isoString) return { changes: 0 };
  const db = ensureInitialized();
  const stmt = db.prepare('DELETE FROM transcriptions WHERE datetime(created_at) < datetime(?)');
  const result = stmt.run(isoString);
  return { changes: result.changes };
};

const getDatabaseFilePath = () => dbFilePath;

module.exports = {
  initialize,
  storeTranscription,
  listTranscriptions,
  countTranscriptions,
  getTranscription,
  clearAll,
  deleteByIds,
  pruneBeforeISO,
  getDatabaseFilePath,
  generatePreview,
};
