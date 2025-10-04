const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const historyStorage = require('./history/storage');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
let mainWindow;
let historyDbPath = null;
let historyInitError = null;
let retentionTimer = null;
let cachedRetentionPolicy = null;
let transcriptionOutputStyle = 'plain';
const TRANSCRIPTION_MAX_CONCURRENT_JOBS = 4;
const jobStore = new Map();
const runningTranscriptionJobs = new Map();
const transcriptionQueue = [];
const runningConversionJobs = new Map();
const conversionQueue = [];
let conversionSettings = null;
let conversionConcurrencyLimit = historyStorage.DEFAULT_CONVERSION_SETTINGS.maxParallelJobs;
const CONVERSION_FORMATS = new Set(['aac', 'flac', 'ogg', 'wav']);
const CONVERSION_SAMPLE_RATES = new Set([16000, 24000, 44100]);
const CONVERSION_CHANNELS = new Set([1, 2]);
const CONVERSION_BITRATES = new Set([64, 128, 192]);
const CONVERSION_FORMAT_EXTENSIONS = new Map([
  ['aac', 'm4a'],
  ['flac', 'flac'],
  ['ogg', 'ogg'],
  ['wav', 'wav'],
]);
const DEFAULT_CONVERSION_PRESET = historyStorage.DEFAULT_CONVERSION_SETTINGS.defaultPreset;
const tabStore = new Map();

const GPTS_URL = 'https://chatgpt.com/g/g-68df6cd0042c8191a2e8adf4717400b0-revoice-supporter';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function isDev() {
  return !app.isPackaged;
}

function resolveProjectRoot() {
  // electron/ is placed under the repo root; project root is parent dir in dev
  return path.resolve(__dirname, '..');
}

function embeddedPythonExe(base) {
  return process.platform === 'win32'
    ? path.join(base, 'embedded-python', 'Scripts', 'python.exe')
    : path.join(base, 'embedded-python', 'bin', 'python');
}

function resolvePython() {
  // Priority (packaged): bundled venv -> REVOICE_PYTHON -> VIRTUAL_ENV -> system python
  if (app.isPackaged) {
    const bundled = embeddedPythonExe(process.resourcesPath);
    if (require('fs').existsSync(bundled)) return bundled;
  } else {
    // In dev, prefer local embedded venv if prepared
    const maybe = embeddedPythonExe(__dirname);
    if (require('fs').existsSync(maybe)) return maybe;
  }
  if (process.env.REVOICE_PYTHON) return process.env.REVOICE_PYTHON;
  if (process.env.VIRTUAL_ENV) {
    const venv = process.env.VIRTUAL_ENV;
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
    return path.join(venv, bin, process.platform === 'win32' ? 'python.exe' : 'python');
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}
function isPathInside(target, root) {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function allowedRoots() {
  const roots = new Set([resolveProjectRoot()]);
  try {
    roots.add(path.join(app.getPath('documents'), 'Revoice'));
  } catch (err) {
    // ignore
  }
  return Array.from(roots);
}

function resolveTranscriptFile(preferred) {
  if (!preferred) return null;
  const candidates = new Set();
  const baseCandidate = preferred;
  candidates.add(baseCandidate);
  try {
    const nfc = preferred.normalize('NFC');
    const nfd = preferred.normalize('NFD');
    candidates.add(nfc);
    candidates.add(nfd);
  } catch (_) {
    // ignore normalization errors
  }
  const dir = path.dirname(preferred);
  const targetBase = path.basename(preferred);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.txt')) continue;
      try {
        if (entry.name.normalize('NFC') === targetBase.normalize('NFC')) {
          candidates.add(path.join(dir, entry.name));
        }
      } catch (_) {
        candidates.add(path.join(dir, entry.name));
      }
    }
  } catch (_) {
    // ignore read errors
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const firstTxt = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'));
    if (firstTxt) {
      return path.join(dir, firstTxt.name);
    }
  } catch (_) {
    // ignore fallback errors
  }
  return null;
}

const normalizeConversionBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value !== 0;
  }
  return fallback;
};

const normalizeConversionPresetInput = (preset) => {
  const base = {
    format: DEFAULT_CONVERSION_PRESET.format,
    bitrateKbps: DEFAULT_CONVERSION_PRESET.bitrateKbps,
    sampleRate: DEFAULT_CONVERSION_PRESET.sampleRate,
    channels: DEFAULT_CONVERSION_PRESET.channels,
  };

  if (!preset || typeof preset !== 'object') {
    return base;
  }

  if (typeof preset.format === 'string') {
    const candidate = preset.format.trim().toLowerCase();
    if (CONVERSION_FORMATS.has(candidate)) {
      base.format = candidate;
    }
  }

  const bitrateValue = Number(preset.bitrateKbps);
  if (Number.isFinite(bitrateValue) && CONVERSION_BITRATES.has(Math.floor(bitrateValue))) {
    base.bitrateKbps = Math.floor(bitrateValue);
  }

  const sampleRateValue = Number(preset.sampleRate);
  if (Number.isFinite(sampleRateValue) && CONVERSION_SAMPLE_RATES.has(Math.floor(sampleRateValue))) {
    base.sampleRate = Math.floor(sampleRateValue);
  }

  const channelValue = Number(preset.channels);
  if (Number.isFinite(channelValue) && CONVERSION_CHANNELS.has(Math.floor(channelValue))) {
    base.channels = Math.floor(channelValue);
  }

  return base;
};

const clampParallelJobs = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return historyStorage.DEFAULT_CONVERSION_SETTINGS.maxParallelJobs;
  return Math.max(1, Math.min(8, Math.floor(numeric)));
};

const applyConversionSettings = (next) => {
  const normalized = {
    outputDir: next?.outputDir ?? null,
    defaultPreset: normalizeConversionPresetInput(next?.defaultPreset),
    maxParallelJobs: clampParallelJobs(next?.maxParallelJobs ?? historyStorage.DEFAULT_CONVERSION_SETTINGS.maxParallelJobs),
    autoCreateTranscribeTab: normalizeConversionBoolean(
      next?.autoCreateTranscribeTab,
      historyStorage.DEFAULT_CONVERSION_SETTINGS.autoCreateTranscribeTab
    ),
    ffmpegPath: typeof next?.ffmpegPath === 'string' && next.ffmpegPath.trim().length > 0 ? next.ffmpegPath.trim() : null,
  };
  conversionSettings = normalized;
  conversionConcurrencyLimit = normalized.maxParallelJobs;
};

const ffmpegBinaryName = () => (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobeBinaryName = () => (process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

const existsSyncSafe = (targetPath) => {
  if (!targetPath) return false;
  try {
    return fs.existsSync(targetPath);
  } catch (err) {
    console.error('existsSync failed', targetPath, err);
    return false;
  }
};

const resolveInstallerBinary = (installerPath) => {
  if (!installerPath) return null;
  const resolved = path.resolve(installerPath);
  if (resolved.includes('app.asar')) {
    return resolved.replace('app.asar', 'app.asar.unpacked');
  }
  return resolved;
};

const homebrewBinaryCandidates = (binaryName) => {
  if (process.platform === 'darwin') {
    return [
      path.join('/opt/homebrew/bin', binaryName),
      path.join('/usr/local/bin', binaryName),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join('/usr/local/bin', binaryName),
      path.join('/usr/bin', binaryName),
    ];
  }
  if (process.platform === 'win32') {
    return [
      path.join('C:\\ffmpeg\\bin', binaryName),
      path.join('C:\\Program Files\\ffmpeg\\bin', binaryName),
    ];
  }
  return [];
};

const hasExplicitPathSeparator = (value) => typeof value === 'string' && /[\\/]/.test(value);

const resolveFfmpegBinary = () => {
  if (conversionSettings?.ffmpegPath) {
    return conversionSettings.ffmpegPath;
  }
  const bundled = resolveInstallerBinary(ffmpegInstaller?.path);
  if (existsSyncSafe(bundled)) {
    return bundled;
  }
  for (const candidate of homebrewBinaryCandidates(ffmpegBinaryName())) {
    if (existsSyncSafe(candidate)) {
      return candidate;
    }
  }
  return ffmpegBinaryName();
};

const resolveFfprobeBinary = () => {
  if (conversionSettings?.ffmpegPath) {
    const candidate = path.join(path.dirname(conversionSettings.ffmpegPath), ffprobeBinaryName());
    if (existsSyncSafe(candidate)) {
      return candidate;
    }
  }
  const bundled = resolveInstallerBinary(ffprobeInstaller?.path);
  if (existsSyncSafe(bundled)) {
    return bundled;
  }
  for (const candidate of homebrewBinaryCandidates(ffprobeBinaryName())) {
    if (existsSyncSafe(candidate)) {
      return candidate;
    }
  }
  return ffprobeBinaryName();
};

const ensureDirectory = (dir) => {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const conversionPresetLabel = (preset) => {
  const bitrateLabel = CONVERSION_BITRATES.has(preset.bitrateKbps) ? `${preset.bitrateKbps}k` : 'auto';
  const channelLabel = preset.channels === 1 ? 'mono' : 'stereo';
  const rateLabel = `${Math.round(preset.sampleRate / 1000)}k`;
  return `${preset.format}_${bitrateLabel}_${channelLabel}_${rateLabel}`;
};

const parseProgressSeconds = (value) => {
  if (typeof value !== 'string') return null;
  if (/^\d+$/.test(value)) {
    const millis = Number(value);
    if (Number.isFinite(millis)) {
      return millis / 1000000;
    }
  }
  const parts = value.split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts.map(Number);
    if ([h, m, s].every((v) => Number.isFinite(v))) {
      return h * 3600 + m * 60 + s;
    }
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return null;
};

const probeMediaDuration = (ffprobeBinary, inputPath) => {
  if (hasExplicitPathSeparator(ffprobeBinary) && !existsSyncSafe(ffprobeBinary)) {
    console.error('ffprobe not found at path', ffprobeBinary);
    return null;
  }
  try {
    const result = spawnSync(ffprobeBinary, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ],
    {
      encoding: 'utf-8',
    });
    if (result.status === 0) {
      const parsed = Number(result.stdout.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    } else {
      console.error('ffprobe exited with non-zero status', result.status, result.stderr?.toString?.());
    }
  } catch (err) {
    console.error('ffprobe failed', err);
  }
  return null;
};

const cleanupTempDir = (dir) => {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('Failed to cleanup temp dir', err);
  }
};

applyConversionSettings(historyStorage.DEFAULT_CONVERSION_SETTINGS);

const resolveConversionOutputDir = (overrideDir) => {
  const candidate = typeof overrideDir === 'string' && overrideDir.trim().length > 0 ? overrideDir.trim() : conversionSettings.outputDir;
  if (candidate && candidate.length > 0) {
    return ensureDirectory(path.resolve(candidate));
  }
  try {
    return ensureDirectory(app.getPath('downloads'));
  } catch (err) {
    console.error('Failed to resolve downloads directory, falling back to project archive', err);
  }
  const fallback = path.join(resolveProjectRoot(), 'archive');
  return ensureDirectory(fallback);
};

const deriveConversionOutputPaths = (jobId, inputPath, preset, targetDir) => {
  const parsed = path.parse(inputPath ?? '');
  const stem = parsed.name || parsed.base || `conversion-${jobId.slice(0, 8)}`;
  const label = conversionPresetLabel(preset);
  const extension = CONVERSION_FORMAT_EXTENSIONS.get(preset.format) ?? preset.format;
  const baseFileName = `${stem}_${label}`;
  let finalPath = path.join(targetDir, `${baseFileName}.${extension}`);
  let suffix = 1;
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(targetDir, `${baseFileName}-${suffix}.${extension}`);
    suffix += 1;
  }
  const tempDir = path.join(app.getPath('temp'), 'revoice-convert', jobId);
  ensureDirectory(tempDir);
  const tempOutputPath = path.join(tempDir, `${baseFileName}.${extension}`);
  return { tempDir, tempOutputPath, finalPath, extension, fileName: path.basename(finalPath), label };
};

const buildFfmpegArgsForPreset = (inputPath, preset, outputPath) => {
  const args = [
    '-y',
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    String(preset.channels),
    '-ar',
    String(preset.sampleRate),
  ];

  if (preset.format === 'aac') {
    args.push('-c:a', 'aac');
    args.push('-b:a', `${preset.bitrateKbps}k`);
  } else if (preset.format === 'ogg') {
    args.push('-c:a', 'libvorbis');
    args.push('-b:a', `${preset.bitrateKbps}k`);
  } else if (preset.format === 'flac') {
    args.push('-c:a', 'flac');
  } else if (preset.format === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  }

  args.push(outputPath);
  return args;
};
function emitSystemLog(win, message) {
  if (!win) return;
  win.webContents.send('transcribe:log', `[SYSTEM] ${message}`);
}

function broadcastSystemLog(message) {
  BrowserWindow.getAllWindows().forEach((win) => emitSystemLog(win, message));
}

const nowISO = () => new Date().toISOString();

const looksLikeConversionJob = (job) => {
  if (!job) return false;
  if (job.type === 'conversion') return true;
  const metadata = job.metadata ?? {};
  const params = job.params ?? {};
  if (metadata && (metadata.preset || metadata.presetKey || (metadata.payload && metadata.payload.preset))) {
    return true;
  }
  if (params && params.preset) {
    return true;
  }
  return false;
};

const resolveJobType = (job, fallback = 'transcription') => {
  if (!job) return fallback;
  if (job.type === 'conversion') return 'conversion';
  if (job.type === 'transcription') return 'transcription';
  return looksLikeConversionJob(job) ? 'conversion' : fallback;
};

const jobToSummary = (job) => {
  if (!job) return null;
  const normalizedType = resolveJobType(job);
  return {
    id: job.id,
    tabId: job.tabId ?? null,
    status: job.status,
    type: normalizedType,
    inputPath: job.inputPath ?? null,
    outputPath: job.outputPath ?? null,
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    progress: typeof job.progress === 'number' ? job.progress : null,
    queuePosition: typeof job.queuePosition === 'number' ? job.queuePosition : null,
    pid: job.pid ?? null,
    error: job.error ?? null,
    transcript: job.transcript ?? null,
    params: job.params ?? null,
    metadata: job.metadata ?? null,
  };
};

const tabToSummary = (tab) => {
  if (!tab) return null;
  return {
    id: tab.id,
    title: tab.title ?? 'タブ',
    jobId: tab.jobId ?? null,
    state: tab.state ?? null,
    meta: tab.meta ?? {},
    createdAt: tab.createdAt ?? null,
    updatedAt: tab.updatedAt ?? null,
    lastOpenedAt: tab.lastOpenedAt ?? null,
  };
};

const broadcastJobUpdate = (job) => {
  const summary = jobToSummary(job);
  if (!summary) return;
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('jobs:event', { kind: 'updated', job: summary });
  });
};

const broadcastJobLog = (jobId, message, level = 'info') => {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('jobs:event', {
      kind: 'log',
      jobId,
      message,
      level,
      createdAt: nowISO(),
    });
  });
};

const broadcastTabUpdate = (tab) => {
  const summary = tabToSummary(tab);
  if (!summary) return;
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('tabs:event', { kind: 'updated', tab: summary });
  });
};

const broadcastTabRemoval = (tabId) => {
  if (!tabId) return;
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('tabs:event', { kind: 'removed', tabId });
  });
};

const recomputeQueuePositions = (queue) => {
  queue.forEach((jobId, index) => {
    const job = jobStore.get(jobId);
    if (!job) return;
    const nextPosition = index + 1;
    if (job.queuePosition !== nextPosition) {
      job.queuePosition = nextPosition;
      job.updatedAt = nowISO();
      broadcastJobUpdate(job);
    }
  });
};

function computeThresholdISO(days) {
  if (!Number.isFinite(days) || days <= 0) return null;
  const ms = days * DAY_IN_MS;
  return new Date(Date.now() - ms).toISOString();
}

function summarizePolicy(policy) {
  return {
    mode: policy.mode,
    maxDays: policy.maxDays ?? null,
    maxEntries: policy.maxEntries ?? null,
    schedule: {
      type: policy?.schedule?.type ?? 'interval',
      preset: policy?.schedule?.preset ?? null,
      intervalHours: policy?.schedule?.intervalHours ?? null,
    },
  };
}

function runRetentionPrune(reason = 'scheduled') {
  try {
    const policy = historyStorage.getRetentionPolicy();
    cachedRetentionPolicy = summarizePolicy(policy);

    let removedByAge = 0;
    let removedByCount = 0;

    if (policy.maxDays && Number.isFinite(policy.maxDays)) {
      const thresholdISO = computeThresholdISO(policy.maxDays);
      if (thresholdISO) {
        const result = historyStorage.pruneBeforeISO(thresholdISO);
        removedByAge = Number(result?.changes ?? 0);
      }
    }

    if (policy.maxEntries && Number.isFinite(policy.maxEntries)) {
      const result = historyStorage.pruneExceedingCount(policy.maxEntries);
      removedByCount = Number(result?.changes ?? 0);
    }

    const totalRemoved = removedByAge + removedByCount;
    const total = historyStorage.countTranscriptions();

    broadcastSystemLog(
      `History pruning removed ${totalRemoved} rows (age=${removedByAge}, overflow=${removedByCount}, reason=${reason})`
    );

    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('history:pruned', {
        removed: totalRemoved,
        removedByAge,
        removedByCount,
        total,
        reason,
        policy: cachedRetentionPolicy,
      });
    });
  } catch (err) {
    console.error('Retention prune failed', err);
    broadcastSystemLog(`History pruning failed: ${err?.message ?? err}`);
  }
}

function updateRetentionSchedule(policy) {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  if (!policy || policy?.schedule?.type !== 'interval') {
    return;
  }
  const intervalHours = Number(policy.schedule.intervalHours);
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    return;
  }
  const intervalMs = intervalHours * 60 * 60 * 1000;
  retentionTimer = setInterval(() => runRetentionPrune('interval'), intervalMs);
  if (typeof retentionTimer.unref === 'function') {
    retentionTimer.unref();
  }
}

const saveTabRecord = (tabId, patch = {}) => {
  if (!tabId) return null;
  let record = tabStore.get(tabId);
  try {
    record = record
      ? historyStorage.updateTabRecord(tabId, { ...patch, updatedAt: nowISO() })
      : historyStorage.createTabRecord({ id: tabId, ...patch });
    if (record) {
      tabStore.set(record.id, record);
      broadcastTabUpdate(record);
    }
    return record;
  } catch (err) {
    console.error('Failed to save tab record', err);
    return null;
  }
};

const removeTabRecord = (tabId) => {
  if (!tabId) return { changes: 0 };
  try {
    const result = historyStorage.deleteTabRecord(tabId);
    tabStore.delete(tabId);
    broadcastTabRemoval(tabId);
    return result;
  } catch (err) {
    console.error('Failed to delete tab record', err);
    return { changes: 0 };
  }
};

const loadPersistedTabs = () => {
  try {
    const records = historyStorage.listTabs({ limit: 1000, offset: 0 });
    records.forEach((record) => {
      tabStore.set(record.id, record);
    });
  } catch (err) {
    console.error('Failed to load tabs from storage', err);
  }
};

const loadPersistedJobs = () => {
  try {
    const records = historyStorage.listJobs({ limit: 1000, offset: 0 });
    records.forEach((record) => {
      const job = {
        ...record,
        progress: record.status === 'completed' ? 100 : 0,
        queuePosition: null,
        pid: null,
        transcript: record.metadata?.transcript ?? null,
        payload: record.metadata?.payload ?? {},
      };
      job.type = resolveJobType(job);
      if (job.status === 'running') {
        job.status = 'queued';
        job.startedAt = null;
        job.finishedAt = null;
        historyStorage.updateJobRecord(job.id, {
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          updatedAt: nowISO(),
          type: job.type,
        });
      }
      jobStore.set(job.id, job);
      if (job.status === 'queued') {
        if (job.type === 'conversion') {
          conversionQueue.push(job.id);
        } else {
          transcriptionQueue.push(job.id);
        }
      }
    });
  } catch (err) {
    console.error('Failed to load jobs from storage', err);
  }
};

const paramsValue = (job, key, fallback = null) => {
  if (!job?.params) return fallback;
  const value = job.params[key];
  return value === undefined ? fallback : value;
};

const updateJobRecordAndStore = (job, patch = {}) => {
  const nextMetadata = {
    ...(job.metadata ?? {}),
    ...(patch.metadata ?? {}),
  };
  const nextSnapshot = {
    ...job,
    ...patch,
    type: patch.type ?? job.type,
    params: patch.params ?? job.params,
    metadata: nextMetadata,
  };
  const normalizedType = resolveJobType(nextSnapshot);

  const stored = historyStorage.updateJobRecord(job.id, {
    tabId: patch.tabId ?? job.tabId ?? null,
    type: normalizedType,
    status: patch.status ?? job.status,
    inputPath: patch.inputPath ?? job.inputPath ?? null,
    outputPath: patch.outputPath ?? job.outputPath ?? null,
    resultPath: patch.resultPath ?? job.resultPath ?? null,
    error: patch.error ?? job.error ?? null,
    startedAt: patch.startedAt ?? job.startedAt ?? null,
    finishedAt: patch.finishedAt ?? job.finishedAt ?? null,
    updatedAt: patch.updatedAt ?? nowISO(),
    metadata: nextMetadata,
    params: patch.params ?? job.params ?? null,
  });
  if (stored) {
    const preserved = {
      progress: nextSnapshot.progress ?? job.progress ?? null,
      queuePosition: nextSnapshot.queuePosition ?? job.queuePosition ?? null,
      pid: nextSnapshot.pid ?? job.pid ?? null,
      transcript: nextSnapshot.transcript ?? job.transcript ?? null,
      payload: nextSnapshot.payload ?? job.payload ?? null,
    };
    Object.assign(job, stored, preserved);
  }
  job.type = normalizedType;
  return job;
};

const enqueueJob = (payload) => {
  if (!payload || typeof payload.inputPath !== 'string' || payload.inputPath.trim().length === 0) {
    throw new Error('入力ファイルが指定されていません');
  }
  const jobId = randomUUID();
  const tabId = payload.tabId ? String(payload.tabId) : randomUUID();
  const createdAt = nowISO();
  const params = {
    outputDir: payload.outputDir ?? 'archive',
    model: payload.model ?? 'large-v3',
    language: payload.language ?? 'ja',
    beamSize: payload.beamSize ?? 5,
    computeType: payload.computeType ?? 'int8',
    outputStyle: payload.outputStyle ?? transcriptionOutputStyle,
    formats: payload.formats ?? 'txt,srt,vtt',
    initialPrompt: payload.initialPrompt ?? '',
    replace: payload.replace ?? '',
    noVad: Boolean(payload.noVad),
    minSegment: payload.minSegment ?? null,
    preset: payload.preset ?? 'balanced',
    memo: Boolean(payload.memo),
  };
  const metadata = {
    payload: {
      ...params,
      inputPath: payload.inputPath,
    },
    sourceConversionJobId: payload.sourceConversionJobId ?? null,
  };
  const record = historyStorage.createJobRecord({
    id: jobId,
    tabId,
    status: 'queued',
    inputPath: payload.inputPath,
    params,
    createdAt,
    updatedAt: createdAt,
    metadata,
  });
  const job = {
    ...record,
    type: 'transcription',
    progress: 0,
    queuePosition: null,
    pid: null,
    transcript: null,
    payload: metadata.payload,
  };
  jobStore.set(jobId, job);
  if (!tabStore.has(tabId)) {
    const tabRecord = historyStorage.createTabRecord({ id: tabId, title: payload.tabTitle ?? 'タブ', jobId, state: 'queued' });
    tabStore.set(tabId, tabRecord);
    broadcastTabUpdate(tabRecord);
  } else {
    saveTabRecord(tabId, { jobId, state: 'queued' });
  }
  transcriptionQueue.push(jobId);
  historyStorage.appendJobEvent({ jobId, event: 'queued', payload: { reason: 'enqueue' } });
  broadcastJobUpdate(job);
  processQueues();
  return job;
};

const enqueueConversionJob = (payload) => {
  if (!payload || typeof payload.inputPath !== 'string' || payload.inputPath.trim().length === 0) {
    throw new Error('入力ファイルが指定されていません');
  }
  const inputPath = payload.inputPath.trim();
  const preset = normalizeConversionPresetInput(payload.preset);
  const outputDir = resolveConversionOutputDir(payload.outputDir);
  const autoTranscribe = payload.autoTranscribe !== undefined
    ? normalizeConversionBoolean(payload.autoTranscribe, conversionSettings.autoCreateTranscribeTab)
    : conversionSettings.autoCreateTranscribeTab;
  const jobId = randomUUID();
  const createdAt = nowISO();
  const params = {
    preset,
    outputDir,
    autoTranscribe,
    tabTitle: payload.tabTitle ?? null,
  };
  const presetKey = typeof payload.presetKey === 'string' ? payload.presetKey : null;
  const presetLabel = typeof payload.presetLabel === 'string' ? payload.presetLabel : null;
  const presetSummary = typeof payload.presetSummary === 'string' ? payload.presetSummary : null;
  const metadata = {
    payload: params,
    preset,
    presetKey,
    presetLabel,
    presetSummary,
    sourceInputPath: inputPath,
    outputDir,
  };
  const record = historyStorage.createJobRecord({
    id: jobId,
    type: 'conversion',
    status: 'queued',
    inputPath,
    params,
    createdAt,
    updatedAt: createdAt,
    metadata,
  });
  const job = {
    ...record,
    type: 'conversion',
    progress: 0,
    queuePosition: null,
    pid: null,
    transcript: null,
    payload: metadata.payload,
  };
  jobStore.set(jobId, job);
  conversionQueue.push(jobId);
  historyStorage.appendJobEvent({ jobId, event: 'queued', payload: { reason: 'enqueue-conversion' } });
  broadcastJobLog(jobId, `[CONVERT] Queueing conversion for ${path.basename(inputPath)}`);
  broadcastJobUpdate(job);
  processQueues();
  return job;
};

const processTranscriptionQueue = () => {
  while (runningTranscriptionJobs.size < TRANSCRIPTION_MAX_CONCURRENT_JOBS && transcriptionQueue.length > 0) {
    const jobId = transcriptionQueue.shift();
    const job = jobStore.get(jobId);
    if (!job) continue;
    startTranscriptionJob(job);
  }
  recomputeQueuePositions(transcriptionQueue);
};

const processConversionQueue = () => {
  while (runningConversionJobs.size < conversionConcurrencyLimit && conversionQueue.length > 0) {
    const jobId = conversionQueue.shift();
    const job = jobStore.get(jobId);
    if (!job) continue;
    startConversionJob(job);
  }
  recomputeQueuePositions(conversionQueue);
};

const processQueues = () => {
  processTranscriptionQueue();
  processConversionQueue();
};

const paramsForJob = (job) => ({
  outputDir: paramsValue(job, 'outputDir', 'archive'),
  model: paramsValue(job, 'model', 'large-v3'),
  language: paramsValue(job, 'language', 'ja'),
  beamSize: paramsValue(job, 'beamSize', 5),
  computeType: paramsValue(job, 'computeType', 'int8'),
  outputStyle: paramsValue(job, 'outputStyle', transcriptionOutputStyle),
  formats: paramsValue(job, 'formats', 'txt,srt,vtt'),
  initialPrompt: paramsValue(job, 'initialPrompt', ''),
  replace: paramsValue(job, 'replace', ''),
  noVad: Boolean(paramsValue(job, 'noVad', false)),
  minSegment: paramsValue(job, 'minSegment', null),
  preset: paramsValue(job, 'preset', 'balanced'),
  memo: Boolean(paramsValue(job, 'memo', false)),
});

const buildCliArgs = (job, params, outDir) => {
  const allowedOutputStyles = new Set(['timestamps', 'plain']);
  const args = [
    '-m', 'revoice.cli',
    job.inputPath,
    '--output_dir', outDir,
    '--model', params.model,
    '--language', params.language,
    '--beam_size', String(params.beamSize),
    '--compute_type', params.computeType,
    '--formats', params.formats,
  ];
  const outputStyle = allowedOutputStyles.has(params.outputStyle) ? params.outputStyle : 'plain';
  args.push('--output_style', outputStyle);
  if (params.initialPrompt) {
    args.push('--initial_prompt', params.initialPrompt);
  }
  if (params.replace) {
    args.push('--replace', params.replace);
  }
  if (params.noVad) {
    args.push('--no_vad');
  }
  if (params.minSegment) {
    args.push('--min_segment', String(params.minSegment));
  }
  if (params.preset) {
    args.push('--preset', params.preset);
  }
  if (params.memo) {
    args.push('--memo');
  }
  return args;
};

const removeFromTranscriptionQueue = (jobId) => {
  const index = transcriptionQueue.indexOf(jobId);
  if (index >= 0) {
    transcriptionQueue.splice(index, 1);
  }
};

const removeFromConversionQueue = (jobId) => {
  const index = conversionQueue.indexOf(jobId);
  if (index >= 0) {
    conversionQueue.splice(index, 1);
  }
};

const startTranscriptionJob = (job) => {
  const params = paramsForJob(job);
  const python = resolvePython();
  const projectRoot = resolveProjectRoot();
  let cwd = projectRoot;
  if (app.isPackaged) {
    cwd = path.join(app.getPath('documents'), 'Revoice');
  }
  try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
  const outDir = path.isAbsolute(params.outputDir) ? params.outputDir : path.join(cwd, params.outputDir);
  const parsedInput = path.parse(job.inputPath ?? '');
  const inputStem = parsedInput.name || parsedInput.base || 'transcript';
  const transcriptPath = path.join(outDir, `${inputStem}.txt`);

  job.status = 'running';
  job.startedAt = nowISO();
  job.updatedAt = job.startedAt;
  job.progress = 0;
  job.queuePosition = null;
  updateJobRecordAndStore(job, { status: 'running', startedAt: job.startedAt, updatedAt: job.updatedAt });
  historyStorage.appendJobEvent({ jobId: job.id, event: 'started', payload: { startedAt: job.startedAt } });
  if (job.tabId) {
    saveTabRecord(job.tabId, { jobId: job.id, state: 'running', updatedAt: job.startedAt });
  }
  broadcastJobUpdate(job);

  const args = buildCliArgs(job, params, outDir);

  const child = spawn(python, args, {
    cwd,
    env: {
      ...process.env,
      PYTHONPATH: app.isPackaged
        ? ''
        : projectRoot + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
      PYTHONNOUSERSITE: '1',
    },
  });

  job.pid = child.pid ?? null;
  broadcastJobUpdate(job);
  runningTranscriptionJobs.set(job.id, { child, transcriptHint: transcriptPath, startedAt: Date.now() });

  const inspectChunk = (chunk) => {
    const message = chunk.toString();
    const lines = message.split(/\r?\n/);
    for (const raw of lines) {
      const text = raw.trim();
      if (!text) continue;
      if (text.startsWith('[TRANSCRIPT]')) {
        const explicit = text.slice('[TRANSCRIPT]'.length).trim();
        if (explicit) {
          const state = runningTranscriptionJobs.get(job.id);
          if (state) state.transcriptHint = explicit;
          broadcastJobLog(job.id, `Transcript path reported: ${explicit}`, 'info');
        }
        continue;
      }
      if (text.startsWith('[PROGRESS]')) {
        const payload = text.slice('[PROGRESS]'.length).trim();
        let computed = null;
        if (/^\d+(?:\.\d+)?$/.test(payload)) {
          computed = Number(payload);
        } else if (/^\d+(?:\.\d+)?%$/.test(payload)) {
          computed = Number(payload.replace('%', ''));
        } else if (/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(payload)) {
          const [current, total] = payload.split('/').map((part) => Number(part.trim()));
          if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
            computed = (current / total) * 100;
          }
        }
        if (computed !== null && Number.isFinite(computed)) {
          job.progress = Math.max(0, Math.min(100, computed));
          job.updatedAt = nowISO();
          broadcastJobUpdate(job);
        }
        continue;
      }
      const level = /\bERROR\b|\[ERROR]|\bFAILED\b/.test(text) ? 'error' : 'info';
      broadcastJobLog(job.id, text, level);
    }
  };

  child.stdout.on('data', inspectChunk);
  child.stderr.on('data', inspectChunk);
  child.on('error', (err) => {
    broadcastJobLog(job.id, `プロセスエラー: ${err}`, 'error');
  });
  child.on('close', (code) => {
    const state = runningTranscriptionJobs.get(job.id);
    const hint = state?.transcriptHint ?? transcriptPath;
    finalizeTranscriptionJob(job, code, hint);
  });
};

const finalizeTranscriptionJob = (job, exitCode, transcriptHint) => {
  const running = runningTranscriptionJobs.get(job.id);
  runningTranscriptionJobs.delete(job.id);
  const finishedAt = nowISO();
  let outputPath = null;
  let transcriptText = null;
  if (exitCode === 0) {
    outputPath = resolveTranscriptFile(transcriptHint);
    if (outputPath) {
      try {
        transcriptText = fs.readFileSync(outputPath, 'utf-8');
        broadcastJobLog(job.id, `Transcript読み込み成功: ${outputPath}`);
      } catch (err) {
        broadcastJobLog(job.id, `Transcript読み込みに失敗: ${err}`, 'error');
        outputPath = null;
      }
    } else {
      broadcastJobLog(job.id, `Transcriptファイルが見つかりません: ${transcriptHint}`, 'error');
    }
  }

  let durationSec = null;
  if (running?.startedAt) {
    durationSec = Math.max(0, (Date.now() - running.startedAt) / 1000);
  }
  const finishedTs = Date.parse(finishedAt);
  const startedTs = job.startedAt ? Date.parse(job.startedAt) : null;
  const processingMs = Number.isFinite(startedTs) ? Math.max(0, finishedTs - startedTs) : null;
  const transcriptCharCount = transcriptText ? transcriptText.length : 0;
  const sourceConversionJobId = job.metadata?.sourceConversionJobId ?? null;

  if (exitCode === 0) {
    try {
      const record = historyStorage.storeTranscription({
        inputPath: job.inputPath ?? null,
        outputPath,
        transcript: transcriptText ?? '',
        model: paramsValue(job, 'model', null),
        language: paramsValue(job, 'language', null),
        createdAt: finishedAt,
        duration: durationSec,
        status: 'completed',
        notes: { processingMs, transcriptCharCount, sourceConversionJobId },
      });
      broadcastSystemLog(`履歴を保存しました (#${record.id})`);
      BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('history:item-added', record));
    } catch (err) {
      broadcastSystemLog(`履歴保存に失敗: ${err}`);
    }
    job.status = 'completed';
    job.transcript = transcriptText ?? '';
    job.outputPath = outputPath;
    job.progress = 100;
    job.error = null;
  } else {
    try {
      const record = historyStorage.storeTranscription({
        inputPath: job.inputPath ?? null,
        outputPath: null,
        transcript: '',
        model: paramsValue(job, 'model', null),
        language: paramsValue(job, 'language', null),
        createdAt: finishedAt,
        duration: durationSec,
        status: 'failed',
        notes: { processingMs, transcriptCharCount: 0, sourceConversionJobId, error: `Exit code: ${exitCode ?? 'unknown'}` },
      });
      broadcastSystemLog(`失敗したジョブを履歴に保存しました (#${record.id})`);
      BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('history:item-added', record));
    } catch (err) {
      broadcastSystemLog(`失敗ジョブの履歴保存に失敗: ${err}`);
    }
    job.status = exitCode === null ? 'cancelled' : 'failed';
    job.error = `Exit code: ${exitCode ?? 'unknown'}`;
    job.transcript = null;
    job.outputPath = null;
    job.progress = null;
  }

  job.finishedAt = finishedAt;
  job.updatedAt = finishedAt;
  job.pid = null;
  job.queuePosition = null;
  updateJobRecordAndStore(job, {
    status: job.status,
    finishedAt: job.finishedAt,
    outputPath: job.outputPath,
    error: job.error,
    updatedAt: finishedAt,
    metadata: {
      ...(job.metadata ?? {}),
      transcript: job.transcript ?? null,
      outputPath: job.outputPath ?? null,
      processingMs,
      transcriptCharCount,
      sourceConversionJobId,
    },
  });
  historyStorage.appendJobEvent({ jobId: job.id, event: job.status, payload: { exitCode } });
  if (job.tabId) {
    saveTabRecord(job.tabId, { jobId: job.id, state: job.status, updatedAt: finishedAt });
  }
  broadcastJobUpdate(job);
  processQueues();
};

const handleConversionProgress = (job, runtime, chunk) => {
  const lines = chunk.toString().split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [key, value] = line.split('=');
    if (!value) continue;
    if (key === 'out_time_ms' || key === 'out_time' || key === 'out_time_us') {
      const seconds = parseProgressSeconds(value);
      if (seconds !== null) {
        runtime.lastOutSeconds = seconds;
        if (runtime.durationSec && runtime.durationSec > 0) {
          const percent = Math.max(0, Math.min(99, Math.floor((seconds / runtime.durationSec) * 100)));
          if (!Number.isNaN(percent) && percent > (job.progress ?? 0)) {
            job.progress = percent;
            job.updatedAt = nowISO();
            broadcastJobUpdate(job);
          }
        }
      }
    } else if (key === 'progress' && value === 'end') {
      if (runtime.durationSec && (job.progress ?? 0) < 99) {
        job.progress = 99;
        job.updatedAt = nowISO();
        broadcastJobUpdate(job);
      }
    }
  }
};

const failConversionJob = (job, reason, metadataPatch = {}) => {
  const finishedAt = nowISO();
  job.status = 'failed';
  job.error = reason;
  job.finishedAt = finishedAt;
  job.updatedAt = finishedAt;
  job.progress = null;
  job.queuePosition = null;
  job.pid = null;
  updateJobRecordAndStore(job, {
    status: 'failed',
    error: reason,
    finishedAt,
    updatedAt: finishedAt,
    metadata: {
      ...(job.metadata ?? {}),
      ...metadataPatch,
    },
  });
  historyStorage.appendJobEvent({ jobId: job.id, event: 'failed', payload: { reason } });
  broadcastJobLog(job.id, `[CONVERT][ERROR] ${reason}`, 'error');
  broadcastJobUpdate(job);
  processQueues();
};

const startConversionJob = (job) => {
  const preset = normalizeConversionPresetInput(job.params?.preset);
  let outputDir;
  try {
    const override = job.params?.outputDir ?? job.metadata?.outputDir;
    outputDir = resolveConversionOutputDir(override);
  } catch (err) {
    failConversionJob(job, `出力ディレクトリを準備できません: ${err?.message ?? err}`);
    return;
  }

  let inputStat = null;
  try {
    inputStat = fs.statSync(job.inputPath);
  } catch (err) {
    failConversionJob(job, `入力ファイルにアクセスできません: ${err?.message ?? err}`);
    return;
  }

  const ffmpegBinary = resolveFfmpegBinary();
  const ffprobeBinary = resolveFfprobeBinary();

  if (hasExplicitPathSeparator(ffmpegBinary) && !existsSyncSafe(ffmpegBinary)) {
    failConversionJob(job, `FFmpeg の実行ファイルが見つかりません: ${ffmpegBinary}`);
    return;
  }

  if (hasExplicitPathSeparator(ffprobeBinary) && !existsSyncSafe(ffprobeBinary)) {
    failConversionJob(job, `FFprobe の実行ファイルが見つかりません: ${ffprobeBinary}`);
    return;
  }

  const durationSec = probeMediaDuration(ffprobeBinary, job.inputPath);
  const paths = deriveConversionOutputPaths(job.id, job.inputPath, preset, outputDir);

  const autoTranscribe = normalizeConversionBoolean(
    job.params?.autoTranscribe,
    conversionSettings.autoCreateTranscribeTab
  );

  job.params = {
    ...(job.params ?? {}),
    preset,
    outputDir,
    autoTranscribe,
    tabTitle: job.params?.tabTitle ?? null,
  };

  job.status = 'running';
  job.startedAt = nowISO();
  job.updatedAt = job.startedAt;
  job.progress = durationSec ? 0 : null;
  job.queuePosition = null;
  job.outputPath = null;
  job.resultPath = null;

  updateJobRecordAndStore(job, {
    status: 'running',
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    params: job.params,
    metadata: {
      ...(job.metadata ?? {}),
      preset,
      outputDir,
      durationSec,
      sourceInputPath: job.inputPath,
      sourceBytes: inputStat?.size ?? null,
      payload: job.params,
    },
  });
  historyStorage.appendJobEvent({ jobId: job.id, event: 'started', payload: { startedAt: job.startedAt } });
  broadcastJobUpdate(job);
  broadcastJobLog(job.id, `[CONVERT] 変換開始: ${paths.fileName}`);

  const args = buildFfmpegArgsForPreset(job.inputPath, preset, paths.tempOutputPath);
  let child;
  try {
    child = spawn(ffmpegBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    cleanupTempDir(paths.tempDir);
    failConversionJob(job, `FFmpeg の起動に失敗しました: ${err?.message ?? err}`);
    return;
  }

  job.pid = child.pid ?? null;
  broadcastJobUpdate(job);

  const runtime = {
    child,
    tempDir: paths.tempDir,
    tempOutputPath: paths.tempOutputPath,
    finalOutputPath: paths.finalPath,
    durationSec,
    preset,
    outputDir,
    sourceBytes: inputStat?.size ?? null,
    startedAt: Date.now(),
    fileName: paths.fileName,
  };
  runningConversionJobs.set(job.id, runtime);

  child.stdout.on('data', (chunk) => handleConversionProgress(job, runtime, chunk));
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      broadcastJobLog(job.id, `[CONVERT] ${line}`);
    }
  });
  child.on('error', (err) => {
    broadcastJobLog(job.id, `[CONVERT][ERROR] プロセスエラー: ${err?.message ?? err}`, 'error');
  });
  child.on('close', (code) => finalizeConversionJob(job, code, runtime));
};

const finalizeConversionJob = (job, exitCode, runtime) => {
  runningConversionJobs.delete(job.id);
  const finishedAt = nowISO();
  let outputPath = null;
  let errorMessage = exitCode === 0 ? null : `Exit code: ${exitCode ?? 'unknown'}`;
  const finishedTs = Date.parse(finishedAt);
  const startedTs = job.startedAt ? Date.parse(job.startedAt) : null;
  const processingMs = Number.isFinite(startedTs) ? Math.max(0, finishedTs - startedTs) : null;

  if (exitCode === 0) {
    try {
      ensureDirectory(path.dirname(runtime.finalOutputPath));
      try {
        fs.renameSync(runtime.tempOutputPath, runtime.finalOutputPath);
      } catch (err) {
        fs.copyFileSync(runtime.tempOutputPath, runtime.finalOutputPath);
        try {
          fs.unlinkSync(runtime.tempOutputPath);
        } catch (_) {
          // ignore cleanup errors
        }
      }
      outputPath = runtime.finalOutputPath;
      broadcastJobLog(job.id, `[CONVERT] 保存しました: ${outputPath}`);
    } catch (err) {
      errorMessage = `変換結果の保存に失敗しました: ${err?.message ?? err}`;
    }
  }

  cleanupTempDir(runtime.tempDir);

  if (exitCode === 0 && outputPath) {
    let outputBytes = null;
    try {
      const stat = fs.statSync(outputPath);
      outputBytes = stat.size;
    } catch (err) {
      broadcastJobLog(job.id, `[CONVERT] 出力ファイルサイズの取得に失敗: ${err?.message ?? err}`);
    }
    const sourceBytes = runtime.sourceBytes ?? null;
    const compressionRatio = sourceBytes && outputBytes ? outputBytes / sourceBytes : null;
    const compressionPercent = compressionRatio ? Math.max(0, Math.min(100, compressionRatio * 100)) : null;
    const compressionSavedPercent = compressionPercent !== null ? 100 - compressionPercent : null;

    job.status = 'completed';
    job.outputPath = outputPath;
    job.resultPath = outputPath;
    job.error = null;
    job.progress = 100;
    job.finishedAt = finishedAt;
    job.updatedAt = finishedAt;
    job.pid = null;
    job.queuePosition = null;

    updateJobRecordAndStore(job, {
      status: 'completed',
      outputPath,
      resultPath: outputPath,
      finishedAt,
      updatedAt: finishedAt,
      metadata: {
        ...(job.metadata ?? {}),
        outputPath,
        outputBytes,
        preset: runtime.preset,
        durationSec: runtime.durationSec,
        sourceBytes: runtime.sourceBytes,
        processingMs,
        compressionRatio,
        compressionPercent,
        compressionSavedPercent,
      },
    });
    historyStorage.appendJobEvent({ jobId: job.id, event: 'completed', payload: { outputPath } });
    broadcastJobUpdate(job);

    if (job.params?.autoTranscribe) {
      try {
        const tabTitle = job.params?.tabTitle ?? path.basename(outputPath);
        const forwarded = enqueueJob({
          inputPath: outputPath,
          tabTitle,
          sourceConversionJobId: job.id,
        });
        historyStorage.appendJobEvent({ jobId: job.id, event: 'forwarded', payload: { transcriptionJobId: forwarded.id } });
        broadcastJobLog(job.id, `[CONVERT] 文字起こしに送信しました (Job ${forwarded.id})`);
        updateJobRecordAndStore(job, {
          metadata: {
            ...(job.metadata ?? {}),
            outputPath,
            outputBytes,
            preset: runtime.preset,
            durationSec: runtime.durationSec,
            sourceBytes: runtime.sourceBytes,
            processingMs,
            compressionRatio,
            compressionPercent,
            compressionSavedPercent,
            linkedTranscriptionJobId: forwarded.id,
          },
        });
        job.metadata = {
          ...(job.metadata ?? {}),
          outputPath,
          outputBytes,
          preset: runtime.preset,
          durationSec: runtime.durationSec,
          sourceBytes: runtime.sourceBytes,
          processingMs,
          compressionRatio,
          compressionPercent,
          compressionSavedPercent,
          linkedTranscriptionJobId: forwarded.id,
        };
        broadcastJobUpdate(job);
      } catch (err) {
        broadcastJobLog(job.id, `[CONVERT][ERROR] 文字起こしジョブの作成に失敗: ${err?.message ?? err}`,'error');
      }
    }
  } else {
    job.status = exitCode === null ? 'cancelled' : 'failed';
    job.error = errorMessage;
    job.progress = null;
    job.finishedAt = finishedAt;
    job.updatedAt = finishedAt;
    job.pid = null;
    job.queuePosition = null;

    updateJobRecordAndStore(job, {
      status: job.status,
      error: job.error,
      finishedAt,
      updatedAt: finishedAt,
      metadata: {
        ...(job.metadata ?? {}),
        preset: runtime.preset,
        durationSec: runtime.durationSec,
        sourceBytes: runtime.sourceBytes,
        processingMs,
      },
    });
    historyStorage.appendJobEvent({ jobId: job.id, event: job.status, payload: { error: job.error } });
    if (job.error) {
      broadcastJobLog(job.id, `[CONVERT][ERROR] ${job.error}`, 'error');
    }
    broadcastJobUpdate(job);
  }

  processQueues();
};

const cancelJob = (jobId, reason = 'user') => {
  const job = jobStore.get(jobId);
  if (!job) {
    return { ok: false, error: 'ジョブが見つかりません' };
  }
  const jobType = resolveJobType(job);
  job.type = jobType;
  if (job.status === 'queued') {
    if (jobType === 'conversion') {
      removeFromConversionQueue(jobId);
    } else {
      removeFromTranscriptionQueue(jobId);
    }
  } else if (job.status === 'running') {
    if (jobType === 'conversion') {
      const runtime = runningConversionJobs.get(jobId);
      if (runtime?.child) {
        try {
          process.kill(runtime.child.pid);
        } catch (err) {
          broadcastJobLog(jobId, `プロセス停止に失敗: ${err}`, 'error');
        }
      }
      if (runtime?.tempDir) {
        cleanupTempDir(runtime.tempDir);
      }
      runningConversionJobs.delete(jobId);
    } else {
      const running = runningTranscriptionJobs.get(jobId);
      if (running?.child) {
        try {
          process.kill(running.child.pid);
        } catch (err) {
          broadcastJobLog(jobId, `プロセス停止に失敗: ${err}`, 'error');
        }
      }
      runningTranscriptionJobs.delete(jobId);
    }
  } else {
    return { ok: false, error: 'ジョブは既に完了しています' };
  }

  job.status = 'cancelled';
  job.error = reason;
  job.finishedAt = nowISO();
  job.updatedAt = job.finishedAt;
  job.progress = null;
  job.queuePosition = null;
  job.pid = null;
  updateJobRecordAndStore(job, {
    status: 'cancelled',
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
    error: reason,
    type: jobType,
  });
  historyStorage.appendJobEvent({ jobId, event: 'cancelled', payload: { reason } });
  if (job.tabId) {
    saveTabRecord(job.tabId, { jobId: job.id, state: 'cancelled', updatedAt: job.updatedAt });
  }
  broadcastJobUpdate(job);
  processQueues();
  return { ok: true };
};


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev() && VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    const htmlPath = path.join(__dirname, 'renderer', 'dist', 'index.html');
    mainWindow.loadFile(htmlPath);
  }

  if (isDev()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  try {
    const { path: dbPath } = historyStorage.initialize(app);
    historyDbPath = dbPath;
    cachedRetentionPolicy = summarizePolicy(historyStorage.getRetentionPolicy());
    if (cachedRetentionPolicy.schedule.type === 'interval') {
      updateRetentionSchedule(cachedRetentionPolicy);
    }
    if (typeof historyStorage.getTranscriptionOutputStyle === 'function') {
      transcriptionOutputStyle = historyStorage.getTranscriptionOutputStyle();
    }
    if (typeof historyStorage.getConversionSettings === 'function') {
      applyConversionSettings(historyStorage.getConversionSettings());
    }
    loadPersistedTabs();
    loadPersistedJobs();
    processQueues();
    runRetentionPrune('startup');
  } catch (err) {
    historyInitError = err;
    console.error('Failed to initialize history storage', err);
  }

  createWindow();

  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (historyInitError) {
        emitSystemLog(mainWindow, `DB error: ${historyInitError.message}`);
      } else if (historyDbPath) {
        emitSystemLog(mainWindow, `SQLite history ready: ${historyDbPath}`);
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('system:clipboard:write', async (_event, text) => {
  try {
    const content = typeof text === 'string' ? text : '';
    clipboard.writeText(content);
    return { ok: true };
  } catch (err) {
    console.error('clipboard write failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('system:openExternal', async () => {
  try {
    await shell.openExternal(GPTS_URL);
    return { ok: true };
  } catch (err) {
    console.error('openExternal failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('dialog:openFile', async (_event, options = {}) => {
  const allowMultiple = Boolean(options?.allowMultiple);
  const customProperties = Array.isArray(options?.properties) ? options.properties.slice() : ['openFile'];
  if (allowMultiple && !customProperties.includes('multiSelections')) {
    customProperties.push('multiSelections');
  }
  const directoryMode = customProperties.some((prop) => typeof prop === 'string' && prop.toLowerCase().includes('directory'));
  const filters = directoryMode
    ? undefined
    : Array.isArray(options?.filters) && options.filters.length > 0
    ? options.filters
    : [
        { name: 'Media', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'avi', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ];

  const dialogOptions = {
    properties: customProperties,
  };
  if (filters) {
    dialogOptions.filters = filters;
  }
  if (typeof options?.defaultPath === 'string' && options.defaultPath.trim().length > 0) {
    dialogOptions.defaultPath = options.defaultPath;
  }

  const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner ?? undefined, dialogOptions);
  if (canceled || filePaths.length === 0) return null;
  return allowMultiple ? filePaths : filePaths[0];
});

ipcMain.handle('file:readText', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new Error('Invalid path');
  }
  const resolved = path.resolve(targetPath);
  const roots = allowedRoots();
  const permitted = roots.some((root) => {
    try {
      return isPathInside(resolved, root) || resolved === root;
    } catch (err) {
      return false;
    }
  });
  if (!permitted) {
    throw new Error('Access denied');
  }
  return fs.promises.readFile(resolved, 'utf-8');
});

ipcMain.handle('conversion:enqueue', async (_event, payload) => {
  try {
    if (Array.isArray(payload)) {
      const jobs = payload.map((item) => jobToSummary(enqueueConversionJob(item)));
      return { ok: true, jobs };
    }
    const job = enqueueConversionJob(payload);
    return { ok: true, job: jobToSummary(job) };
  } catch (err) {
    console.error('conversion:enqueue failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('conversion:list', async () => {
  try {
    const jobs = Array.from(jobStore.values())
      .filter((job) => looksLikeConversionJob(job))
      .map((job) => jobToSummary(job));
    return { ok: true, jobs };
  } catch (err) {
    console.error('conversion:list failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('conversion:history', async (_event, options = {}) => {
  try {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit))) : 50;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0;
    const jobs = historyStorage
      .listJobs({ limit, offset, type: 'conversion', order: 'desc' })
      .map((job) => jobToSummary(job));
    const total = historyStorage.countJobs({ type: 'conversion' });
    return { ok: true, jobs, limit, offset, total };
  } catch (err) {
    console.error('conversion:history failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('conversion:cancel', async (_event, jobId) => {
  try {
    return cancelJob(jobId, 'user');
  } catch (err) {
    console.error('conversion:cancel failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('conversion:link', async (_event, payload) => {
  try {
    const conversionId = String(payload?.conversionJobId ?? '');
    const transcriptionId = String(payload?.transcriptionJobId ?? '');
    if (!conversionId || !transcriptionId) {
      throw new Error('conversionJobId と transcriptionJobId が必要です');
    }
    const conversionJob = jobStore.get(conversionId);
    if (!conversionJob) {
      throw new Error('対象の変換ジョブが見つかりません');
    }
    updateJobRecordAndStore(conversionJob, {
      metadata: {
        ...(conversionJob.metadata ?? {}),
        linkedTranscriptionJobId: transcriptionId,
      },
    });
    broadcastJobUpdate(conversionJob);
    return { ok: true };
  } catch (err) {
    console.error('conversion:link failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('conversion:settings:get', async () => {
  try {
    return { ok: true, settings: conversionSettings };
  } catch (err) {
    console.error('conversion:settings:get failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('conversion:settings:set', async (_event, next) => {
  try {
    const stored = historyStorage.setConversionSettings(next);
    applyConversionSettings(stored);
    processQueues();
    return { ok: true, settings: conversionSettings };
  } catch (err) {
    console.error('conversion:settings:set failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('jobs:enqueue', async (_event, payload) => {
  try {
    const job = enqueueJob(payload);
    return { ok: true, job: jobToSummary(job) };
  } catch (err) {
    console.error('jobs:enqueue failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('jobs:list', async () => {
  try {
    const jobs = Array.from(jobStore.values()).map((job) => jobToSummary(job));
    return { ok: true, jobs };
  } catch (err) {
    console.error('jobs:list failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('jobs:cancel', async (_event, jobId) => {
  try {
    return cancelJob(jobId, 'user');
  } catch (err) {
    console.error('jobs:cancel failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('tabs:list', async () => {
  try {
    const tabs = Array.from(tabStore.values()).map((tab) => tabToSummary(tab));
    return { ok: true, tabs };
  } catch (err) {
    console.error('tabs:list failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('tabs:create', async (_event, payload) => {
  try {
    const title = payload?.title && String(payload.title).trim().length > 0 ? String(payload.title).trim() : '新しいタブ';
    const record = historyStorage.createTabRecord({ title });
    tabStore.set(record.id, record);
    broadcastTabUpdate(record);
    return { ok: true, tab: tabToSummary(record) };
  } catch (err) {
    console.error('tabs:create failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('tabs:update', async (_event, payload) => {
  try {
    if (!payload?.id) throw new Error('tab id is required');
    const updated = saveTabRecord(payload.id, payload);
    if (!updated) throw new Error('tab not found');
    return { ok: true, tab: tabToSummary(updated) };
  } catch (err) {
    console.error('tabs:update failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('tabs:delete', async (_event, tabId) => {
  try {
    if (!tabId) throw new Error('tab id is required');
    const result = removeTabRecord(tabId);
    return { ok: true, removed: result.changes };
  } catch (err) {
    console.error('tabs:delete failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('history:list', async (_event, options = {}) => {
  try {
    const rawLimit = Number(options.limit);
    const rawOffset = Number(options.offset);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 20;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const items = historyStorage.listTranscriptions({ limit, offset });
    const total = historyStorage.countTranscriptions();
    return { ok: true, items, total, limit, offset };
  } catch (err) {
    console.error('history:list failed', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('history:detail', async (_event, id) => {
  try {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error('Invalid history id');
    }
    const item = historyStorage.getTranscription(numericId) ?? null;
    return { ok: true, item };
  } catch (err) {
    console.error('history:detail failed', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('history:clear', async () => {
  try {
    const { changes } = historyStorage.clearAll();
    const total = historyStorage.countTranscriptions();
    BrowserWindow.getAllWindows().forEach((win) => {
      emitSystemLog(win, `履歴を削除しました (${changes}件)`);
      win.webContents.send('history:cleared', { removed: changes, total });
    });
    return { ok: true, removed: changes };
  } catch (err) {
    console.error('history:clear failed', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('history:delete', async (_event, ids) => {
  try {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { ok: true, removed: 0 };
    }
    const numericIds = ids
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (numericIds.length === 0) {
      return { ok: true, removed: 0 };
    }
    const { changes } = historyStorage.deleteByIds(numericIds);
    const total = historyStorage.countTranscriptions();
    BrowserWindow.getAllWindows().forEach((win) => {
      emitSystemLog(win, `履歴から ${changes} 件を削除しました`);
      win.webContents.send('history:deleted', { removed: changes, ids: numericIds, total });
    });
    return { ok: true, removed: changes };
  } catch (err) {
    console.error('history:delete failed', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:retention:get', async () => {
  try {
    const policy = historyStorage.getRetentionPolicy();
    cachedRetentionPolicy = summarizePolicy(policy);
    return { ok: true, policy: cachedRetentionPolicy };
  } catch (err) {
    console.error('settings:retention:get failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('settings:retention:set', async (_event, nextPolicy) => {
  try {
    const stored = historyStorage.setRetentionPolicy(nextPolicy);
    cachedRetentionPolicy = summarizePolicy(stored);
    updateRetentionSchedule(cachedRetentionPolicy);
    runRetentionPrune('policy-update');
    return { ok: true, policy: cachedRetentionPolicy };
  } catch (err) {
    console.error('settings:retention:set failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('settings:transcription:get', async () => {
  try {
    transcriptionOutputStyle = historyStorage.getTranscriptionOutputStyle();
    return { ok: true, outputStyle: transcriptionOutputStyle };
  } catch (err) {
    console.error('settings:transcription:get failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('settings:transcription:set', async (_event, next) => {
  try {
    transcriptionOutputStyle = historyStorage.setTranscriptionOutputStyle(next);
    return { ok: true, outputStyle: transcriptionOutputStyle };
  } catch (err) {
    console.error('settings:transcription:set failed', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
});
