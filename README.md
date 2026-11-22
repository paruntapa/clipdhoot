# Clipdhoot MVP

Local-first tool for turning a downloaded video into reviewable short-form clip ideas. It uses local Whisper transcription and inexpensive transcript heuristics by default. Optional OpenRouter AI ranks the suggestions. FFmpeg renders a vertical MP4 with the selected transcript text overlaid as a readable caption.

## Requirements

- Windows 10/11 (or adapt the commands for another OS)
- [Bun](https://bun.sh/) 1.2 or newer
- Python 3.10–3.12
- FFmpeg and FFprobe on `PATH`
- 8 GB free disk space for Python/model setup, plus room for input and rendered files

This MVP deliberately runs Whisper on CPU (`small`, int8). Your Radeon RX 7600 does not require an NVIDIA/CUDA setup; CPU mode keeps setup straightforward and within 16 GB RAM. GPU acceleration can be added later after validating a compatible ROCm/Vulkan build for your machine.

## Setup (PowerShell)

```powershell
bun install
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

Install FFmpeg and ensure both `ffmpeg` and `ffprobe` work from a new terminal. The first transcription downloads the Whisper model automatically. Then run:

```powershell
bun run dev
```

Open http://localhost:3000. Processing stays on this machine. Large video uploads are written under `data/`; remove old job folders manually when you need disk space.

## Optional AI ranking

Set `OPENROUTER_API_KEY` in `.env` and restart the server. The configured default is `google/gemini-3.1-flash-lite`; change `OPENROUTER_MODEL` to another OpenRouter model if needed. AI receives candidate transcript text and timestamps, not the video. Basic suggestions and exports work without an API key. The model and provider price can change; monitor OpenRouter usage.

## MVP boundaries

- Suggestions are heuristics over speech, not a promise of virality. Review candidate moments and adjust the in/out times.
- Captions are a simple single-line overlay based on the chosen transcript segment; word-synced karaoke captions and visual subject tracking are not included yet.
- Export is currently 9:16 vertical and center-cropped. Make sure the crop preserves the speaker/action.
- No live stream capture, account connections, publishing, multi-user security, or cloud processing.
- Only process and republish material you have permission to use.
