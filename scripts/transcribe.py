import json
import sys
from whisper_runtime import transcribe_stream

video = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "large-v3"
language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None
def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


for event in transcribe_stream(
    model_name, video, language=language, beam_size=5, vad_filter=True, word_timestamps=True
):
    if event["type"] == "started":
        emit(event)
        continue
    if event["type"] == "reset":
        emit(event)
        continue
    segment = event["segment"]
    info = event["info"]
    words = []
    if segment.words:
        words.extend({"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip()} for w in segment.words)
    else:
        words.append({"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()})
    emit({"type": "segment", "words": words, "progressSeconds": round(segment.end, 2), "detectedLanguage": info.language, "executionDevice": event["executionDevice"]})
emit({"type": "done"})
