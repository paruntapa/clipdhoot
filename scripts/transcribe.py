import json
import sys
from faster_whisper import WhisperModel

video = sys.argv[1]
# CPU int8 keeps memory use practical on Windows and works without CUDA/ROCm setup.
model = WhisperModel("small", device="cpu", compute_type="int8")
segments, _ = model.transcribe(video, beam_size=3, vad_filter=True, word_timestamps=True)
words = []
for segment in segments:
    if segment.words:
        words.extend({"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip()} for w in segment.words)
    else:
        words.append({"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()})
print(json.dumps(words, ensure_ascii=False))
