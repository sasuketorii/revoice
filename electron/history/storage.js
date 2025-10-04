const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

let dbInstance = null;
let dbFilePath = null;

const PREVIEW_MAX_LENGTH = 400;
const JOB_STATUS_OPTIONS = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

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

const DEFAULT_CONVERSION_PRESET = Object.freeze({
  format: 'aac',
  bitrateKbps: 128,
  sampleRate: 16000,
  channels: 1,
});

const DEFAULT_CONVERSION_SETTINGS = Object.freeze({
  outputDir: null,
  defaultPreset: DEFAULT_CONVERSION_PRESET,
  maxParallelJobs: 2,
  autoCreateTranscribeTab: false,
  ffmpegPath: null,
});

const CONVERSION_FORMATS = new Set(['aac', 'flac', 'ogg', 'wav']);
const CONVERSION_SAMPLE_RATES = new Set([16000, 24000, 44100]);
const CONVERSION_CHANNELS = new Set([1, 2]);
const CONVERSION_BITRATES = new Set([64, 128, 192]);
const CONVERSION_SETTINGS_KEY = 'conversion';

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

const normalizeConversionBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return fallback;
};

const normalizeConversionPreset = (raw) => {
  const base = {
    format: DEFAULT_CONVERSION_PRESET.format,
    bitrateKbps: DEFAULT_CONVERSION_PRESET.bitrateKbps,
    sampleRate: DEFAULT_CONVERSION_PRESET.sampleRate,
    channels: DEFAULT_CONVERSION_PRESET.channels,
  };
  if (!raw || typeof raw !== 'object') {
    return base;
  }

  if (typeof raw.format === 'string') {
    const next = raw.format.trim().toLowerCase();
    if (CONVERSION_FORMATS.has(next)) {
      base.format = next;
    }
  }

  const bitrate = Number(raw.bitrateKbps);
  if (Number.isFinite(bitrate) && CONVERSION_BITRATES.has(Math.floor(bitrate))) {
    base.bitrateKbps = Math.floor(bitrate);
  }

  const sampleRate = Number(raw.sampleRate);
  if (Number.isFinite(sampleRate) && CONVERSION_SAMPLE_RATES.has(Math.floor(sampleRate))) {
    base.sampleRate = Math.floor(sampleRate);
  }

  const channels = Number(raw.channels);
  if (Number.isFinite(channels) && CONVERSION_CHANNELS.has(Math.floor(channels))) {
    base.channels = Math.floor(channels);
  }

  return base;
};

const normalizeConversionSettings = (raw) => {
  const base = {
    outputDir: null,
    defaultPreset: normalizeConversionPreset(raw?.defaultPreset),
    maxParallelJobs: DEFAULT_CONVERSION_SETTINGS.maxParallelJobs,
    autoCreateTranscribeTab: DEFAULT_CONVERSION_SETTINGS.autoCreateTranscribeTab,
    ffmpegPath: DEFAULT_CONVERSION_SETTINGS.ffmpegPath,
  };

  if (raw && typeof raw === 'object') {
    if (typeof raw.outputDir === 'string') {
      const trimmed = raw.outputDir.trim();
      base.outputDir = trimmed.length > 0 ? trimmed : null;
    }

    const maxParallel = Number(raw.maxParallelJobs);
    if (Number.isFinite(maxParallel)) {
      const normalized = Math.max(1, Math.min(8, Math.floor(maxParallel)));
      base.maxParallelJobs = normalized;
    }

    base.autoCreateTranscribeTab = normalizeConversionBoolean(
      raw.autoCreateTranscribeTab,
      DEFAULT_CONVERSION_SETTINGS.autoCreateTranscribeTab
    );

    if (typeof raw.ffmpegPath === 'string') {
      const trimmedPath = raw.ffmpegPath.trim();
      base.ffmpegPath = trimmedPath.length > 0 ? trimmedPath : null;
    }
  }

  return base;
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

  if (userVersion < 3) {
    const migrateToV3 = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_profiles (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          engine TEXT NOT NULL,
          params TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_model_profiles_label ON model_profiles(label);');
      db.pragma('user_version = 3');
    });
    try {
      migrateToV3();
    } catch (err) {
      console.error('Failed to migrate history storage to v3', err);
    }
  }

  if (userVersion < 4) {
    const migrateToV4 = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          tab_id TEXT,
          type TEXT,
          status TEXT NOT NULL,
          input_path TEXT,
          output_path TEXT,
          params TEXT,
          result_path TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          metadata TEXT
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, datetime(created_at));');

      db.exec(`
        CREATE TABLE IF NOT EXISTS job_events (
          event_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          event TEXT NOT NULL,
          payload TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, datetime(created_at));');

      db.exec(`
        CREATE TABLE IF NOT EXISTS tabs (
          id TEXT PRIMARY KEY,
          title TEXT,
          job_id TEXT,
          state TEXT,
          meta TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_opened_at TEXT
        );
      `);

      db.pragma('user_version = 4');
    });
    try {
      migrateToV4();
    } catch (err) {
      console.error('Failed to migrate history storage to v4', err);
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

const normalizeHistoryNotes = (notes) => {
  if (notes === null || notes === undefined) return null;
  if (typeof notes === 'string') {
    const trimmed = notes.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(parsed);
      }
      return JSON.stringify({ message: parsed });
    } catch (_) {
      return JSON.stringify({ message: trimmed });
    }
    return JSON.stringify({ message: trimmed });
  }
  if (typeof notes === 'object') {
    try {
      return JSON.stringify(notes);
    } catch (_) {
      return null;
    }
  }
  if (typeof notes === 'number' || typeof notes === 'boolean') {
    return JSON.stringify({ message: String(notes) });
  }
  return JSON.stringify({ message: String(notes) });
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

const safeParseJson = (raw, fallback) => {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
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

const getConversionSettings = () => {
  const raw = getSetting(CONVERSION_SETTINGS_KEY);
  return normalizeConversionSettings(raw);
};

const setConversionSettings = (payload) => {
  const normalized = normalizeConversionSettings(payload);
  setSetting(CONVERSION_SETTINGS_KEY, normalized);
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
  const normalizedNotes = normalizeHistoryNotes(entry.notes);

  const runResult = stmt.run({
    inputPath: entry.inputPath ?? null,
    outputPath: entry.outputPath ?? null,
    transcriptPreview,
    model: entry.model ?? null,
    language: entry.language ?? null,
    createdAt: now,
    duration: typeof entry.duration === 'number' ? entry.duration : null,
    status: entry.status ?? 'completed',
    notes: normalizedNotes,
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
    notes: normalizedNotes,
    transcriptFull: entry.transcript ?? null,
  };
};

const jobFromRow = (row) => {
  if (!row) return null;
  const params = safeParseJson(row.params, {});
  const metadata = safeParseJson(row.metadata, {});
  return {
    id: row.id,
    tabId: row.tabId ?? null,
    type: row.type ?? null,
    status: row.status,
    inputPath: row.inputPath ?? null,
    outputPath: row.outputPath ?? null,
    params,
    resultPath: row.resultPath ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    metadata,
  };
};

const jobEventFromRow = (row) => {
  if (!row) return null;
  return {
    eventId: row.eventId,
    jobId: row.jobId,
    event: row.event,
    payload: safeParseJson(row.payload, null),
    createdAt: row.createdAt,
  };
};

const tabFromRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? 'タブ',
    jobId: row.jobId ?? null,
    state: row.state ?? null,
    meta: safeParseJson(row.meta, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt ?? null,
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

const assertJobStatus = (status) => {
  if (!JOB_STATUS_OPTIONS.has(status)) {
    throw new Error(`Unsupported job status: ${status}`);
  }
};

const createJobRecord = (job) => {
  const db = ensureInitialized();
  const now = nowISO();
  const id = job?.id && typeof job.id === 'string' ? job.id : randomUUID();
  const status = job?.status ?? 'queued';
  assertJobStatus(status);
  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, tab_id, type, status, input_path, output_path, params,
      result_path, error, created_at, updated_at, started_at, finished_at, metadata
    ) VALUES (
      @id, @tabId, @type, @status, @inputPath, @outputPath, @params,
      @resultPath, @error, @createdAt, @updatedAt, @startedAt, @finishedAt, @metadata
    )
  `);
  stmt.run({
    id,
    tabId: job?.tabId ?? null,
    type: job?.type ?? 'transcription',
    status,
    inputPath: job?.inputPath ?? null,
    outputPath: job?.outputPath ?? null,
    params: job?.params ? JSON.stringify(job.params) : null,
    resultPath: job?.resultPath ?? null,
    error: job?.error ?? null,
    createdAt: job?.createdAt ?? now,
    updatedAt: job?.updatedAt ?? now,
    startedAt: job?.startedAt ?? null,
    finishedAt: job?.finishedAt ?? null,
    metadata: job?.metadata ? JSON.stringify(job.metadata) : null,
  });
  return getJobRecord(id);
};

const getJobRecord = (id) => {
  const db = ensureInitialized();
  const stmt = db.prepare(`
    SELECT
      id,
      tab_id AS tabId,
      type,
      status,
      input_path AS inputPath,
      output_path AS outputPath,
      params,
      result_path AS resultPath,
      error,
      created_at AS createdAt,
      updated_at AS updatedAt,
      started_at AS startedAt,
      finished_at AS finishedAt,
      metadata
    FROM jobs
    WHERE id = @id
  `);
  return jobFromRow(stmt.get({ id }));
};

const updateJobRecord = (id, patch = {}) => {
  const db = ensureInitialized();
  const existing = getJobRecord(id);
  if (!existing) return null;
  const nextStatus = patch.status ?? existing.status;
  assertJobStatus(nextStatus);
  const stmt = db.prepare(`
    UPDATE jobs
    SET tab_id = @tabId,
        type = @type,
        status = @status,
        input_path = @inputPath,
        output_path = @outputPath,
        params = @params,
        result_path = @resultPath,
        error = @error,
        created_at = @createdAt,
        updated_at = @updatedAt,
        started_at = @startedAt,
        finished_at = @finishedAt,
        metadata = @metadata
    WHERE id = @id
  `);
  stmt.run({
    id,
    tabId: patch.tabId ?? existing.tabId ?? null,
    type: patch.type ?? existing.type ?? 'transcription',
    status: nextStatus,
    inputPath: patch.inputPath ?? existing.inputPath ?? null,
    outputPath: patch.outputPath ?? existing.outputPath ?? null,
    params: patch.params ? JSON.stringify(patch.params) : existing.params ? JSON.stringify(existing.params) : null,
    resultPath: patch.resultPath ?? existing.resultPath ?? null,
    error: patch.error ?? existing.error ?? null,
    createdAt: patch.createdAt ?? existing.createdAt ?? nowISO(),
    updatedAt: patch.updatedAt ?? nowISO(),
    startedAt: patch.startedAt ?? existing.startedAt ?? null,
    finishedAt: patch.finishedAt ?? existing.finishedAt ?? null,
    metadata: patch.metadata ? JSON.stringify(patch.metadata) : existing.metadata ? JSON.stringify(existing.metadata) : null,
  });
  return getJobRecord(id);
};

const listJobs = ({ limit = 100, offset = 0, status = null, type = null, order = 'asc' } = {}) => {
  const db = ensureInitialized();
  const baseQuery = `
    SELECT
      id,
      tab_id AS tabId,
      type,
      status,
      input_path AS inputPath,
      output_path AS outputPath,
      params,
      result_path AS resultPath,
      error,
      created_at AS createdAt,
      updated_at AS updatedAt,
      started_at AS startedAt,
      finished_at AS finishedAt,
      metadata
    FROM jobs
  `;
  const clauses = [];
  if (status && JOB_STATUS_OPTIONS.has(status)) {
    clauses.push('status = @status');
  }
  if (typeof type === 'string') {
    clauses.push('type = @type');
  }
  const orderDir = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  let sql = baseQuery;
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ` ORDER BY datetime(created_at) ${orderDir}, id ${orderDir} LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all({ status, type, limit, offset }).map(jobFromRow);
};

const countJobs = ({ status = null, type = null } = {}) => {
  const db = ensureInitialized();
  const clauses = [];
  if (status && JOB_STATUS_OPTIONS.has(status)) {
    clauses.push('status = @status');
  }
  if (typeof type === 'string') {
    clauses.push('type = @type');
  }
  let sql = 'SELECT COUNT(*) AS total FROM jobs';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  const row = db.prepare(sql).get({ status, type });
  return Number(row?.total ?? 0);
};

const deleteJobRecord = (id) => {
  const db = ensureInitialized();
  const stmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  const result = stmt.run(id);
  return { changes: result.changes };
};

const appendJobEvent = (event) => {
  const db = ensureInitialized();
  const eventId = event?.eventId && typeof event.eventId === 'string' ? event.eventId : randomUUID();
  const stmt = db.prepare(`
    INSERT INTO job_events (event_id, job_id, event, payload, created_at)
    VALUES (@eventId, @jobId, @event, @payload, @createdAt)
  `);
  stmt.run({
    eventId,
    jobId: event?.jobId,
    event: event?.event ?? 'unknown',
    payload: event?.payload ? JSON.stringify(event.payload) : null,
    createdAt: event?.createdAt ?? nowISO(),
  });
  return getJobEvent(eventId);
};

const getJobEvent = (eventId) => {
  const db = ensureInitialized();
  const stmt = db.prepare(`
    SELECT
      event_id AS eventId,
      job_id AS jobId,
      event,
      payload,
      created_at AS createdAt
    FROM job_events
    WHERE event_id = @eventId
  `);
  return jobEventFromRow(stmt.get({ eventId }));
};

const listJobEvents = (jobId, { limit = 100, offset = 0 } = {}) => {
  const db = ensureInitialized();
  const stmt = db.prepare(`
    SELECT
      event_id AS eventId,
      job_id AS jobId,
      event,
      payload,
      created_at AS createdAt
    FROM job_events
    WHERE job_id = @jobId
    ORDER BY datetime(created_at) DESC
    LIMIT @limit OFFSET @offset
  `);
  return stmt.all({ jobId, limit, offset }).map(jobEventFromRow);
};

const createTabRecord = (tab) => {
  const db = ensureInitialized();
  const now = nowISO();
  const id = tab?.id && typeof tab.id === 'string' ? tab.id : randomUUID();
  const stmt = db.prepare(`
    INSERT INTO tabs (id, title, job_id, state, meta, created_at, updated_at, last_opened_at)
    VALUES (@id, @title, @jobId, @state, @meta, @createdAt, @updatedAt, @lastOpenedAt)
  `);
  stmt.run({
    id,
    title: tab?.title ?? 'タブ',
    jobId: tab?.jobId ?? null,
    state: tab?.state ?? null,
    meta: tab?.meta ? JSON.stringify(tab.meta) : null,
    createdAt: tab?.createdAt ?? now,
    updatedAt: tab?.updatedAt ?? now,
    lastOpenedAt: tab?.lastOpenedAt ?? now,
  });
  return getTabRecord(id);
};

const getTabRecord = (id) => {
  const db = ensureInitialized();
  const stmt = db.prepare(`
    SELECT
      id,
      title,
      job_id AS jobId,
      state,
      meta,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_opened_at AS lastOpenedAt
    FROM tabs
    WHERE id = @id
  `);
  return tabFromRow(stmt.get({ id }));
};

const updateTabRecord = (id, patch = {}) => {
  const db = ensureInitialized();
  const existing = getTabRecord(id);
  if (!existing) return null;
  const stmt = db.prepare(`
    UPDATE tabs
    SET title = @title,
        job_id = @jobId,
        state = @state,
        meta = @meta,
        created_at = @createdAt,
        updated_at = @updatedAt,
        last_opened_at = @lastOpenedAt
    WHERE id = @id
  `);
  stmt.run({
    id,
    title: patch.title ?? existing.title ?? 'タブ',
    jobId: patch.jobId ?? existing.jobId ?? null,
    state: patch.state ?? existing.state ?? null,
    meta: patch.meta ? JSON.stringify(patch.meta) : existing.meta ? JSON.stringify(existing.meta) : null,
    createdAt: patch.createdAt ?? existing.createdAt ?? nowISO(),
    updatedAt: patch.updatedAt ?? nowISO(),
    lastOpenedAt: patch.lastOpenedAt ?? existing.lastOpenedAt ?? null,
  });
  return getTabRecord(id);
};

const listTabs = ({ limit = 100, offset = 0 } = {}) => {
  const db = ensureInitialized();
  const stmt = db.prepare(`
    SELECT
      id,
      title,
      job_id AS jobId,
      state,
      meta,
      created_at AS createdAt,
      updated_at AS updatedAt,
      last_opened_at AS lastOpenedAt
    FROM tabs
    ORDER BY datetime(updated_at) DESC
    LIMIT @limit OFFSET @offset
  `);
  return stmt.all({ limit, offset }).map(tabFromRow);
};

const deleteTabRecord = (id) => {
  const db = ensureInitialized();
  const stmt = db.prepare('DELETE FROM tabs WHERE id = ?');
  const result = stmt.run(id);
  return { changes: result.changes };
};

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
  DEFAULT_CONVERSION_SETTINGS,
  getConversionSettings,
  setConversionSettings,
  DEFAULT_RETENTION_POLICY,
  getTranscriptionOutputStyle,
  setTranscriptionOutputStyle,
  createJobRecord,
  getJobRecord,
  updateJobRecord,
  listJobs,
  countJobs,
  deleteJobRecord,
  appendJobEvent,
  getJobEvent,
  listJobEvents,
  createTabRecord,
  getTabRecord,
  updateTabRecord,
  listTabs,
  deleteTabRecord,
};
