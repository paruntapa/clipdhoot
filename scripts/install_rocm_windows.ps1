$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repoRoot '.venv\Scripts\python.exe'
$rocmSdk = Join-Path $repoRoot '.venv\Scripts\rocm-sdk.exe'
if (!(Test-Path -LiteralPath $python)) {
  throw 'Create the project .venv and install requirements.txt before enabling GPU support.'
}
$pythonVersion = & $python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
if ($pythonVersion -ne '3.11') {
  throw "The bundled Windows ROCm wheel is configured for Python 3.11; found $pythonVersion."
}

$scratch = Join-Path $env:TEMP ("clipdhoot-rocm-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$cpuWheel = $null
try {
  & $python -m pip download --only-binary=:all: ctranslate2==4.9.1 -d $scratch
  if ($LASTEXITCODE -ne 0) { throw 'Could not back up the CPU CTranslate2 wheel.' }
  $cpuWheel = Get-ChildItem $scratch -Filter 'ctranslate2-4.9.1-cp311-cp311-win_amd64.whl' -File | Select-Object -First 1
  if (!$cpuWheel) { throw 'The CPU fallback wheel was not downloaded.' }

  $rocmBase = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2'
  & $python -m pip install --no-cache-dir `
    "$rocmBase/rocm_sdk_core-7.2.0.dev0-py3-none-win_amd64.whl" `
    "$rocmBase/rocm_sdk_devel-7.2.0.dev0-py3-none-win_amd64.whl" `
    "$rocmBase/rocm_sdk_libraries_custom-7.2.0.dev0-py3-none-win_amd64.whl" `
    "$rocmBase/rocm-7.2.0.dev0.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the AMD ROCm runtime packages.' }

  & $rocmSdk init
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the ROCm SDK.' }

  $archive = Join-Path $scratch 'ctranslate2-rocm-windows.zip'
  $archiveUrl = 'https://github.com/OpenNMT/CTranslate2/releases/download/v4.9.0/rocm-python-wheels-Windows.zip'
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $scratch
  $wheel = Get-ChildItem (Join-Path $scratch 'temp-windows') -Filter 'ctranslate2-4.9.0-cp311-cp311-win_amd64.whl' -File | Select-Object -First 1
  if (!$wheel) { throw 'Could not find the official CTranslate2 ROCm wheel for Python 3.11.' }
  & $python -m pip install --no-deps --force-reinstall $wheel.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the AMD-enabled CTranslate2 wheel.' }

  $verify = @'
import sys
sys.path.insert(0, "scripts")
import whisper_runtime
import ctranslate2
count = ctranslate2.get_cuda_device_count()
print(f"CTranslate2 {ctranslate2.__version__}; GPU devices: {count}")
if count < 1:
    raise SystemExit("The ROCm runtime installed, but CTranslate2 cannot see a GPU.")
'@
  $verify | & $python -
  if ($LASTEXITCODE -ne 0) { throw 'GPU verification failed; CTranslate2 cannot see an available GPU.' }
  Write-Host 'GPU transcription is ready. Restart Clip Dhoot before processing a video.'
}
catch {
  if ($cpuWheel) {
    Write-Warning 'Restoring CPU CTranslate2 so Whisper retains its CPU fallback.'
    & $python -m pip install --no-deps --force-reinstall $cpuWheel.FullName
  }
  throw
}
finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
