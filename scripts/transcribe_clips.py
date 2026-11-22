"""Create readable, word-timed SRT captions for one or more existing clips."""
import json
import sys
from pathlib import Path
from faster_whisper import WhisperModel


def stamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def make_captions(words):
    groups = []
    current = []
    for word in words:
        value = word["text"]
        if not value.strip():
            continue
        combined = "".join(x["text"] for x in current) + value
        if current and (word["end"] - current[0]["start"] > 2.7 or len(combined.strip()) > 38):
            groups.append(current)
            current = []
        current.append({**word, "text": value})
        if value.endswith(('.', '?', '!')) and word["end"] - current[0]["start"] >= 0.9:
            groups.append(current)
            current = []
    if current:
        groups.append(current)

    entries = []
    for group in groups:
        text = "".join(word["text"] for word in group).strip().upper()
        # Split long caption phrases into two balanced lines.
        if len(text) > 20 and " " in text:
            parts = text.split()
            midpoint = len(text) // 2
            split = min(range(1, len(parts)), key=lambda i: abs(len(" ".join(parts[:i])) - midpoint))
            text = " ".join(parts[:split]) + "\n" + " ".join(parts[split:])
        start = group[0]["start"]
        end = max(group[-1]["end"], start + 0.45)
        entries.append(f"{len(entries)+1}\n{stamp(start)} --> {stamp(end)}\n{text}")
    return "\n\n".join(entries) + ("\n" if entries else "")


def main(paths):
    model = WhisperModel("small", device="cpu", compute_type="int8")
    for arg in paths:
        path = Path(arg)
        segments, info = model.transcribe(str(path), beam_size=3, vad_filter=True, word_timestamps=True)
        words = []
        text_segments = []
        for segment in segments:
            text_segments.append({"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()})
            if segment.words:
                words.extend({"start": round(word.start, 3), "end": round(word.end, 3), "text": word.word} for word in segment.words)
        srt_path = path.with_name(path.stem + ".srt")
        json_path = path.with_name(path.stem + ".transcript.json")
        srt_path.write_text(make_captions(words), encoding="utf-8")
        json_path.write_text(json.dumps({"language": info.language, "segments": text_segments}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{path.name}: {len(words)} words, {len(text_segments)} transcript segments, language={info.language}, captions={srt_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python transcribe_clips.py clip1.mp4 [clip2.mp4 ...]")
    main(sys.argv[1:])
