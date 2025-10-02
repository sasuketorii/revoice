import argparse
import datetime as dt
import subprocess
from pathlib import Path
from typing import List, Tuple

try:
    from faster_whisper import WhisperModel
except ModuleNotFoundError as e:
    raise SystemExit(
        "[ERROR] faster-whisper is not installed. "
        "Run `python -m pip install -e .` from the repo root, "
        "or install the package directly with `python -m pip install faster-whisper`."
    ) from e
except Exception as e:
    raise SystemExit("[ERROR] faster-whisper could not be imported: " + str(e))

try:
    import imageio_ffmpeg
except Exception:
    imageio_ffmpeg = None


def emit_progress(percent: float) -> None:
    value = max(0.0, min(percent, 100.0))
    print(f"[PROGRESS] {value:.1f}", flush=True)


def hhmmss_ms(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    s, ms = divmod(ms, 1000)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def webvtt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    s, ms = divmod(ms, 1000)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def write_srt(segments: List[Tuple[float, float, str]], path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(segments, start=1):
            f.write(f"{i}\n{hhmmss_ms(start)} --> {hhmmss_ms(end)}\n{text.strip()}\n\n")


def write_vtt(segments: List[Tuple[float, float, str]], path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for start, end, text in segments:
            f.write(f"{webvtt_ts(start)} --> {webvtt_ts(end)}\n{text.strip()}\n\n")


def format_mmss(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    m, s = divmod(total, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def bucket_segments(segments: List[Tuple[float, float, str]], bucket_seconds: float = 10.0) -> List[Tuple[float, float, str]]:
    if not segments:
        return segments
    if bucket_seconds <= 0:
        return segments
    grouped: List[Tuple[float, float, str]] = []
    current_bucket = int(segments[0][0] // bucket_seconds)
    bucket_start = segments[0][0]
    bucket_end = segments[0][1]
    texts = [segments[0][2]]
    for start, end, text in segments[1:]:
        bucket = int(start // bucket_seconds)
        if bucket == current_bucket:
            bucket_end = max(bucket_end, end)
            texts.append(text)
        else:
            grouped.append((bucket_start, bucket_end, ' '.join(texts).strip()))
            current_bucket = bucket
            bucket_start = start
            bucket_end = end
            texts = [text]
    grouped.append((bucket_start, bucket_end, ' '.join(texts).strip()))
    return grouped


def write_txt(segments: List[Tuple[float, float, str]], path: Path, with_timestamps: bool = False) -> None:
    with path.open("w", encoding="utf-8") as f:
        if with_timestamps:
            for start, end, text in bucket_segments(segments):
                label = format_mmss(start)
                content = text.strip()
                if content:
                    f.write(f"[{label}] {content}\n")
        else:
            for _, __, text in segments:
                f.write(text.strip() + "\n")


def extract_audio(input_path: Path, wav_path: Path, ffmpeg_bin: str = "ffmpeg") -> None:
    cmd = [ffmpeg_bin, "-y", "-i", str(input_path), "-ac", "1", "-ar", "16000", "-vn", str(wav_path)]
    subprocess.run(cmd, check=True)


def apply_replacements(text: str, pairs: List[Tuple[str, str]]) -> str:
    for a, b in pairs:
        text = text.replace(a, b)
    return text


def merge_short_segments(segments: List[Tuple[float, float, str]], min_duration: float = 0.6) -> List[Tuple[float, float, str]]:
    if not segments:
        return segments
    merged = []
    cur_s, cur_e, cur_t = segments[0]
    for s, e, t in segments[1:]:
        if (cur_e - cur_s) < min_duration:
            cur_e = e
            cur_t = (cur_t + " " + t).strip()
        else:
            merged.append((cur_s, cur_e, cur_t))
            cur_s, cur_e, cur_t = s, e, t
    merged.append((cur_s, cur_e, cur_t))
    return merged


def main(argv=None):
    p = argparse.ArgumentParser(prog="revoice", description="Local transcription using faster-whisper (CTranslate2)")
    p.add_argument("input", type=str, help="Input media file (audio/video)")
    p.add_argument("--output_dir", type=str, default="archive", help="Output directory")
    p.add_argument("--model", type=str, default="large-v3", help="Whisper model size/name")
    p.add_argument("--language", type=str, default="ja", help="Language code (e.g., ja, en)")
    p.add_argument("--beam_size", type=int, default=5)
    p.add_argument("--compute_type", type=str, default="int8", choices=["auto","int8","int8_float16","float16","float32"])
    p.add_argument("--initial_prompt", type=str, default="", help="Initial prompt to bias transcription")
    p.add_argument("--with_timestamps", action="store_true", help="Include timestamps in TXT output")
    p.add_argument("--formats", type=str, default="txt,srt,vtt", help="Comma separated: txt,srt,vtt")
    p.add_argument("--replace", type=str, default="", help="Comma-separated replacements like A=>B,C=>D")
    p.add_argument("--no_vad", action="store_true", help="Disable VAD filtering")
    p.add_argument("--min_segment", type=float, default=0.6, help="Merge segments shorter than this (sec)")
    p.add_argument("--preset", type=str, default="balanced", choices=["balanced","greedy","beam"], help="Decode preset")
    p.add_argument("--memo", action="store_true", help="Create SASUKE memo with front matter")
    args = p.parse_args(argv)

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"[ERROR] Input not found: {input_path}")

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    ffmpeg_bin = "ffmpeg"
    if imageio_ffmpeg is not None:
        try:
            ffmpeg_bin = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            pass

    wav_path = out_dir / (input_path.stem + ".wav")
    emit_progress(0.0)
    last_percent = 0.0
    extract_audio(input_path, wav_path, ffmpeg_bin=ffmpeg_bin)
    emit_progress(5.0)
    last_percent = 5.0

    model = WhisperModel(args.model, device="auto", compute_type=args.compute_type)

    vad_filter = not args.no_vad
    decode_options = {
        "beam_size": args.beam_size if args.preset != "greedy" else 1,
        "patience": 1,
    }

    segments_iter, info = model.transcribe(
        str(wav_path),
        language=args.language,
        vad_filter=vad_filter,
        initial_prompt=(args.initial_prompt or None),
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=True,
        **decode_options,
    )

    duration = float(getattr(info, "duration", 0.0) or 0.0)

    raw_segments: List[Tuple[float, float, str]] = []
    for seg in segments_iter:
        text = seg.text.strip()
        raw_segments.append((seg.start, seg.end, text))
        if duration > 0:
            current_percent = max(0.0, min((seg.end / duration) * 100.0, 100.0))
        else:
            current_percent = min(len(raw_segments) * 5.0, 99.0)
        if current_percent >= last_percent + 0.5:
            emit_progress(current_percent)
            last_percent = current_percent

    segments = merge_short_segments(raw_segments, min_duration=args.min_segment)

    pairs: List[Tuple[str, str]] = []
    if args.replace:
        for pair in args.replace.split(","):
            if "=>" in pair:
                a, b = pair.split("=>", 1)
                pairs.append((a.strip(), b.strip()))
    segments = [(s, e, apply_replacements(t, pairs)) for s, e, t in segments]

    formats = [x.strip() for x in args.formats.split(",") if x.strip()]
    base = out_dir / input_path.stem
    transcript_path = None
    if "txt" in formats:
        txt_path = base.with_suffix(".txt")
        write_txt(segments, txt_path, with_timestamps=args.with_timestamps)
        transcript_path = txt_path
    if "srt" in formats:
        write_srt(segments, base.with_suffix(".srt"))
    if "vtt" in formats:
        write_vtt(segments, base.with_suffix(".vtt"))

    if transcript_path is not None:
        try:
            print(f"[TRANSCRIPT] {transcript_path.resolve()}", flush=True)
        except Exception:
            print(f"[TRANSCRIPT] {transcript_path}", flush=True)

    if args.memo:
        today = dt.date.today().strftime("%Y-%m-%d")
        memo_slug = f"{today}_文字起こし-{input_path.stem}"
        memo_path = Path("01_メモ") / f"{memo_slug}.md"
        memo_path.parent.mkdir(parents=True, exist_ok=True)
        front_matter = (
            "---\n"
            f"title: 文字起こしメモ（{input_path.name}）\n"
            f"slug: {memo_slug}\n"
            "phase: memo\n"
            "status: draft\n"
            "tags: [文字起こし, 日本語, Whisper]\n"
            f"created: {today}\n"
            f"updated: {today}\n"
            f"source: {args.output_dir}/{input_path.stem}.txt\n"
            "---\n\n"
        )
        preview_lines = []
        for _, __, t in segments[:10]:
            preview_lines.append(t)
        memo_path.write_text(front_matter + "\n".join(preview_lines) + "\n", encoding="utf-8")

    emit_progress(100.0)
    print("OK: outputs written to", out_dir)


if __name__ == "__main__":
    main()
