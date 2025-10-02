const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const historyStorage = require('./history/storage');

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
let mainWindow;
let historyDbPath = null;
let historyInitError = null;
let retentionTimer = null;
let cachedRetentionPolicy = null;

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

ipcMain.on('transcribe:start', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const python = resolvePython();
  const projectRoot = resolveProjectRoot();
  const startedAtTs = Date.now();

  const args = [
    '-m', 'revoice.cli',
    payload.inputPath,
    '--output_dir', '', // placeholder; we compute absolute below
    '--model', payload.model || 'large-v3',
    '--language', payload.language || 'ja',
    '--beam_size', String(payload.beamSize ?? 5),
    '--compute_type', payload.computeType || 'int8',
    '--formats', payload.formats || 'txt,srt,vtt',
  ];

  if (payload.initialPrompt && payload.initialPrompt.trim()) {
    args.push('--initial_prompt', payload.initialPrompt);
  }
  if (payload.withTimestamps) {
    args.push('--with_timestamps');
  }
  if (payload.replace && payload.replace.trim()) {
    args.push('--replace', payload.replace);
  }
  if (payload.noVad) {
    args.push('--no_vad');
  }
  if (payload.minSegment) {
    args.push('--min_segment', String(payload.minSegment));
  }
  if (payload.preset) {
    args.push('--preset', payload.preset);
  }
  if (payload.memo) {
    args.push('--memo');
  }

  // Compute working/output directories
  let cwd = projectRoot;
  if (app.isPackaged) {
    cwd = path.join(app.getPath('documents'), 'Revoice');
  }
  try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
  const outDir = (() => {
    const user = (payload.outputDir && String(payload.outputDir).trim()) || 'archive';
    return path.isAbsolute(user) ? user : path.join(cwd, user);
  })();
  // Fill in the absolute output dir argument (replace placeholder)
  const idx = args.indexOf('--output_dir');
  if (idx >= 0) args[idx + 1] = outDir;

  const parsedInput = path.parse(payload.inputPath ?? '');
  const inputStem = parsedInput.name || parsedInput.base || 'transcript';
  const transcriptTarget = path.join(outDir, `${inputStem}.txt`);

  const child = spawn(python, args, {
    cwd,
    env: {
      ...process.env,
      // When using system/dev python from sources, keep PYTHONPATH to import `revoice` if not installed.
      PYTHONPATH: app.isPackaged ? '' : (projectRoot + (process.env.PYTHONPATH ? (path.delimiter + process.env.PYTHONPATH) : '')),
      PYTHONNOUSERSITE: '1',
    },
  });

  win.webContents.send('transcribe:pid', child.pid);

  let transcriptHint = transcriptTarget;
  const inspectChunk = (chunk) => {
    const message = chunk.toString();
    const lines = message.split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('[TRANSCRIPT]')) {
        const explicit = trimmed.slice('[TRANSCRIPT]'.length).trim();
        if (explicit) {
          transcriptHint = explicit;
          emitSystemLog(win, `CLI reported transcript: ${explicit}`);
        }
      }
    }
    win.webContents.send('transcribe:log', message);
  };
  child.stdout.on('data', inspectChunk);
  child.stderr.on('data', inspectChunk);
  child.on('error', (err) => {
    win.webContents.send('transcribe:error', String(err));
  });
  child.on('close', (code) => {
    emitSystemLog(win, `プロセスが終了しました (code=${code ?? 'null'})`);
    if (code === 0) {
      let transcriptText = null;
      let outputPath = resolveTranscriptFile(transcriptHint || transcriptTarget);
      if (!outputPath) {
        emitSystemLog(win, `Transcriptファイルを特定できませんでした: ${transcriptHint || transcriptTarget}`);
      }
      if (outputPath) {
        try {
          transcriptText = fs.readFileSync(outputPath, 'utf-8');
          emitSystemLog(win, `Transcriptを読み込みました: ${outputPath}`);
        } catch (err) {
          emitSystemLog(win, `Transcriptの読み込みに失敗しました: ${err}`);
          outputPath = null;
        }
      }

      try {
        const durationSecRaw = (Date.now() - startedAtTs) / 1000;
        const durationSec = Number.isFinite(durationSecRaw) ? Math.max(0, durationSecRaw) : null;
        const record = historyStorage.storeTranscription({
          inputPath: payload.inputPath ?? null,
          outputPath,
          transcript: transcriptText ?? '',
          model: payload.model ?? null,
          language: payload.language ?? null,
          createdAt: new Date().toISOString(),
          duration: durationSec,
          status: 'completed',
        });
        emitSystemLog(win, `履歴を保存しました (#${record.id})`);
        win.webContents.send('history:item-added', record);
      } catch (err) {
        emitSystemLog(win, `履歴の保存に失敗しました: ${err}`);
      }

      win.webContents.send('transcribe:done', { ok: true, outputPath, transcript: transcriptText });
    } else {
      try {
        const durationSecRaw = (Date.now() - startedAtTs) / 1000;
        const durationSec = Number.isFinite(durationSecRaw) ? Math.max(0, durationSecRaw) : null;
        const record = historyStorage.storeTranscription({
          inputPath: payload.inputPath ?? null,
          outputPath: null,
          transcript: '',
          model: payload.model ?? null,
          language: payload.language ?? null,
          createdAt: new Date().toISOString(),
          duration: durationSec,
          status: 'failed',
          notes: `Exit code: ${code ?? 'unknown'}`,
        });
        emitSystemLog(win, `失敗したジョブを履歴に保存しました (#${record.id})`);
        win.webContents.send('history:item-added', record);
      } catch (err) {
        emitSystemLog(win, `失敗ジョブの履歴保存に失敗しました: ${err}`);
      }
      win.webContents.send('transcribe:done', { ok: false, code });
    }
  });
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

ipcMain.on('process:kill', (event, pid) => {
  try {
    process.kill(pid);
  } catch (e) {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.webContents.send('transcribe:log', `[WARN] Failed to kill ${pid}: ${e}`);
  }
});
