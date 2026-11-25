# build_jabcode.ps1 — Automated compilation of JAB Code (ISO/IEC 23634) on Windows
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $RepoRoot "tools\jabcode"
$BinDir = Join-Path $ToolsDir "bin"
$SrcDir = Join-Path $ToolsDir "src"

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
}

$MsysGcc = "C:\msys64\ucrt64\bin\gcc.exe"
if (-not (Test-Path $MsysGcc)) {
    Write-Error "MSYS2 UCRT64 GCC not found at $MsysGcc. Please install MSYS2 UCRT64."
}

$env:PATH = "C:\msys64\ucrt64\bin;" + $env:PATH

# Clone if not present
if (-not (Test-Path $SrcDir)) {
    Write-Host "[INFO] Cloning jabcode reference implementation from GitHub..."
    git clone --depth 1 https://github.com/jabcode/jabcode.git $SrcDir
}

Write-Host "[INFO] Compiling libjabcode.dll..."
Push-Location (Join-Path $SrcDir "src\jabcode")
try {
    if (-not (Test-Path "build")) { New-Item -ItemType Directory -Force -Path "build" | Out-Null }
    & gcc -O2 -std=c11 -c *.c -I. -I./include -IC:/msys64/ucrt64/include
    & gcc -shared -o build/libjabcode.dll *.o -LC:/msys64/ucrt64/lib -ltiff -lpng16 -lz -lm -O2 -std=c11
    Copy-Item -Force build/libjabcode.dll $BinDir
} finally {
    Pop-Location
}

Write-Host "[INFO] Compiling jabcodeWriter.exe..."
Push-Location (Join-Path $SrcDir "src\jabcodeWriter")
try {
    if (-not (Test-Path "bin")) { New-Item -ItemType Directory -Force -Path "bin" | Out-Null }
    & gcc -O2 -std=c11 -c jabwriter.c -I. -I../jabcode -I../jabcode/include -IC:/msys64/ucrt64/include
    & gcc jabwriter.o -L../jabcode/build -ljabcode -LC:/msys64/ucrt64/lib -ltiff -lpng16 -lz -lm -O2 -std=c11 -o bin/jabcodeWriter.exe
    Copy-Item -Force bin/jabcodeWriter.exe $BinDir
} finally {
    Pop-Location
}

Write-Host "[INFO] Compiling jabcodeReader.exe..."
Push-Location (Join-Path $SrcDir "src\jabcodeReader")
try {
    if (-not (Test-Path "bin")) { New-Item -ItemType Directory -Force -Path "bin" | Out-Null }
    & gcc -O2 -std=c11 -c jabreader.c -I. -I../jabcode -I../jabcode/include -IC:/msys64/ucrt64/include
    & gcc jabreader.o -L../jabcode/build -ljabcode -LC:/msys64/ucrt64/lib -ltiff -lpng16 -lz -lm -O2 -std=c11 -o bin/jabcodeReader.exe
    Copy-Item -Force bin/jabcodeReader.exe $BinDir
} finally {
    Pop-Location
}

Write-Host "[SUCCESS] JAB Code binaries built and installed to $BinDir"
