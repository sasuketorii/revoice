# Revoice Electron

A React + TypeScript powered Electron GUI that wraps the local Python CLI (`revoice/cli.py`).

## Dev Run

1. Create and activate a Python venv and install CLI deps at repo root:

   ```sh
   python3 -m venv .venv
   source .venv/bin/activate  # Windows: .venv\Scripts\activate
   python -m pip install -U pip
   python -m pip install -e .
   ```

2. Tell the Electron app which Python to use (recommended so the GUI invokes the same venv):

   ```sh
   export REVOICE_PYTHON="$PWD/.venv/bin/python"   # Windows PowerShell: $env:REVOICE_PYTHON = "$PWD/.venv/Scripts/python.exe"
   ```

3. Install dependencies and start the dev combo (Vite renderer + Electron shell):

   ```sh
   cd electron
   npm install
   npm run dev
   ```

   The Vite dev server serves the renderer at `http://localhost:5173` while Electron attaches with IPC. React Fast Refresh + hot reload works out of the box. Pick a media file and press 実行 to kick off transcription; the right pane streams logs with timestamps and severity colouring.

### Useful Scripts

- `npm run renderer:dev` — start only the Vite dev server (handy when launching Electron separately).
- `npm run electron` — wait for the dev server to be ready and launch Electron (used by `npm run dev`).
- `npm run renderer:build` — produce a production renderer bundle under `renderer/dist/`.
- `npm run renderer:preview` — preview the built renderer bundle.

## Notes

- If you don’t set `REVOICE_PYTHON`, the app tries `$VIRTUAL_ENV/bin/python`, then `python3`/`python` on PATH.
- The app invokes `python <repo>/revoice/cli.py` directly and sets `PYTHONPATH` to the repo root; no `pip install` of the package is strictly required, but Python deps in `pyproject.toml` must be installed.
- `ffmpeg` is resolved from `imageio-ffmpeg` if the Python package is installed; otherwise `ffmpeg` must be on PATH.

## Packaging (bundled Python)

`npm run dist` now builds the renderer bundle, embeds a self-contained Python仮想環境（venv）, and packages the Electron shell together with `revoice`。

手順:

1) 依存込みの埋め込みvenvを作成

```
cd electron
npm run prep-python
```

2) パッケージ生成

```
npm run dist
```

これにより `embedded-python/` がアプリに `extraResources` として同梱され、実行時はその `python -m revoice.cli` を起動します。

注意:
- ビルドは各プラットフォーム上で行ってください（Windows は Windows で、macOS は macOS で）。ネイティブ拡張（`faster-whisper`/`ctranslate2`）のホイールが OS 依存のためです。
- `imageio-ffmpeg` は初回実行時に ffmpeg バイナリをダウンロードする場合があります（ネットワーク環境が必要）。完全オフライン配布が必要な場合は、ffmpeg を同梱する構成に拡張できます。

### 代替: PyInstaller 方式
Python 側を単一バイナリ化して同梱することも可能です。ご希望があれば切り替え対応します。
