"""Find unusually energetic audio windows when Whisper cannot be installed."""
import array
import json
import math
import sys
import wave

path = sys.argv[1]
window = 2.0
with wave.open(path, "rb") as source:
    rate = source.getframerate()
    frames_per_window = int(rate * window)
    readings = []
    while True:
        raw = source.readframes(frames_per_window)
        if not raw:
            break
        samples = array.array("h")
        samples.frombytes(raw)
        if sys.byteorder != "little":
            samples.byteswap()
        if samples:
            rms = math.sqrt(sum(x * x for x in samples) / len(samples))
            readings.append(rms)

if not readings:
    print("[]")
    raise SystemExit

# Ignore quiet/silent windows, then choose distinct high-energy points.
ordered = sorted(readings)
floor = ordered[int(len(ordered) * 0.25)]
ceiling = ordered[int(len(ordered) * 0.98)] or 1
peaks = []
for i, value in enumerate(readings):
    before = readings[max(0, i - 2):i]
    after = readings[i + 1:i + 3]
    if value >= floor * 1.3 and value >= (max(before) if before else 0) and value >= (max(after) if after else 0):
        peaks.append((value, i * window))
peaks.sort(reverse=True)
selected = []
for value, at in peaks:
    start = max(0, at - 12)
    end = start + 32
    if end > len(readings) * window:
        end = len(readings) * window
        start = max(0, end - 32)
    if end - start >= 12 and all(abs(at - p[0]) >= 40 for p in selected):
        score = round(55 + 40 * min(1, (value - floor) / max(1, ceiling - floor)))
        selected.append((at, {"id": len(selected) + 1, "start": round(start, 2), "end": round(end, 2), "text": "", "score": score, "reason": "Unusually high audio energy; review the video for a clear reaction or moment."}))
    if len(selected) >= 20:
        break
print(json.dumps([item[1] for item in sorted(selected, key=lambda item: item[1]["start"])], ensure_ascii=False))
