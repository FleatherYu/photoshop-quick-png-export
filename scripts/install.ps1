# Quick PNG Export - installer for Photoshop CC 2019 (CEP 9) on Windows.
#
# Copies the panel into the per-user CEP extensions folder and switches on
# PlayerDebugMode so Photoshop accepts this unsigned development build.
# Re-run it after changing any panel file. Restart Photoshop afterwards.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# Optional: -TargetRoot <dir> to install somewhere else, -NoDebugMode to leave
# the registry alone (only makes sense for a signed build).

[CmdletBinding()]
param(
    [string]$TargetRoot = (Join-Path $env:APPDATA 'Adobe\CEP\extensions'),
    [switch]$NoDebugMode
)

$ErrorActionPreference = 'Stop'
$ExtensionId = 'com.fleatheryu.quickpngexport'

$source = Split-Path -Parent $PSScriptRoot
$target = Join-Path $TargetRoot $ExtensionId
$hostScript = Join-Path $source 'jsx\host.jsx'

# Rebuild jsx\host.jsx whenever Node is available, so the installed panel always
# matches the sources. The repo also ships a prebuilt copy for machines without
# Node, which is then installed as-is.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Host 'Rebuilding jsx\host.jsx ...'
    Push-Location $source
    try {
        & $node.Source 'scripts\build-host.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'build-host.mjs failed, nothing was installed.' }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $hostScript)) {
    throw "jsx\host.jsx is missing and Node.js was not found. Run 'node scripts/build-host.mjs' on a machine with Node first."
}
if (-not (Test-Path (Join-Path $source 'CSXS\manifest.xml'))) {
    throw "CSXS\manifest.xml is missing - run the installer from the project folder."
}

Write-Host "Source : $source"
Write-Host "Target : $target"

if (-not (Test-Path $TargetRoot)) {
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
}
if (Test-Path $target) {
    Remove-Item -Path $target -Recurse -Force
}
New-Item -ItemType Directory -Path $target -Force | Out-Null

# Panel payload only - tests, docs, scripts and git data stay in the project.
$directories = @('CSXS', 'css', 'js')
foreach ($name in $directories) {
    Copy-Item -Path (Join-Path $source $name) -Destination (Join-Path $target $name) -Recurse -Force
}
foreach ($name in @('index.html', '.debug')) {
    Copy-Item -Path (Join-Path $source $name) -Destination (Join-Path $target $name) -Force
}
$jsxTarget = Join-Path $target 'jsx'
New-Item -ItemType Directory -Path $jsxTarget -Force | Out-Null
Copy-Item -Path $hostScript -Destination $jsxTarget -Force

if (-not $NoDebugMode) {
    # Unsigned development panels only load on CEP 9 when PlayerDebugMode=1.
    $regPaths = @('HKCU\Software\Adobe\CSXS.9')
    foreach ($regPath in $regPaths) {
        & reg.exe add $regPath /v PlayerDebugMode /t REG_SZ /d 1 /f | Out-Null
    }
    Write-Host 'PlayerDebugMode enabled for CSXS.9 (unsigned development panel).'
}

Write-Host ''
Write-Host 'Installed. Now restart Photoshop, then open:'
Write-Host '  Window > Extensions > Quick PNG Export'
Write-Host ''
Write-Host 'If the panel does not appear:'
Write-Host '  - confirm the folder above contains CSXS\manifest.xml'
Write-Host '  - restart Photoshop completely (menu entries are read at startup)'
Write-Host '  - Photoshop 2020+ may need PlayerDebugMode under CSXS.10 / CSXS.11'
