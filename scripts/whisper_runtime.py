"""Choose an available CTranslate2 GPU (NVIDIA CUDA or AMD ROCm), falling back to CPU when needed."""
import gc
import os
import sys
from pathlib import Path

# Keep DLL directory handles alive for the lifetime of this process on Windows.
_dll_handles = []

def _add_dll_dir(path):
    p = Path(path)
    if p.is_dir():
        try:
            handle = os.add_dll_directory(str(p))
            _dll_handles.append(handle)
            os.environ["PATH"] = str(p) + os.pathsep + os.environ.get("PATH", "")
        except Exception:
            pass

# 1. NVIDIA pip wheels (nvidia-cublas-cu12, nvidia-cudnn-cu12, etc.)
for pkg in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_runtime", "nvidia.cuda_nvrtc"):
    try:
        import importlib.util
        spec = importlib.util.find_spec(pkg)
        if spec and spec.submodule_search_locations:
            for loc in spec.submodule_search_locations:
                _add_dll_dir(Path(loc) / "bin")
                _add_dll_dir(Path(loc) / "lib")
    except Exception:
        pass

# 2. NVIDIA CUDA Toolkit (via CUDA_PATH or standard paths)
cuda_path = os.environ.get("CUDA_PATH")
if cuda_path:
    _add_dll_dir(Path(cuda_path) / "bin")
for ver in ("v12.6", "v12.5", "v12.4", "v12.3", "v12.2", "v12.1", "v12.0", "v11.8"):
    standard_cuda = Path(f"C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/{ver}/bin")
    if standard_cuda.is_dir():
        _add_dll_dir(standard_cuda)
        break

# 3. PyTorch CUDA DLLs (if torch is installed with CUDA)
try:
    import torch
    _add_dll_dir(Path(torch.__file__).parent / "lib")
except Exception:
    pass

# 4. AMD ROCm SDK (ROCm on Windows)
try:
    from rocm_sdk._devel import get_devel_root
    _add_dll_dir(Path(get_devel_root()) / "bin")
except Exception:
    pass

import ctranslate2
from faster_whisper import WhisperModel


def get_gpu_name():
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}")
        for i in range(winreg.QueryInfoKey(key)[0]):
            try:
                subkey = winreg.OpenKey(key, f"{i:04d}")
                name, _ = winreg.QueryValueEx(subkey, "DriverDesc")
                if name and any(brand in name.lower() for brand in ("nvidia", "geforce", "rtx", "gtx", "quadro", "radeon", "rx")):
                    return name
            except Exception:
                pass
    except Exception:
        pass
    return None


def create_model(model_name: str):
    """Prefer a CUDA or ROCm backend, then use CPU int8."""
    gpu_error = None
    try:
        device_count = ctranslate2.get_cuda_device_count()
        if device_count > 0:
            supported = ctranslate2.get_supported_compute_types("cuda")
            compute_type = next(value for value in ("float16", "int8_float16", "float32") if value in supported)
            model = WhisperModel(model_name, device="cuda", compute_type=compute_type)
            gpu_name = get_gpu_name()
            label = f"GPU ({gpu_name})" if gpu_name else "GPU"
            return model, label
    except Exception as e:
        gpu_error = str(e).split("\n")[0]
        print(f"[whisper_runtime] GPU init failed ({gpu_error}); falling back to CPU.", file=sys.stderr)

    reason = f"CPU ({gpu_error})" if gpu_error else "CPU (no usable GPU backend)"
    return WhisperModel(model_name, device="cpu", compute_type="int8"), reason


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
