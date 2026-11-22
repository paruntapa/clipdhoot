import json
import sys
from whisper_runtime import transcribe

video = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "large-v3"
language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None
segments, info, device = transcribe(
    model_name, video, language=language, beam_size=5, vad_filter=True, word_timestamps=True
)
words = []
for segment in segments:
    if segment.words:
        words.extend({"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip()} for w in segment.words)
    else:
        words.append({"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()})
print(json.dumps({"words": words, "detectedLanguage": info.language, "executionDevice": device}, ensure_ascii=False))
