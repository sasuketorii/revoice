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

const nowISO = () => new Date().toISOString();

const DEFAULT_RETENTION_POLICY = Object.freeze({
  mode: 'recommended', // 'recommended' | 'custom'
  maxDays: 90,
  maxEntries: 200,
  schedule: {
    type: 'interval', // 'interval' | 'startup'
    preset: '12h',
    intervalHours: 12,
  },
});

const normalizePositiveInteger = (value) => {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

const normalizeRetentionPolicy = (raw) => {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RETENTION_POLICY };
  const mode = raw.mode === 'custom' ? 'custom' : 'recommended';
  const maxDays = mode === 'recommended' ? DEFAULT_RETENTION_POLICY.maxDays : normalizePositiveInteger(raw.maxDays) ?? null;
  const maxEntries = mode === 'recommended' ? DEFAULT_RETENTION_POLICY.maxEntries : normalizePositiveInteger(raw.maxEntries) ?? null;

  const scheduleRaw = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
  let scheduleType = scheduleRaw.type === 'startup' ? 'startup' : 'interval';
  let preset = null;
  let intervalHours = null;

  if (scheduleType === 'interval') {
    const presets = new Map([
      ['12h', 12],
      ['24h', 24],
    ]);
    if (typeof scheduleRaw.preset === 'string' && presets.has(scheduleRaw.preset)) {
      preset = scheduleRaw.preset;
      intervalHours = presets.get(scheduleRaw.preset);
    } else {
      const normalizedInterval = normalizePositiveInteger(scheduleRaw.intervalHours);
      if (normalizedInterval && normalizedInterval >= 1 && normalizedInterval <= 72) {
        intervalHours = normalizedInterval;
      } else {
        intervalHours = DEFAULT_RETENTION_POLICY.schedule.intervalHours;
        preset = DEFAULT_RETENTION_POLICY.schedule.preset;
      }
    }
  } else {
    preset = 'startup';
    intervalHours = null;
  }

  return {
    mode,
    maxDays: mode === 'recommended' ? DEFAULT_RETENTION_POLICY.maxDays : maxDays,
    maxEntries: mode === 'recommended' ? DEFAULT_RETENTION_POLICY.maxEntries : maxEntries,
    schedule: {
      type: scheduleType,
      preset: scheduleType === 'startup' ? 'startup' : preset,
      intervalHours: scheduleType === 'startup' ? null : intervalHours,
    },
  };
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
          notes TEXT,
          transcript_full TEXT
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

  if (userVersion < 2) {
    const migrateToV2 = db.transaction(() => {
      db.exec('ALTER TABLE transcriptions ADD COLUMN transcript_full TEXT;');
      db.pragma('user_version = 2');
    });
    try {
      migrateToV2();
    } catch (err) {
      console.error('Failed to migrate history storage to v2', err);
    }
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
    transcriptFull: row.transcriptFull ?? null,
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

const getSetting = (key) => {
  const db = ensureInitialized();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return row.value ? JSON.parse(row.value) : null;
  } catch (err) {
    return null;
  }
};

const setSetting = (key, value) => {
  const db = ensureInitialized();
  const payload = value === undefined ? null : value;
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  stmt.run({ key, value: payload === null ? null : JSON.stringify(payload), updatedAt: nowISO() });
};

const getRetentionPolicy = () => {
  const raw = getSetting('historyRetentionPolicy');
  return normalizeRetentionPolicy(raw);
};

const setRetentionPolicy = (policy) => {
  const normalized = normalizeRetentionPolicy(policy);
  setSetting('historyRetentionPolicy', normalized);
  return normalized;
};

const OUTPUT_STYLE_OPTIONS = new Set(['timestamps', 'plain']);

const getTranscriptionOutputStyle = () => {
  const raw = getSetting('transcriptionOutputStyle');
  if (typeof raw === 'string' && OUTPUT_STYLE_OPTIONS.has(raw)) {
    return raw;
  }
  return 'plain';
};

const setTranscriptionOutputStyle = (style) => {
  const next = typeof style === 'string' && OUTPUT_STYLE_OPTIONS.has(style) ? style : 'plain';
  setSetting('transcriptionOutputStyle', next);
  return next;
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
      notes,
      transcript_full
    ) VALUES (@inputPath, @outputPath, @transcriptPreview, @model, @language, @createdAt, @duration, @status, @notes, @transcriptFull)
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
    transcriptFull: entry.transcript ?? null,
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
    transcriptFull: entry.transcript ?? null,
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
      notes,
      transcript_full AS transcriptFull
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
      notes,
      transcript_full AS transcriptFull
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

const pruneExceedingCount = (maxEntries) => {
  const db = ensureInitialized();
  const numericLimit = normalizePositiveInteger(maxEntries);
  if (!numericLimit) return { changes: 0 };
  const stmt = db.prepare(`
    DELETE FROM transcriptions
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY datetime(created_at) DESC, id DESC) AS rn
        FROM transcriptions
      ) ranked
      WHERE rn > @limit
    )
  `);
  const result = stmt.run({ limit: numericLimit });
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
  pruneExceedingCount,
  getDatabaseFilePath,
  generatePreview,
  getSetting,
  setSetting,
  getRetentionPolicy,
  setRetentionPolicy,
  DEFAULT_RETENTION_POLICY,
  getTranscriptionOutputStyle,
  setTranscriptionOutputStyle,
};
