const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const historyStorage = require('./history/storage');

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
let mainWindow;
let historyDbPath = null;
let historyInitError = null;
let retentionTimer = null;
let cachedRetentionPolicy = null;
let transcriptionOutputStyle = 'plain';
const MAX_CONCURRENT_JOBS = 4;
const jobStore = new Map();
const runningJobs = new Map();
const jobQueue = [];
const tabStore = new Map();

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

function emitSystemLog(win, message) {
  if (!win) return;
  win.webContents.send('transcribe:log', `[SYSTEM] ${message}`);
}

function broadcastSystemLog(message) {
  BrowserWindow.getAllWindows().forEach((win) => emitSystemLog(win, message));
}

const nowISO = () => new Date().toISOString();

const jobToSummary = (job) => {
  if (!job) return null;
  return {
    id: job.id,
    tabId: job.tabId ?? null,
    status: job.status,
    type: job.type ?? 'transcription',
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

const recomputeQueuePositions = () => {
  jobQueue.forEach((jobId, index) => {
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
      if (job.status === 'running') {
        job.status = 'queued';
        job.startedAt = null;
        job.finishedAt = null;
        historyStorage.updateJobRecord(job.id, {
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          updatedAt: nowISO(),
        });
      }
      jobStore.set(job.id, job);
      if (job.status === 'queued') {
        jobQueue.push(job.id);
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
  const stored = historyStorage.updateJobRecord(job.id, {
    tabId: patch.tabId ?? job.tabId ?? null,
    type: patch.type ?? job.type ?? 'transcription',
    status: patch.status ?? job.status,
    inputPath: patch.inputPath ?? job.inputPath ?? null,
    outputPath: patch.outputPath ?? job.outputPath ?? null,
    resultPath: patch.resultPath ?? job.resultPath ?? null,
    error: patch.error ?? job.error ?? null,
    startedAt: patch.startedAt ?? job.startedAt ?? null,
    finishedAt: patch.finishedAt ?? job.finishedAt ?? null,
    updatedAt: patch.updatedAt ?? nowISO(),
    metadata: {
      ...(job.metadata ?? {}),
      ...(patch.metadata ?? {}),
    },
  });
  if (stored) {
    Object.assign(job, stored);
  }
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
  jobQueue.push(jobId);
  historyStorage.appendJobEvent({ jobId, event: 'queued', payload: { reason: 'enqueue' } });
  broadcastJobUpdate(job);
  processJobQueue();
  return job;
};

const processJobQueue = () => {
  while (runningJobs.size < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
    const jobId = jobQueue.shift();
    const job = jobStore.get(jobId);
    if (!job) continue;
    startJob(job);
  }
  recomputeQueuePositions();
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

const removeFromQueue = (jobId) => {
  const index = jobQueue.indexOf(jobId);
  if (index >= 0) {
    jobQueue.splice(index, 1);
  }
};

const startJob = (job) => {
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
  runningJobs.set(job.id, { child, transcriptHint: transcriptPath, startedAt: Date.now() });

  const inspectChunk = (chunk) => {
    const message = chunk.toString();
    const lines = message.split(/\r?\n/);
    for (const raw of lines) {
      const text = raw.trim();
      if (!text) continue;
      if (text.startsWith('[TRANSCRIPT]')) {
        const explicit = text.slice('[TRANSCRIPT]'.length).trim();
        if (explicit) {
          const state = runningJobs.get(job.id);
          if (state) state.transcriptHint = explicit;
          broadcastJobLog(job.id, `Transcript path reported: ${explicit}`, 'info');
        }
        continue;
      }
      const progressMatch = /^\[PROGRESS\]\s+(\d+(?:\.\d+)?)$/.exec(text);
      if (progressMatch) {
        const value = Number(progressMatch[1]);
        if (!Number.isNaN(value)) {
          job.progress = Math.max(0, Math.min(100, value));
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
    const state = runningJobs.get(job.id);
    const hint = state?.transcriptHint ?? transcriptPath;
    finalizeJob(job, code, hint);
  });
};

const finalizeJob = (job, exitCode, transcriptHint) => {
  const running = runningJobs.get(job.id);
  runningJobs.delete(job.id);
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
        notes: `Exit code: ${exitCode ?? 'unknown'}`,
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
  });
  historyStorage.appendJobEvent({ jobId: job.id, event: job.status, payload: { exitCode } });
  if (job.tabId) {
    saveTabRecord(job.tabId, { jobId: job.id, state: job.status, updatedAt: finishedAt });
  }
  broadcastJobUpdate(job);
  processJobQueue();
};

const cancelJob = (jobId, reason = 'user') => {
  const job = jobStore.get(jobId);
  if (!job) {
    return { ok: false, error: 'ジョブが見つかりません' };
  }
  if (job.status === 'queued') {
    removeFromQueue(jobId);
  } else if (job.status === 'running') {
    const running = runningJobs.get(jobId);
    if (running?.child) {
      try {
        process.kill(running.child.pid);
      } catch (err) {
        broadcastJobLog(jobId, `プロセス停止に失敗: ${err}`, 'error');
      }
    }
    runningJobs.delete(jobId);
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
  });
  historyStorage.appendJobEvent({ jobId, event: 'cancelled', payload: { reason } });
  if (job.tabId) {
    saveTabRecord(job.tabId, { jobId: job.id, state: 'cancelled', updatedAt: job.updatedAt });
  }
  broadcastJobUpdate(job);
  processJobQueue();
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
    loadPersistedTabs();
    loadPersistedJobs();
    processJobQueue();
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

ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Media', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mkv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0];
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
