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
