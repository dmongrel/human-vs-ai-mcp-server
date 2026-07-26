# Builds llama-engine-helper.exe and stages it, plus the pinned llama.cpp CPU
# runtime DLLs, into packages/win32-x64/ for publishing.
# Requires: Go 1.26+, PowerShell 5.1+. Run from the repo root via `npm run build:native`.
# Written 2026-07-25.

$ErrorActionPreference = "Stop"

# The llama.cpp release is pinned deliberately: native/llama-engine/llama.go
# depends on struct field offsets from this exact release's include/llama.h.
# Bumping it means re-verifying those offsets (see llama.go's header comment).
$LlamaRelease = "b10107"
$Asset = "llama-$LlamaRelease-bin-win-cpu-x64.zip"
$Url = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaRelease/$Asset"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Work = Join-Path $PSScriptRoot ".local"
$Dest = Join-Path $Root "packages\win32-x64"

New-Item -ItemType Directory -Force -Path $Work | Out-Null
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$Zip = Join-Path $Work $Asset
if (-not (Test-Path $Zip)) {
    Write-Host "Downloading $Asset ..."
    Invoke-WebRequest -Uri $Url -OutFile $Zip
}

$Extract = Join-Path $Work "llama-$LlamaRelease"
if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
Expand-Archive -Path $Zip -DestinationPath $Extract -Force

Write-Host "Building llama-engine-helper.exe ..."
Push-Location $PSScriptRoot
try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -trimpath -ldflags "-s -w" -o (Join-Path $Dest "llama-engine-helper.exe") .
    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# The runtime DLLs must sit next to the helper: llama.go loads llama.dll from
# the executable's own directory and passes that same directory to
# ggml_backend_load_all_from_path, which is where the per-CPU ggml-cpu-*.dll
# backends are discovered.
#
# The filter is exact on llama.dll: the release also ships llama-cli-impl.dll,
# llama-bench-impl.dll and a dozen other CLI-tool DLLs we have no use for.
$Dlls = Get-ChildItem -Path $Extract -Recurse -Filter "*.dll" |
    Where-Object { $_.Name -eq "llama.dll" -or $_.Name -like "ggml*.dll" -or $_.Name -like "libomp*.dll" }
if ($Dlls.Count -eq 0) { throw "no llama/ggml DLLs found in $Extract - check the release asset layout" }
foreach ($dll in $Dlls) {
    Copy-Item -Path $dll.FullName -Destination $Dest -Force
}

# llama.cpp is MIT licensed and we redistribute its compiled DLLs, so the
# notice has to travel with them. The release zips don't contain one, so it
# comes from the pinned tag in the source repo.
$License = Get-ChildItem -Path $Extract -Recurse -Filter "LICENSE*" | Select-Object -First 1
$LicenseDest = Join-Path $Dest "LICENSE.llama.cpp"
if ($License) {
    Copy-Item -Path $License.FullName -Destination $LicenseDest -Force
} else {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/ggml-org/llama.cpp/$LlamaRelease/LICENSE" -OutFile $LicenseDest
}
if (-not (Test-Path $LicenseDest)) { throw "failed to stage llama.cpp's LICENSE - required for redistribution" }

# This package publishes as its own npm tarball, so it needs the project's own
# licence alongside llama.cpp's. npm's `files` globs cannot reach outside the
# package directory, which is why it is copied here rather than referenced.
$ProjectLicense = Join-Path $PSScriptRoot "..\..\LICENSE"
if (-not (Test-Path $ProjectLicense)) { throw "project LICENSE not found at $ProjectLicense" }
Copy-Item -Path $ProjectLicense -Destination (Join-Path $Dest "LICENSE") -Force

Write-Host "Staged $($Dlls.Count) DLL(s), 2 licence file(s) and llama-engine-helper.exe into $Dest"
