const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
}

function findSystemPython() {
  if (process.env.REVOICE_PYTHON) return process.env.REVOICE_PYTHON;
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch (_) {}
  }
  throw new Error('No system Python found. Set REVOICE_PYTHON to a Python 3.10+ interpreter.');
}

function venvPythonPath(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const electronDir = path.resolve(__dirname, '..');
  const venvDir = path.join(electronDir, 'embedded-python');

  if (!fs.existsSync(path.join(repoRoot, 'pyproject.toml'))) {
    throw new Error('Run this from the cloned repository. pyproject.toml not found.');
  }

  if (!fs.existsSync(venvDir)) fs.mkdirSync(venvDir, { recursive: true });

  const sysPython = findSystemPython();
  console.log(`[prep-python] Using system Python: ${sysPython}`);

  // Create venv
  run(sysPython, ['-m', 'venv', venvDir]);

  const py = venvPythonPath(venvDir);
  console.log(`[prep-python] Venv python: ${py}`);

  // Upgrade build tools
  run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel']);

  // Install the project (this installs revoice + dependencies into the venv)
  run(py, ['-m', 'pip', 'install', '.'], { cwd: repoRoot });

  // Print console entry presence (best-effort)
  const binDir = process.platform === 'win32' ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
  const revoiceCmd = process.platform === 'win32' ? path.join(binDir, 'revoice.exe') : path.join(binDir, 'revoice');
  if (fs.existsSync(revoiceCmd)) {
    console.log(`[prep-python] Installed console script: ${revoiceCmd}`);
  } else {
    console.warn('[prep-python] revoice console script not found; will run as "-m revoice.cli" at runtime');
  }

  console.log('[prep-python] Done. The venv will be packaged via extraResources.');
}

main();

