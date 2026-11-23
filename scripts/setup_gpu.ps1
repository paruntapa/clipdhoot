<#
.SYNOPSIS
  Universal GPU Acceleration Setup for Clipdhoot (NVIDIA & AMD on Windows)
#>
param(
  [switch]$ForceNvidia,
  [switch]$ForceAmd,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot '.venv\Scripts\python.exe'

if (!(Test-Path -LiteralPath $python)) {
  Write-Error "Python virtual environment not found at $python. Please create .venv first."
  exit 1
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Clipdhoot Universal GPU Hardware Setup & Diagnostics   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Detect Installed Display GPU Hardware
$detectedGpu = & $python -c "import sys; sys.path.insert(0, 'scripts'); import whisper_runtime; print(whisper_runtime.get_gpu_name() or '')"
$detectedGpu = ($detectedGpu -join '').Trim()

Write-Host "`nDetected Display Hardware:" -ForegroundColor Yellow
if ($detectedGpu) {
  Write-Host "  * $detectedGpu" -ForegroundColor White
} else {
  Write-Host "  * Standard Display Adapter / CPU" -ForegroundColor DarkGray
}

$hasNvidia = ($detectedGpu -match "NVIDIA|GeForce|Quadro|RTX|GTX") -or $ForceNvidia
$hasAmd = ($detectedGpu -match "Radeon|AMD|RX") -or $ForceAmd

if ($CheckOnly) {
  Write-Host "`nProbing CTranslate2 & Whisper GPU device..." -ForegroundColor Yellow
  & $python -c "import sys; sys.path.insert(0, 'scripts'); import whisper_runtime, ctranslate2; print(f'CUDA Device Count: {ctranslate2.get_cuda_device_count()}'); m, dev = whisper_runtime.create_model('small'); print('Active Whisper Device:', dev)"
  exit 0
}

# Configure for NVIDIA
if ($hasNvidia -and !$ForceAmd) {
  Write-Host "`n>>> Setting up NVIDIA CUDA & cuDNN Acceleration for: $detectedGpu..." -ForegroundColor Green
  Write-Host "Step 1/3: Installing official NVIDIA CUDA 12 and cuDNN pip wheels..." -ForegroundColor Cyan
  & $python -m pip install --upgrade nvidia-cublas-cu12 nvidia-cudnn-cu12
  
  Write-Host "Step 2/3: Ensuring standard PyPI CTranslate2 (CUDA build) is installed..." -ForegroundColor Cyan
  & $python -m pip install --upgrade --no-deps --force-reinstall ctranslate2
  
  Write-Host "Step 3/3: Verifying NVIDIA GPU access..." -ForegroundColor Cyan
  $verifyScript = "import sys; sys.path.insert(0, 'scripts'); import whisper_runtime, ctranslate2; count = ctranslate2.get_cuda_device_count(); assert count > 0, 'No CUDA device found'; m, dev = whisper_runtime.create_model('small'); print(f'VERIFIED: {dev}')"
  try {
    & $python -c $verifyScript
    Write-Host "`nSUCCESS! NVIDIA GPU Acceleration is fully active." -ForegroundColor Green
    Write-Host "Clipdhoot will now use your NVIDIA GPU for ultra-fast transcription." -ForegroundColor Green
  } catch {
    Write-Warning "Could not initialize NVIDIA CUDA. Please ensure your NVIDIA Game Ready or Studio Driver is up to date."
  }
  exit 0
}

# Configure for AMD
if ($hasAmd) {
  Write-Host "`n>>> Setting up AMD ROCm GPU Acceleration for: $detectedGpu..." -ForegroundColor Green
  $rocmScript = Join-Path $PSScriptRoot 'install_rocm_windows.ps1'
  if (Test-Path $rocmScript) {
    & $rocmScript
  } else {
    Write-Error "AMD ROCm script ($rocmScript) not found."
  }
  exit 0
}

Write-Host "`nNo discrete NVIDIA or AMD GPU found. Whisper is configured for CPU with int8 quantization." -ForegroundColor Yellow
