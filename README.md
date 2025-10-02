# Revoice — Local Transcription CLI

Revoice is a local, offline-first transcription CLI for SASUKE Short projects. It wraps `faster-whisper` (CTranslate2) and bundles an ffmpeg binary via `imageio-ffmpeg`.

## Install (editable in current venv)

```
# from repo root, inside an activated venv
python -m pip install -e .
# verify the core dependency resolved
python -m pip show faster-whisper
```

> If you previously ran `python -m pip install -e Revoice`, rerun the command above so that the editable install can see `pyproject.toml` and pull in the dependencies.

## Usage

```
# minimal
revoice INPUT

# typical (Japanese, high accuracy)
revoice "リキッドデス(1).mov" \
  --model large-v3 \
  --language ja \
  --beam_size 5 \
  --compute_type int8 \
  --initial_prompt "リキッドデス, Liquid Death, 炭酸水, ドリンク" \
  --output_dir archive \
  --formats txt,srt,vtt \
  --with_timestamps
```

## Options

- `--output_dir` directory for outputs (default `archive`)
- `--model` whisper model id (default `large-v3`)
- `--language` language code, e.g., `ja`
- `--beam_size` decoding beams (default `5`)
- `--compute_type` `auto|int8|int8_float16|float16|float32`
- `--initial_prompt` biasing prompt for proper nouns
- `--with_timestamps` include timestamps in `.txt`
- `--formats` comma list of `txt,srt,vtt`
- `--replace` comma list `A=>B,C=>D` for post-fix
- `--no_vad` disable VAD filter
- `--min_segment` merge segments shorter than N seconds (default `0.6`)
- `--preset` `balanced|greedy|beam` (default `balanced`)
- `--memo` create SASUKE memo with front matter

## Notes
- ffmpeg is resolved from `imageio-ffmpeg` binary if available, else `ffmpeg` on PATH.
- Outputs: `<output_dir>/<basename>.{txt,srt,vtt}` and an optional preview memo in `01_メモ/`.
