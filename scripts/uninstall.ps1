# Quick PNG Export - uninstaller for Windows.
#
# Removes the copied extension folder. The PlayerDebugMode registry value is
# left untouched because other unsigned development panels may rely on it;
# delete it manually if you want a pristine CEP setup:
#
#   reg delete HKCU\Software\Adobe\CSXS.9 /v PlayerDebugMode /f
#
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1

[CmdletBinding()]
param(
    [string]$TargetRoot = (Join-Path $env:APPDATA 'Adobe\CEP\extensions')
)

$ErrorActionPreference = 'Stop'
$ExtensionId = 'com.fleatheryu.quickpngexport'
$target = Join-Path $TargetRoot $ExtensionId

if (-not (Test-Path $target)) {
    Write-Host "Nothing to remove: $target does not exist."
    exit 0
}

Remove-Item -Path $target -Recurse -Force
Write-Host "Removed $target"
Write-Host 'Restart Photoshop to drop the panel from the Extensions menu.'
