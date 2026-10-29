"""Batch process YouTube videos into listening exercises.

Usage:
    python batch_transcribe.py
    python batch_transcribe.py --file urls.txt

Format of urls.txt (each line):
    https://www.youtube.com/watch?v=VIDEO_ID | Video Title (optional)
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def get_video_title(url: str) -> str:
    """yt-dlp kullanarak YouTube videosunun orijinal başlığını çeker."""
    try:
        res = subprocess.run(
            ["yt-dlp", "--get-title", "--no-playlist", url],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return "Untitled Clip"


def main() -> None:
    parser = argparse.ArgumentParser(description="Batch transcribe YouTube listening exercises.")
    parser.add_argument("--file", default="urls.txt", help="Path to text file containing URLs")
    parser.add_argument("--sentences-per-group", type=int, default=2)
    parser.add_argument("--model", default="distil-large-v3")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        print(f"Hata: {file_path} dosyası bulunamadı.")
        sys.exit(1)

    lines = file_path.read_text(encoding="utf-8").splitlines()
    entries = []

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            parts = line.split("|", 1)
            url = parts[0].strip()
            title = parts[1].strip()
        else:
            url = line
            title = None
        entries.append((url, title))

    if not entries:
        print(f"{file_path} içinde işlenecek geçerli bir link bulunamadı.")
        print("Format: https://www.youtube.com/watch?v=ID | Başlık")
        sys.exit(0)

    print(f"\n[INFO] Toplam {len(entries)} video sirayla islenecek...\n" + "=" * 50)

    for i, (url, title) in enumerate(entries, 1):
        if not title:
            print(f"[{i}/{len(entries)}] Baslik aliniyor: {url} ...")
            title = get_video_title(url)

        print(f"\n[{i}/{len(entries)}] Baslatiliyor: {title}")
        print(f"Link: {url}")

        cmd = [
            sys.executable,
            "transcribe.py",
            "--url", url,
            "--title", title,
            "--sentences-per-group", str(args.sentences_per_group),
            "--model", args.model
        ]

        result = subprocess.run(cmd)
        if result.returncode == 0:
            print(f"[OK] [{i}/{len(entries)}] Basariyla tamamlandi: {title}")
        else:
            print(f"[HATA] [{i}/{len(entries)}] Hata olustu, sonraki videoya geciliyor.")
        print("-" * 50)

    print("\n[OK] Tum toplu isleme tamamlandi! 'clips.json' guncellendi.\n")


if __name__ == "__main__":
    main()
