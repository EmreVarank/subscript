"""Download a YouTube video and create timed sentence-group listening exercises.

Usage:
    python transcribe.py --url "https://youtube.com/watch?v=661f6PkKOL0" --title "Clay Accepts His Fate"

Output (written to the clips/ folder next to this script):
    clips/<slug>.txt   – plain-text transcript, one sentence per line
    clips/<slug>.json  – structured data with groups and blank indexes
    clips.json         – catalog of all processed clips (updated in place)
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


# ─── Constants ────────────────────────────────────────────────────────────────

SENTENCE_END = re.compile(r'[.!?]["\'\)\]]*$')
YOUTUBE_ID_RE = re.compile(r'(?:v=|youtu\.be/|/v/|/embed/)([A-Za-z0-9_-]{11})')

# Directory layout: all output files live next to this script
SCRIPT_DIR = Path(__file__).parent
CLIPS_DIR = SCRIPT_DIR / "clips"
CATALOG_PATH = SCRIPT_DIR / "clips.json"


# ─── YouTube helpers ──────────────────────────────────────────────────────────

def extract_youtube_id(url: str) -> str:
    m = YOUTUBE_ID_RE.search(url)
    if not m:
        raise SystemExit(f"Could not parse a YouTube video ID from: {url}")
    return m.group(1)


def slugify(text: str) -> str:
    """Convert a title to a safe filename slug."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def download_audio(url: str, out_dir: Path) -> Path:
    """
    Download the best available audio stream with yt-dlp.
    We request a native audio format (m4a / webm / opus) so that
    no ffmpeg post-processing is needed.  faster-whisper handles
    these formats directly via ffmpeg bundled inside ctranslate2.
    """
    out_template = str(out_dir / "audio.%(ext)s")
    result = subprocess.run(
        [
            "yt-dlp",
            # Prefer m4a; fall back to webm or whatever is available.
            # No --extract-audio so ffmpeg is NOT required for this step.
            "--format", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "--no-playlist",
            "-o", out_template,
            url,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit("yt-dlp failed. Make sure it is installed: pip install yt-dlp")

    for ext in ("m4a", "mp3", "webm", "opus", "ogg", "wav"):
        path = out_dir / f"audio.{ext}"
        if path.exists():
            return path
    raise SystemExit("yt-dlp finished but no audio file was found in the temp directory.")


# ─── Transcription helpers ────────────────────────────────────────────────────

def sentence_text(words: list[dict[str, Any]]) -> str:
    """Join Whisper word tokens into a readable string."""
    return "".join(w["text"] for w in words).strip()


def choose_blanks(text: str, max_blanks: int = 3) -> list[int]:
    """
    Pick word positions to blank out.
    Rules:
      • Only words with 5+ letters qualify (skips short connectors like
        "yeah", "know", "with", "that" etc.).
      • At most `max_blanks` blanks; at least 1 if any candidate exists.
      • Distributed evenly across the sentence.
    """
    tokens = text.split()
    candidates = [
        i for i, t in enumerate(tokens)
        if len(re.sub(r"[^A-Za-z]", "", t)) >= 5
    ]
    if not candidates:
        return []
    count = min(max_blanks, max(1, len(candidates) // 3))
    spacing = max(1, len(candidates) // count)
    return candidates[::spacing][:count]


def words_to_sentences(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Split a flat word list into learner-friendly sentences.
    A new sentence starts when:
      • The previous word ended with sentence-ending punctuation, OR
      • There is a pause ≥ 0.65 s and the current buffer has ≥ 3 words.
    """
    sentences: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []

    def flush() -> None:
        if not current:
            return
        text = sentence_text(current)
        sentences.append(
            {
                "start": round(current[0]["start"], 2),
                "end": round(current[-1]["end"], 2),
                "text": text,
                "blankIndexes": choose_blanks(text),
            }
        )
        current.clear()

    for word in words:
        if current:
            pause = word["start"] - current[-1]["end"]
            if pause >= 0.65 and len(current) >= 3:
                flush()

        current.append(word)

        if SENTENCE_END.search(word["text"].strip()):
            flush()

    flush()
    return sentences


def group_sentences(
    sentences: list[dict[str, Any]], group_size: int, max_gap_seconds: float = 10.0
) -> list[dict[str, Any]]:
    """
    Pack sentences into exercise groups of `group_size`.
    Each group is played as one YouTube clip segment.

    Hard split rule: if the silence gap between two consecutive sentences
    exceeds `max_gap_seconds`, always start a new group regardless of
    how many sentences are in the current one. This prevents groups that
    span long scene breaks or music passages.
    """
    groups: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []

    for sentence in sentences:
        # Force a new group on large gaps, even if current is only 1 sentence
        if current:
            gap = sentence["start"] - current[-1]["end"]
            if gap > max_gap_seconds or len(current) >= group_size:
                groups.append({
                    "start": current[0]["start"],
                    "end": current[-1]["end"],
                    "sentences": current,
                })
                current = []
        current.append(sentence)

    if current:
        groups.append({
            "start": current[0]["start"],
            "end": current[-1]["end"],
            "sentences": current,
        })

    return groups


# ─── Catalog helpers ──────────────────────────────────────────────────────────

def load_catalog() -> list[dict[str, Any]]:
    if CATALOG_PATH.exists():
        return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return []


def save_catalog(catalog: list[dict[str, Any]]) -> None:
    CATALOG_PATH.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def upsert_catalog(
    catalog: list[dict[str, Any]], entry: dict[str, Any]
) -> list[dict[str, Any]]:
    idx = next(
        (i for i, c in enumerate(catalog) if c["youtubeId"] == entry["youtubeId"]), None
    )
    if idx is not None:
        catalog[idx] = entry
    else:
        catalog.append(entry)
    return catalog


# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build timestamped listening exercises from a YouTube video."
    )
    parser.add_argument("--url", required=True, help="Full YouTube URL")
    parser.add_argument("--title", required=True, help="Human-readable title for this clip")
    parser.add_argument(
        "--sentences-per-group",
        type=int,
        default=2,
        choices=[1, 2, 3],
        help="How many sentences per exercise step (default: 2)",
    )
    parser.add_argument(
        "--model",
        default="distil-large-v3",
        help="faster-whisper model name (default: distil-large-v3)",
    )
    parser.add_argument(
        "--device",
        choices=["auto", "cpu", "cuda"],
        default="auto",
        help="Compute device (default: auto → cuda if available, else cpu)",
    )
    return parser.parse_args()


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()

    youtube_id = extract_youtube_id(args.url)
    slug = slugify(args.title)
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. Download audio ────────────────────────────────────────────────────
    print(f"\n[1/4] Downloading audio …")
    with tempfile.TemporaryDirectory() as tmp:
        audio_path = download_audio(args.url, Path(tmp))

        # ── 2. Transcribe ────────────────────────────────────────────────────
        print(f"[2/4] Transcribing with faster-whisper ({args.model}) …")
        from faster_whisper import WhisperModel  # imported here to keep startup fast

        device = "cuda" if args.device == "auto" else args.device
        try:
            import torch
            if args.device == "auto" and not torch.cuda.is_available():
                device = "cpu"
        except ImportError:
            device = "cpu"

        compute_type = "float16" if device == "cuda" else "int8"
        model = WhisperModel(args.model, device=device, compute_type=compute_type)

        raw_segments, info = model.transcribe(
            str(audio_path),
            language="en",
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
        )

        words = [
            {"text": word.word, "start": word.start, "end": word.end}
            for segment in raw_segments
            for word in (segment.words or [])
            if word.start is not None and word.end is not None
        ]

    if not words:
        raise SystemExit("No speech detected in this video.")

    # ── 3. Build exercise data ───────────────────────────────────────────────
    print(f"[3/4] Building sentences and groups …")
    sentences = words_to_sentences(words)
    groups = group_sentences(sentences, args.sentences_per_group)
    duration = round(max(w["end"] for w in words), 2)

    # Save plain-text transcript
    txt_path = CLIPS_DIR / f"{slug}.txt"
    txt_path.write_text(
        "\n".join(s["text"] for s in sentences), encoding="utf-8"
    )

    # Save structured JSON
    json_path = CLIPS_DIR / f"{slug}.json"
    payload: dict[str, Any] = {
        "url": args.url,
        "youtubeId": youtube_id,
        "title": args.title,
        "language": info.language,
        "durationSeconds": duration,
        "sentencesPerGroup": args.sentences_per_group,
        "groups": groups,
    }
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # ── 4. Update catalog ────────────────────────────────────────────────────
    print(f"[4/4] Updating catalog …")
    catalog = load_catalog()
    catalog = upsert_catalog(
        catalog,
        {
            "id": slug,
            "url": args.url,
            "youtubeId": youtube_id,
            "title": args.title,
            "durationSeconds": duration,
            "groupCount": len(groups),
            "sentenceCount": len(sentences),
            "dataFile": f"clips/{slug}.json",
        },
    )
    save_catalog(catalog)

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n[OK] Transcript : {txt_path}")
    print(f"[OK] Data       : {json_path}")
    print(f"[OK] Catalog    : {CATALOG_PATH}")
    print(f"  {len(sentences)} sentences -> {len(groups)} groups ({args.sentences_per_group} sentences/group)")


if __name__ == "__main__":
    main()
