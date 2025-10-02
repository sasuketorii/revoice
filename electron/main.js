const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
let mainWindow;

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
  createWindow();
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
      win.webContents.send('transcribe:done', { ok: true, outputPath, transcript: transcriptText });
    } else {
      win.webContents.send('transcribe:done', { ok: false, code });
    }
  });
});

ipcMain.on('process:kill', (event, pid) => {
  try {
    process.kill(pid);
  } catch (e) {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.webContents.send('transcribe:log', `[WARN] Failed to kill ${pid}: ${e}`);
  }
});
