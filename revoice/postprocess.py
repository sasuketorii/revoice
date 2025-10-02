"""Utilities for formatting transcription output text for Revoice."""

from __future__ import annotations

import re
from typing import Iterable, List, Sequence, Tuple

Segment = Tuple[float, float, str]

SENTENCE_ENDERS = "。.!?！？…‥"


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _collect_sentences(chunks: Iterable[str]) -> List[str]:
    """Split raw transcript chunks into lightweight sentences."""

    joined = _normalize_whitespace(" ".join(chunk.strip() for chunk in chunks if chunk.strip()))
    if not joined:
        return []

    sentences: List[str] = []
    buffer: List[str] = []
    for ch in joined:
        buffer.append(ch)
        if ch in SENTENCE_ENDERS:
            sentence = _normalize_whitespace("".join(buffer))
            if sentence:
                sentences.append(sentence)
            buffer = []
    if buffer:
        sentence = _normalize_whitespace("".join(buffer))
        if sentence:
            sentences.append(sentence)
    return sentences


def format_plain_text(segments: Sequence[Segment], sentences_per_paragraph: int = 3) -> str:
    sentences = _collect_sentences(seg[2] for seg in segments)
    if not sentences:
        return ""
    paragraphs = ["".join(sentences[i : i + sentences_per_paragraph]) for i in range(0, len(sentences), sentences_per_paragraph)]
    return "\n\n".join(paragraphs)


def format_markdown_text(segments: Sequence[Segment]) -> str:
    sentences = _collect_sentences(seg[2] for seg in segments)
    if not sentences:
        return ""
    return "\n".join(f"- {sentence}" for sentence in sentences)


def format_transcript(segments: Sequence[Segment], style: str) -> str:
    """Return formatted transcript text for the requested style."""

    style = (style or "plain").lower()
    if style == "plain":
        return format_plain_text(segments)
    if style == "markdown":
        return format_markdown_text(segments)
    raise ValueError(f"Unsupported transcript style: {style}")


__all__ = ["format_transcript", "format_plain_text", "format_markdown_text"]
