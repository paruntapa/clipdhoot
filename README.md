# Clip Dhoot

Clip Dhoot turns a downloaded stream or video into suggested short-form clips. Whisper transcription, moment suggestions, caption timing, and FFmpeg exports run locally. The app defaults to Whisper large-v3, tries a supported GPU backend first, and falls back to CPU int8. OpenRouter is optional and is only used when you ask it to rank suggested moments.

## 1. Install prerequisites (Windows)

Install these before cloning or launching the app:

- [Git](https://git-scm.com/download/win)
- [Bun 1.2 or newer](https://bun.sh/)
- [Python 3.11](https://www.python.org/downloads/) (select Add Python to PATH in the installer)
- [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) and FFprobe, with their `bin` folder added to `PATH`

Open a new PowerShell window and confirm `bun --version`, `py -3.11 --version`, `ffmpeg -version`, and `ffprobe -version` work.

## 2. Clone and set up the repository

Replace `<repository-url>` with the Git URL for this project:

```powershell
git clone <repository-url> clipdhoot
cd clipdhoot
bun install
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

The first transcription downloads the selected faster-whisper model automatically. large-v3 is selected by default and may take several minutes to download. Model files are stored in the local Hugging Face cache, not in the Git repository. You need internet access for that first model download; video transcription and rendering then run on your computer.

## 3. Start the app

```powershell
bun run dev
```

Open [http://localhost:3000](http://localhost:3000). Keep that terminal open while using the app. Press `Ctrl+C` in it to stop the server.

## 4. Make a clip

1. Choose a Whisper model and the language spoken in the stream. For English streams, **large-v3 + English** is the accuracy-first default; choose **medium.en** for faster CPU processing.
2. Select or drop a video file. Wait for transcription and candidate moments. Longer videos take longer to process.
3. Click a candidate time range to preview it. Review the context, then adjust its In and Out times.
4. Choose **Pop**, **Clean**, or **Neon** under Caption look. Whisper captions are split into short, word-timed groups; the active word highlights as it is spoken.
5. Click **Export clip**. The app renders a 9:16 MP4 and downloads it through your browser. Watch the finished clip and correct any Whisper errors before posting.

## Whisper model and language choices

- `large-v3` is the default accuracy-first choice. The app tries a CTranslate2 GPU backend and falls back to CPU int8 if GPU initialization or inference fails. On CPU, long streams can take a long time.
- `small.en` and `medium.en` are English-only alternatives; `medium.en` is a good balance when CPU speed matters.
- `small` and `medium` support multiple languages. Choose the spoken language when known; use Auto detect when it varies.
- A forced language can help when auto-detection mistakes slang, names, or noisy speech for another language. The app reports the model, execution device, and detected language after processing.

The app uses `faster-whisper`; there is no separate Whisper server to install. GPU acceleration depends on a GPU-enabled CTranslate2 runtime. NVIDIA requires its compatible CUDA/cuDNN runtime; AMD GPUs require a ROCm/HIP-enabled CTranslate2 build. If no usable backend is detected, the app safely uses CPU int8.

The RX 7600 is an RDNA 3 GPU that CTranslate2 lists as supported through ROCm/HIP on Windows, but the standard Python install may not include that backend. See the [official Windows ROCm build guide](https://opennmt.net/CTranslate2/building_rocm_windows.html) if you want to enable it; the app's device probe will show whether your current install can see the GPU.

For this repository on an RX 7600, close Clip Dhoot and run the included installer from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_rocm_windows.ps1
```

It installs AMD's ROCm runtime and the official CTranslate2 ROCm wheel for Python 3.11, then verifies GPU detection. It downloads roughly 2.7 GB, plus temporary extraction space. Restart `bun run dev` afterward. If detection still reports zero GPUs, the app continues on CPU int8.

## Optional OpenRouter ranking

To enable **Rank with AI**, add your OpenRouter key to `.env`:

```dotenv
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
```

Restart `bun run dev` after changing `.env`. AI ranking is optional and does not receive the video, only candidate transcript text and timestamps. Whisper, suggestions, captions, and export work without an API key. Check your OpenRouter model pricing and usage.

## Troubleshooting

- **`ffmpeg` or `ffprobe` not found:** add FFmpeg's `bin` directory to Windows `PATH`, open a new terminal, and retry the version commands.
- **Python environment missing:** from the repo root, rerun the venv and pip commands in section 2.
- **Wrong detected language or bad captions:** reprocess the video with the correct language selected. For English, choose English rather than Auto detect; try `large-v3` or `medium.en` for clearer recognition. Streamer names, slang, music, and overlapping voices may still need manual review.
- **Changed code but browser looks unchanged:** leave `bun run dev` running, refresh the page with `Ctrl+F5`, and upload/process the video again. A previous job keeps the transcript generated with its original settings.
- **Need disk space:** uploaded videos and rendered exports are in `data/`. Delete old job folders there when the app is stopped.

## MVP notes

The interface uses a charcoal and silver theme. Candidate suggestions are review prompts, not a promise of virality. The export center-fits the source over a blurred vertical background; check that the action and streamer remain visible. The tool does not capture live streams or publish to social accounts. Only create and post clips you have permission to use.
