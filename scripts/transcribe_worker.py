"""Persistent line-oriented faster-whisper worker for live video chunks."""
import json
import sys
from whisper_runtime import create_transcriber


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


model_name = sys.argv[1] if len(sys.argv) > 1 else "large-v3"
language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "auto" else None
try:
    transcriber = create_transcriber(model_name)
    emit({"type": "ready", "executionDevice": transcriber.device})
except Exception as exc:
    emit({"type": "fatal", "error": str(exc)})
    raise SystemExit(1)

for line in sys.stdin:
    try:
        request = json.loads(line)
        request_id = request["id"]
        for event in transcriber.transcribe(request["path"], language=language, beam_size=5, vad_filter=True, word_timestamps=True):
            if event["type"] in ("started", "reset"):
                emit({"id": request_id, **event})
                continue
            segment = event["segment"]
            info = event["info"]
            if segment.words:
                words = [{"start": round(word.start, 3), "end": round(word.end, 3), "text": word.word.strip()} for word in segment.words]
            else:
                words = [{"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()}]
            emit({"id": request_id, "type": "segment", "words": words, "progressSeconds": round(segment.end, 2), "detectedLanguage": info.language, "executionDevice": event["executionDevice"]})
        emit({"id": request_id, "type": "done"})
    except Exception as exc:
        emit({"id": request.get("id") if "request" in locals() else None, "type": "error", "error": str(exc)})
