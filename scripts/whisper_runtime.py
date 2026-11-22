"""Choose an available CTranslate2 GPU, falling back to CPU when needed."""
import gc
import os
from pathlib import Path

# The official Windows ROCm wheel stores its DLLs in the Python ROCm SDK.
# Keep the DLL-directory handle alive for the lifetime of this module.
_rocm_dll_directory = None
try:
    from rocm_sdk._devel import get_devel_root

    _rocm_dll_directory = os.add_dll_directory(str(Path(get_devel_root()) / "bin"))
except Exception:
    pass

import ctranslate2
from faster_whisper import WhisperModel


def create_model(model_name: str):
    """Prefer a CUDA or ROCm backend, then use CPU int8."""
    try:
        if ctranslate2.get_cuda_device_count() > 0:
            supported = ctranslate2.get_supported_compute_types("cuda")
            compute_type = next(value for value in ("float16", "int8_float16", "float32") if value in supported)
            return WhisperModel(model_name, device="cuda", compute_type=compute_type), "GPU"
    except Exception:
        # A missing driver/runtime or an unsupported GPU should never block CPU use.
        pass
    return WhisperModel(model_name, device="cpu", compute_type="int8"), "CPU (no usable GPU backend)"


def transcribe(model_name: str, audio_path: str, language: str | None = None, **options):
    model, device = create_model(model_name)
    try:
        segments, info = model.transcribe(audio_path, language=language, **options)
        # Force the lazy generator here so runtime GPU errors can trigger CPU fallback.
        return list(segments), info, device
    except Exception:
        if device == "CPU (no usable GPU backend)":
            raise
        del model
        gc.collect()
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, language=language, **options)
        return list(segments), info, "CPU (GPU failed; fell back)"


class WhisperStream:
    """Keep one model loaded while a live capture is analyzed chunk by chunk."""
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.model, self.device = create_model(model_name)

    def transcribe(self, audio_path: str, language: str | None = None, **options):
        model, device = self.model, self.device
        yield {"type": "started", "executionDevice": device}
        try:
            segments, info = model.transcribe(audio_path, language=language, **options)
            for segment in segments:
                yield {"type": "segment", "segment": segment, "info": info, "executionDevice": device}
        except Exception:
            if device == "CPU (no usable GPU backend)" or device.startswith("CPU"):
                raise
            del model
            gc.collect()
            self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            self.device = "CPU (GPU failed; restarting transcript)"
            model, device = self.model, self.device
            yield {"type": "reset", "executionDevice": device}
            segments, info = model.transcribe(audio_path, language=language, **options)
            for segment in segments:
                yield {"type": "segment", "segment": segment, "info": info, "executionDevice": device}

    @property
    def model_name(self):
        return self._model_name

    @model_name.setter
    def model_name(self, value):
        self._model_name = value


def create_transcriber(model_name: str):
    return WhisperStream(model_name)


def transcribe_stream(model_name: str, audio_path: str, language: str | None = None, **options):
    """Yield completed Whisper segments immediately; restart cleanly on a GPU failure."""
    transcriber = create_transcriber(model_name)
    yield from transcriber.transcribe(audio_path, language=language, **options)
