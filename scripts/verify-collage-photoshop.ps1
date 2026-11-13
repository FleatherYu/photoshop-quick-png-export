# Photoshop Quick PNG Export - real acceptance run for the 1.3.0 collage mode.
#
# Runs tests/photoshop/collage-acceptance.jsx inside Photoshop and asserts every
# reported step: grid order, canvas sizes, file numbering, skipped layers,
# JPG/PNG pixel values, bit-depth/CMYK conversion, quality, state safety and
# temporary-file cleanup. All test documents are created and closed by the
# harness; user documents make the run SKIP (exit code 2) without being touched.
#
# Exit code 0 = every check passed. Exit 1 = a check failed. Exit code 2 = SKIP
# because user documents were open.
#
# Static syntax check (without Photoshop):
#   powershell -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw 'scripts\verify-collage-photoshop.ps1')) | Out-Null"

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$hostFile = Join-Path $root 'jsx\host.jsx'
$harnessFile = Join-Path $root 'tests\photoshop\collage-acceptance.jsx'
$tmpDir = Join-Path $root '.tmp'
$resultFile = Join-Path $tmpDir 'collage-acceptance-result.json'
$outDir = Join-Path $tmpDir 'ps-collage-verify\export'

foreach ($requiredFile in @($hostFile, $harnessFile)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        Write-Host ('FAIL: missing file: ' + $requiredFile)
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $tmpDir)) {
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$hostSource = [System.IO.File]::ReadAllText($hostFile)
if ($hostSource -notmatch 'previewCollage') {
    Write-Host 'FAIL: jsx\host.jsx does not contain previewCollage - run node scripts\build-host.mjs first.'
    exit 1
}
$harnessSource = [System.IO.File]::ReadAllText($harnessFile)
$baseDir = ($root.Replace('\', '/')) + '/.tmp/ps-collage-verify/'
$harnessSource = $harnessSource.Replace('__QPE_BASE_DIR__', $baseDir)
$scriptText = $hostSource + "`n" + $harnessSource

$ps = New-Object -ComObject Photoshop.Application
$raw = $null
try {
    $raw = $ps.DoJavaScript($scriptText)
} catch {
    Write-Host ('FAIL: Photoshop DoJavaScript failed: ' + $_.Exception.Message)
    exit 1
}
if ([string]::IsNullOrWhiteSpace([string]$raw)) {
    Write-Host 'FAIL: Photoshop returned an empty report.'
    exit 1
}

[System.IO.File]::WriteAllText($resultFile, [string]$raw, (New-Object System.Text.UTF8Encoding($false)))
$result = [string]$raw | ConvertFrom-Json

if ($result.skipped -eq $true) {
    Write-Host 'SKIP: Photoshop has user documents open; the run was not started.'
    if ($result.reason) { Write-Host ('Reason: ' + $result.reason) }
    Write-Host ('Report: ' + $resultFile)
    exit 2
}

$failures = New-Object System.Collections.ArrayList

function Check([string]$name, [bool]$condition, [string]$detail) {
    if ($condition) {
        Write-Host ('PASS: ' + $name)
    } else {
        Write-Host ('FAIL: ' + $name)
        if ($detail) { Write-Host ('      ' + $detail) }
        [void]$failures.Add($name)
    }
}

$byName = @{}
if ($result.steps) {
    foreach ($step in $result.steps) { $byName[[string]$step.name] = $step.result }
}

function Get-Step([string]$name) {
    if ($byName.ContainsKey($name)) { return $byName[$name] }
    return $null
}

function Step-Detail([string]$name) {
    $step = Get-Step $name
    if ($null -eq $step) { return ('step missing: ' + $name) }
    return ($step | ConvertTo-Json -Compress -Depth 6)
}

Add-Type -AssemblyName System.Drawing

function Read-Pixel([string]$path, [int]$x, [int]$y) {
    try {
        $bitmap = [System.Drawing.Bitmap]::FromFile($path)
        try {
            return $bitmap.GetPixel($x, $y)
        } finally {
            $bitmap.Dispose()
        }
    } catch {
        return $null
    }
}

function Check-Pixel([string]$name, [string]$path, [int]$x, [int]$y, [int]$r, [int]$g, [int]$b, [int]$tolerance, [int]$alpha) {
    $pixel = Read-Pixel $path $x $y
    if ($null -eq $pixel) {
        Check $name $false ('cannot read pixel (' + $x + ',' + $y + ') from ' + $path)
        return
    }
    $ok = ([Math]::Abs($pixel.R - $r) -le $tolerance) -and ([Math]::Abs($pixel.G - $g) -le $tolerance) -and ([Math]::Abs($pixel.B - $b) -le $tolerance)
    $alphaText = 'any'
    if ($alpha -ge 0) {
        $ok = $ok -and ($pixel.A -eq $alpha)
        $alphaText = [string]$alpha
    }
    Check $name $ok ('at (' + $x + ',' + $y + ') got R=' + $pixel.R + ' G=' + $pixel.G + ' B=' + $pixel.B + ' A=' + $pixel.A + '; expected R=' + $r + ' G=' + $g + ' B=' + $b + ' A=' + $alphaText + ' +/-' + $tolerance)
}

function Check-Transparent([string]$name, [string]$path, [int]$x, [int]$y, [int]$maxAlpha) {
    $pixel = Read-Pixel $path $x $y
    if ($null -eq $pixel) {
        Check $name $false ('cannot read pixel (' + $x + ',' + $y + ') from ' + $path)
        return
    }
    Check $name ($pixel.A -le $maxAlpha) ('at (' + $x + ',' + $y + ') got A=' + $pixel.A + ' R=' + $pixel.R + ' G=' + $pixel.G + ' B=' + $pixel.B + '; expected A <= ' + $maxAlpha)
}

function Check-White([string]$name, [string]$path, [int]$x, [int]$y) {
    $pixel = Read-Pixel $path $x $y
    if ($null -eq $pixel) {
        Check $name $false ('cannot read pixel (' + $x + ',' + $y + ') from ' + $path)
        return
    }
    $ok = ($pixel.R -ge 240) -and ($pixel.G -ge 240) -and ($pixel.B -ge 240)
    Check $name $ok ('at (' + $x + ',' + $y + ') got R=' + $pixel.R + ' G=' + $pixel.G + ' B=' + $pixel.B + '; expected white (>=240 each)')
}

function Get-PngInfo([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 26) { return $null }
    $signature = ($bytes[0..7] | ForEach-Object { $_.ToString('X2') }) -join ''
    $width = [int]$bytes[16] * 16777216 + [int]$bytes[17] * 65536 + [int]$bytes[18] * 256 + [int]$bytes[19]
    $height = [int]$bytes[20] * 16777216 + [int]$bytes[21] * 65536 + [int]$bytes[22] * 256 + [int]$bytes[23]
    $colorType = [int]$bytes[25]
    return [pscustomobject]@{ Signature = $signature; Width = $width; Height = $height; ColorType = $colorType }
}

function Check-Png([string]$name, [string]$path, [int]$width, [int]$height) {
    if (-not (Test-Path -LiteralPath $path)) {
        Check $name $false ('missing: ' + $path)
        return
    }
    $info = Get-PngInfo $path
    if ($null -eq $info) {
        Check $name $false ('too small to be a PNG: ' + $path)
        return
    }
    $ok = ($info.Signature -eq '89504E470D0A1A0A') -and ($info.Width -eq $width) -and ($info.Height -eq $height) -and ($info.ColorType -eq 6)
    Check $name $ok ('sig=' + $info.Signature + ' size=' + $info.Width + 'x' + $info.Height + ' colorType=' + $info.ColorType + '; expected signature, ' + $width + 'x' + $height + ', colorType 6')
}

function Check-Jpeg([string]$name, [string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        Check $name $false ('missing: ' + $path)
        return
    }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $soi = ''
    if ($bytes.Length -ge 3) { $soi = ($bytes[0..2] | ForEach-Object { $_.ToString('X2') }) -join '' }
    Check $name ($soi -eq 'FFD8FF') ('SOI=' + $soi + ' size=' + $bytes.Length + '; expected FFD8FF')
}

function Check-FileSize([string]$name, [string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        Check $name $false ('missing: ' + $path)
        return
    }
    $length = (Get-Item -LiteralPath $path).Length
    Check $name ($length -gt 0) ('size=' + $length)
}

function Check-NoFile([string]$name, [string]$path) {
    Check $name (-not (Test-Path -LiteralPath $path)) ('unexpected file: ' + $path)
}

# =========================================================================
# Report envelope.
# =========================================================================
Check 'harness completed without a fatal error' ($result.ok -eq $true) ('fatal: ' + $result.fatal)
Check 'harness did not skip' ($result.skipped -eq $false) ('reason: ' + $result.reason)

# =========================================================================
# A - main document: preview, selection key, numbering.
# =========================================================================
$aPreview = Get-Step 'A-preview'
Check 'A-preview succeeded' ($null -ne $aPreview -and $aPreview.ok -eq $true) (Step-Detail 'A-preview')
Check 'A-preview counts 6 selected objects' ($aPreview.count -eq 6 -and $aPreview.selectedCount -eq 6) (Step-Detail 'A-preview')
Check 'A-preview reports 0 skipped objects' ($aPreview.skippedCount -eq 0) (Step-Detail 'A-preview')
Check 'A-preview canvas is 400x400' ($aPreview.documentWidth -eq 400 -and $aPreview.documentHeight -eq 400) (Step-Detail 'A-preview')
Check 'A-preview proposes QPE-Collage-pv-01.png' ($aPreview.fileName -eq 'QPE-Collage-pv-01.png') (Step-Detail 'A-preview')
Check 'A-preview items follow Layers-panel order' (($aPreview.itemNames -join ',') -eq 'c-cyan,c-magenta,c-yellow,c-blue,c-green,c-red') (Step-Detail 'A-preview')
Check 'A-preview exposes a selection key' (-not [string]::IsNullOrEmpty([string]$aPreview.selectionKey)) (Step-Detail 'A-preview')

$aSelection = Get-Step 'A-selection-changed'
Check 'A-selection-changed stale export is rejected' ($null -ne $aSelection -and $aSelection.ok -eq $false -and $aSelection.code -eq 'SELECTION_CHANGED') (Step-Detail 'A-selection-changed')
Check-NoFile 'stale selection exported no file' (Join-Path $outDir 'QPE-Collage-stale-01.png')

$aRestored = Get-Step 'A-preview-restored'
Check 'A-preview-restored sees 6 objects again' ($null -ne $aRestored -and $aRestored.ok -eq $true -and $aRestored.count -eq 6) (Step-Detail 'A-preview-restored')
Check 'A-preview-restored selection key matches the first preview' ($aRestored.sameKey -eq $true) (Step-Detail 'A-preview-restored')

$aShared = Get-Step 'A-preview-shared'
Check 'shared numbering continues after existing PNG' ($null -ne $aShared -and $aShared.fileName -eq 'QPE-Collage-shared-04.png' -and $aShared.startNumber -eq 4 -and $aShared.maxNumber -eq 3 -and $aShared.existingCount -eq 1) (Step-Detail 'A-preview-shared')
Check 'shared numbering ignores a .tif seed' ($aShared.existingCount -eq 1) (Step-Detail 'A-preview-shared')

$aSeparate = Get-Step 'A-preview-separate'
Check 'separate numbering ignores JPG seeds for a PNG export' ($null -ne $aSeparate -and $aSeparate.fileName -eq 'QPE-Collage-sep-01.png' -and $aSeparate.startNumber -eq 1 -and $aSeparate.existingCount -eq 0) (Step-Detail 'A-preview-separate')

$aMix = Get-Step 'A-preview-mix'
Check 'shared numbering counts mixed-case .JPG/.jpeg seeds' ($null -ne $aMix -and $aMix.fileName -eq 'QPE-Collage-mix-08.png' -and $aMix.startNumber -eq 8 -and $aMix.maxNumber -eq 7 -and $aMix.existingCount -eq 2) (Step-Detail 'A-preview-mix')

$aNoFolder = Get-Step 'A-preview-nofolder'
Check 'preview without a folder proposes number 01 and folderAvailable false' ($null -ne $aNoFolder -and $aNoFolder.folderAvailable -eq $false -and $aNoFolder.fileName -eq 'QPE-Collage-pv-01.png') (Step-Detail 'A-preview-nofolder')

# =========================================================================
# A - exports: 3 columns, 4 columns, numbering, JPG, target size, no overwrite.
# =========================================================================
$aSharedExport = Get-Step 'A-export-shared'
Check 'A-export-shared succeeded' ($null -ne $aSharedExport -and $aSharedExport.ok -eq $true -and $aSharedExport.code -eq 'OK') (Step-Detail 'A-export-shared')
Check 'A-export-shared wrote QPE-Collage-shared-04.png' ($aSharedExport.fileName -eq 'QPE-Collage-shared-04.png' -and $aSharedExport.number -eq 4) (Step-Detail 'A-export-shared')
Check 'A-export-shared canvas is 1200x800 (3 columns, 2 rows)' ($aSharedExport.width -eq 1200 -and $aSharedExport.height -eq 800 -and $aSharedExport.columns -eq 3 -and $aSharedExport.rows -eq 2 -and $aSharedExport.originalWidth -eq 1200 -and $aSharedExport.originalHeight -eq 800) (Step-Detail 'A-export-shared')
Check 'A-export-shared placed 6 objects in panel order' ($aSharedExport.placedCount -eq 6 -and ($aSharedExport.placedNames -join ',') -eq 'c-cyan,c-magenta,c-yellow,c-blue,c-green,c-red') (Step-Detail 'A-export-shared')
Check 'A-export-shared fills cells row-major' ((($aSharedExport.placedCellColumns -join ',') -eq '1,2,3,1,2,3') -and (($aSharedExport.placedCellRows -join ',') -eq '1,1,1,2,2,2')) (Step-Detail 'A-export-shared')
Check 'A-export-shared wrote exactly one file' ($aSharedExport.newFileCount -eq 1) (Step-Detail 'A-export-shared')
$sharedPng = Join-Path $outDir 'QPE-Collage-shared-04.png'
Check-Png 'A-export-shared is a 1200x800 RGBA PNG' $sharedPng 1200 800
Check-FileSize 'A-export-shared file is not empty' $sharedPng
Check-Pixel 'collage cell 1 is cyan at the canvas position' $sharedPng 250 150 0 200 200 2 255
Check-Pixel 'collage cell 2 is magenta' $sharedPng 550 150 255 0 255 2 255
Check-Pixel 'collage cell 3 is yellow' $sharedPng 850 150 220 220 0 2 255
Check-Pixel 'collage cell 4 is blue (row 2, first cell)' $sharedPng 250 450 0 0 200 2 255
Check-Pixel 'collage cell 5 is green' $sharedPng 550 450 0 200 0 2 255
Check-Pixel 'collage cell 6 is red' $sharedPng 850 450 200 0 0 2 255
Check-Transparent 'collage keeps the transparent background of the source canvas' $sharedPng 150 150 0
Check-Transparent 'collage keeps transparency at the canvas corner' $sharedPng 50 50 0

$aSharedNext = Get-Step 'A-export-shared-next'
Check 'A-export-shared-next continues the numbering at 05' ($null -ne $aSharedNext -and $aSharedNext.ok -eq $true -and $aSharedNext.fileName -eq 'QPE-Collage-shared-05.png' -and $aSharedNext.number -eq 5) (Step-Detail 'A-export-shared-next')
Check 'A-export-shared-next canvas is 1600x800 (4 columns)' ($aSharedNext.width -eq 1600 -and $aSharedNext.height -eq 800 -and $aSharedNext.columns -eq 4 -and $aSharedNext.rows -eq 2) (Step-Detail 'A-export-shared-next')
Check 'A-export-shared-next wrote exactly one file' ($aSharedNext.newFileCount -eq 1) (Step-Detail 'A-export-shared-next')
Check-Png 'A-export-shared-next is a 1600x800 RGBA PNG' (Join-Path $outDir 'QPE-Collage-shared-05.png') 1600 800

$aMixExport = Get-Step 'A-export-mix'
Check 'A-export-mix starts at 08 over mixed-case seeds' ($null -ne $aMixExport -and $aMixExport.ok -eq $true -and $aMixExport.fileName -eq 'QPE-Collage-mix-08.png' -and $aMixExport.number -eq 8) (Step-Detail 'A-export-mix')
Check 'A-export-mix canvas is 1600x800 with 4 columns and 6 placed' ($aMixExport.width -eq 1600 -and $aMixExport.height -eq 800 -and $aMixExport.columns -eq 4 -and $aMixExport.rows -eq 2 -and $aMixExport.placedCount -eq 6) (Step-Detail 'A-export-mix')
Check 'A-export-mix wrote exactly one file' ($aMixExport.newFileCount -eq 1) (Step-Detail 'A-export-mix')
$mixPng = Join-Path $outDir 'QPE-Collage-mix-08.png'
Check-Png 'A-export-mix is a 1600x800 RGBA PNG' $mixPng 1600 800
Check-Pixel '4-column grid cell 1 is cyan' $mixPng 250 150 0 200 200 2 255
Check-Pixel '4-column grid cell 2 is magenta' $mixPng 550 150 255 0 255 2 255
Check-Pixel '4-column grid cell 3 is yellow' $mixPng 850 150 220 220 0 2 255
Check-Pixel '4-column grid cell 4 is blue' $mixPng 1450 50 0 0 200 2 255
Check-Pixel '4-column grid cell 5 is green (row 2, first cell)' $mixPng 150 450 0 200 0 2 255
Check-Pixel '4-column grid cell 6 is red' $mixPng 450 450 200 0 0 2 255
Check-Transparent '4-column grid leaves the last row cells transparent (cell 7)' $mixPng 1000 600 0
Check-Transparent '4-column grid leaves the last row cells transparent (cell 8)' $mixPng 1400 600 0

$aSepExport = Get-Step 'A-export-sep'
Check 'A-export-sep writes sep-01.png with separate numbering' ($null -ne $aSepExport -and $aSepExport.ok -eq $true -and $aSepExport.fileName -eq 'QPE-Collage-sep-01.png' -and $aSepExport.number -eq 1) (Step-Detail 'A-export-sep')
Check 'A-export-sep canvas is 1200x800' ($aSepExport.width -eq 1200 -and $aSepExport.height -eq 800 -and $aSepExport.columns -eq 3) (Step-Detail 'A-export-sep')
Check 'A-export-sep wrote exactly one file' ($aSepExport.newFileCount -eq 1) (Step-Detail 'A-export-sep')
Check-Png 'A-export-sep is a 1200x800 RGBA PNG' (Join-Path $outDir 'QPE-Collage-sep-01.png') 1200 800

$aJpgExport = Get-Step 'A-export-jpg'
Check 'A-export-jpg succeeded' ($null -ne $aJpgExport -and $aJpgExport.ok -eq $true -and $aJpgExport.code -eq 'OK') (Step-Detail 'A-export-jpg')
Check 'A-export-jpg writes QPE-Collage-jpg-01.jpg' ($aJpgExport.fileName -eq 'QPE-Collage-jpg-01.jpg' -and $aJpgExport.number -eq 1) (Step-Detail 'A-export-jpg')
Check 'A-export-jpg canvas is 1600x800' ($aJpgExport.width -eq 1600 -and $aJpgExport.height -eq 800 -and $aJpgExport.columns -eq 4 -and $aJpgExport.placedCount -eq 6) (Step-Detail 'A-export-jpg')
Check 'A-export-jpg wrote exactly one file' ($aJpgExport.newFileCount -eq 1) (Step-Detail 'A-export-jpg')
$jpgFile = Join-Path $outDir 'QPE-Collage-jpg-01.jpg'
Check-Jpeg 'A-export-jpg file is a JPEG' $jpgFile
Check-FileSize 'A-export-jpg file is not empty' $jpgFile
Check-White 'JPG export fills the empty grid cells with white (cell 7)' $jpgFile 1000 600
Check-White 'JPG export fills the empty grid cells with white (cell 8)' $jpgFile 1400 600
Check-White 'JPG export fills transparent canvas areas with white' $jpgFile 500 500
Check-Pixel 'JPG cell 1 keeps the cyan patch' $jpgFile 250 150 0 200 200 90 -1
Check-Pixel 'JPG cell 4 keeps the blue patch' $jpgFile 1450 50 0 0 200 90 -1
Check-Pixel 'JPG cell 5 keeps the green patch' $jpgFile 150 450 0 200 0 90 -1
Check-Pixel 'JPG cell 6 keeps the red patch' $jpgFile 450 450 200 0 0 90 -1

$aOver = Get-Step 'A-export-over'
Check 'A-export-over does not overwrite the existing -01 file' ($null -ne $aOver -and $aOver.ok -eq $true -and $aOver.fileName -eq 'QPE-Collage-over-02.png' -and $aOver.number -eq 2) (Step-Detail 'A-export-over')
Check 'A-export-over wrote exactly one file' ($aOver.newFileCount -eq 1) (Step-Detail 'A-export-over')
Check 'seed file QPE-Collage-over-01.png is unchanged' ((Get-Content -LiteralPath (Join-Path $outDir 'QPE-Collage-over-01.png') -Raw) -eq 'seed-over') 'expected seed-over'
Check-Png 'A-export-over is a 1200x800 RGBA PNG' (Join-Path $outDir 'QPE-Collage-over-02.png') 1200 800

$aTargetWidth = Get-Step 'A-target-width'
Check 'A-target-width resizes the collage to 300x200' ($null -ne $aTargetWidth -and $aTargetWidth.ok -eq $true -and $aTargetWidth.width -eq 300 -and $aTargetWidth.height -eq 200) (Step-Detail 'A-target-width')
Check 'A-target-width reports the original 1200x800 size' ($aTargetWidth.originalWidth -eq 1200 -and $aTargetWidth.originalHeight -eq 800) (Step-Detail 'A-target-width')
Check 'A-target-width wrote exactly one file' ($aTargetWidth.newFileCount -eq 1) (Step-Detail 'A-target-width')
$smallPng = Join-Path $outDir 'QPE-Collage-small-01.png'
Check-Png 'A-target-width is a 300x200 RGBA PNG' $smallPng 300 200
Check-Pixel 'resized collage keeps the cyan patch color' $smallPng 62 38 0 200 200 70 -1
Check-Transparent 'resized collage keeps transparent background' $smallPng 25 25 8

$aUpscale = Get-Step 'A-target-upscale'
Check 'A-target-upscale is rejected with TARGET_UPSCALE' ($null -ne $aUpscale -and $aUpscale.ok -eq $false -and $aUpscale.code -eq 'TARGET_UPSCALE') (Step-Detail 'A-target-upscale')
Check 'A-target-upscale wrote no file' ($aUpscale.newFileCount -eq 0) (Step-Detail 'A-target-upscale')
Check-NoFile 'upscale produced no QPE-Collage-big-01.png' (Join-Path $outDir 'QPE-Collage-big-01.png')

$aNoFolderExport = Get-Step 'A-export-nofolder'
Check 'A-export-nofolder is rejected with NO_FOLDER' ($null -ne $aNoFolderExport -and $aNoFolderExport.ok -eq $false -and $aNoFolderExport.code -eq 'NO_FOLDER') (Step-Detail 'A-export-nofolder')
Check 'A-export-nofolder wrote no file' ($aNoFolderExport.newFileCount -eq 0) (Step-Detail 'A-export-nofolder')

$aMissingFolder = Get-Step 'A-export-missing-folder'
Check 'A-export-missing-folder is rejected with FOLDER_MISSING' ($null -ne $aMissingFolder -and $aMissingFolder.ok -eq $false -and $aMissingFolder.code -eq 'FOLDER_MISSING') (Step-Detail 'A-export-missing-folder')
Check 'A-export-missing-folder wrote no file' ($aMissingFolder.newFileCount -eq 0) (Step-Detail 'A-export-missing-folder')
Check 'missing output folder was not created' (-not (Test-Path -LiteralPath (Join-Path $outDir 'QPE-Collage-no-dir'))) 'unexpected folder created'

$aState = Get-Step 'A-state-unchanged'
Check 'source document is unchanged after all exports' ($null -ne $aState -and $aState.same -eq $true) (Step-Detail 'A-state-unchanged')
Check 'Photoshop is back on the source document after an export' ($aState.activeDocument -eq 'QPE-Collage-main') (Step-Detail 'A-state-unchanged')

# =========================================================================
# B - clipped layers / empty layer: skip reasons and cell placement.
# =========================================================================
$bPreview = Get-Step 'B-skips-preview'
Check 'B-skips-preview counts 3 exportable objects' ($null -ne $bPreview -and $bPreview.ok -eq $true -and $bPreview.count -eq 3 -and $bPreview.selectedCount -eq 5) (Step-Detail 'B-skips-preview')
Check 'B-skips-preview reports the 2 clipped objects' ($bPreview.skippedCount -eq 2 -and ($bPreview.skipCodes -join ',') -eq 'CLIPPED,CLIPPED') (Step-Detail 'B-skips-preview')
Check 'B-skips-preview canvas is 200x200' ($bPreview.documentWidth -eq 200 -and $bPreview.documentHeight -eq 200) (Step-Detail 'B-skips-preview')
Check 'B-skips-preview keeps panel order' (($bPreview.itemNames -join ',') -eq 's-blue,s-empty,s-green') (Step-Detail 'B-skips-preview')

$bExport = Get-Step 'B-skips-export'
Check 'B-skips-export succeeded' ($null -ne $bExport -and $bExport.ok -eq $true) (Step-Detail 'B-skips-export')
Check 'B-skips-export writes QPE-Collage-skip-01.png' ($bExport.fileName -eq 'QPE-Collage-skip-01.png') (Step-Detail 'B-skips-export')
Check 'B-skips-export canvas is 400x400 (2 columns)' ($bExport.width -eq 400 -and $bExport.height -eq 400 -and $bExport.columns -eq 2 -and $bExport.rows -eq 2) (Step-Detail 'B-skips-export')
Check 'B-skips-export placed only the non-empty objects' ($bExport.placedCount -eq 2 -and ($bExport.placedNames -join ',') -eq 's-blue,s-green' -and ($bExport.placedCellColumns -join ',') -eq '1,2' -and ($bExport.placedCellRows -join ',') -eq '1,1') (Step-Detail 'B-skips-export')
Check 'B-skips-export reports the empty layer as EMPTY' ($bExport.skipCount -eq 3 -and ($bExport.skipCodes -contains 'EMPTY')) (Step-Detail 'B-skips-export')
Check 'B-skips-export wrote exactly one file' ($bExport.newFileCount -eq 1) (Step-Detail 'B-skips-export')
$skipPng = Join-Path $outDir 'QPE-Collage-skip-01.png'
Check-Png 'B-skips-export is a 400x400 RGBA PNG' $skipPng 400 400
Check-Pixel 'skipped empty layer does not shift the blue cell' $skipPng 110 30 0 0 200 2 255
Check-Pixel 'green keeps its canvas position in cell 2' $skipPng 330 130 0 200 0 2 255
Check-Transparent 'empty layer leaves no pixels in its skipped cell' $skipPng 130 130 0
Check-Transparent 'unused cells stay transparent' $skipPng 310 30 0
Check-Transparent 'unused second-row cells stay transparent' $skipPng 130 330 0

$bState = Get-Step 'B-skips-state-unchanged'
Check 'skip document is unchanged after the export' ($null -ne $bState -and $bState.same -eq $true) (Step-Detail 'B-skips-state-unchanged')

# =========================================================================
# C - nothing to export.
# =========================================================================
$cPreview = Get-Step 'C-all-skipped-preview'
Check 'C-all-skipped-preview counts 0 exportable objects' ($null -ne $cPreview -and $cPreview.ok -eq $true -and $cPreview.count -eq 0 -and $cPreview.selectedCount -eq 2) (Step-Detail 'C-all-skipped-preview')
Check 'C-all-skipped-preview reports both clipped objects' ($cPreview.skippedCount -eq 2 -and ($cPreview.skipCodes -join ',') -eq 'CLIPPED,CLIPPED') (Step-Detail 'C-all-skipped-preview')

$cExport = Get-Step 'C-all-skipped-export'
Check 'C-all-skipped-export is rejected with NOTHING_TO_EXPORT' ($null -ne $cExport -and $cExport.ok -eq $false -and $cExport.code -eq 'NOTHING_TO_EXPORT') (Step-Detail 'C-all-skipped-export')
Check 'C-all-skipped-export wrote no file' ($cExport.newFileCount -eq 0) (Step-Detail 'C-all-skipped-export')
$noneFiles = @()
if (Test-Path -LiteralPath $outDir) { $noneFiles = @(Get-ChildItem -LiteralPath $outDir -Filter 'QPE-Collage-none-*') }
Check 'C-all-skipped-export left no QPE-Collage-none-* file' ($noneFiles.Count -eq 0) (($noneFiles | ForEach-Object { $_.Name }) -join ', ')

# =========================================================================
# D - 16 bit RGB and CMYK documents: conversion warning, source untouched.
# =========================================================================
$d16Preview = Get-Step 'D-16-preview'
Check 'D-16-preview counts 2 objects' ($null -ne $d16Preview -and $d16Preview.ok -eq $true -and $d16Preview.count -eq 2) (Step-Detail 'D-16-preview')
Check 'D-16-preview warns about the bit-depth conversion' (@($d16Preview.warnings).Count -ge 1) (Step-Detail 'D-16-preview')

$d16Export = Get-Step 'D-16-export'
Check 'D-16-export succeeded' ($null -ne $d16Export -and $d16Export.ok -eq $true) (Step-Detail 'D-16-export')
Check 'D-16-export reports converted true with a warning' ($d16Export.converted -eq $true -and $d16Export.warningCount -ge 1) (Step-Detail 'D-16-export')
Check 'D-16-export canvas is 240x80 (2 columns)' ($d16Export.width -eq 240 -and $d16Export.height -eq 80 -and $d16Export.columns -eq 2 -and $d16Export.placedCount -eq 2) (Step-Detail 'D-16-export')
Check 'D-16-export wrote exactly one file' ($d16Export.newFileCount -eq 1) (Step-Detail 'D-16-export')
$png16 = Join-Path $outDir 'QPE-Collage-16-01.png'
Check-Png 'D-16-export is a 240x80 RGBA PNG' $png16 240 80
Check-Pixel '16-bit source exports the correct blue patch' $png16 70 20 0 0 200 10 255
Check-Pixel '16-bit source exports the correct red patch' $png16 140 20 200 0 0 10 255

$d16State = Get-Step 'D-16-state-unchanged'
Check '16-bit source document keeps bit depth, mode and layers' ($null -ne $d16State -and $d16State.same -eq $true) (Step-Detail 'D-16-state-unchanged')

$dCmykSkipped = Get-Step 'D-cmyk-skipped'
if ($null -ne $dCmykSkipped) {
    Check 'CMYK document was created' $false (Step-Detail 'D-cmyk-skipped')
}
$dCmykPreview = Get-Step 'D-cmyk-preview'
Check 'D-cmyk-preview counts 2 objects' ($null -ne $dCmykPreview -and $dCmykPreview.ok -eq $true -and $dCmykPreview.count -eq 2) (Step-Detail 'D-cmyk-preview')
Check 'D-cmyk-preview warns about the color-mode conversion' (@($dCmykPreview.warnings).Count -ge 1) (Step-Detail 'D-cmyk-preview')

$dCmykExport = Get-Step 'D-cmyk-export'
Check 'D-cmyk-export succeeded' ($null -ne $dCmykExport -and $dCmykExport.ok -eq $true) (Step-Detail 'D-cmyk-export')
Check 'D-cmyk-export reports converted true with a warning' ($dCmykExport.converted -eq $true -and $dCmykExport.warningCount -ge 1) (Step-Detail 'D-cmyk-export')
Check 'D-cmyk-export canvas is 240x80 (2 columns)' ($dCmykExport.width -eq 240 -and $dCmykExport.height -eq 80 -and $dCmykExport.columns -eq 2 -and $dCmykExport.placedCount -eq 2) (Step-Detail 'D-cmyk-export')
Check 'D-cmyk-export wrote exactly one file' ($dCmykExport.newFileCount -eq 1) (Step-Detail 'D-cmyk-export')
$pngCmyk = Join-Path $outDir 'QPE-Collage-CMYK-01.png'
Check-Png 'D-cmyk-export is a 240x80 RGBA PNG' $pngCmyk 240 80
$cmykCyanPixel = Read-Pixel $pngCmyk 70 20
if ($null -eq $cmykCyanPixel) {
    Check 'CMYK export cell 1 is cyan-ish' $false ('cannot read pixel from ' + $pngCmyk)
} else {
    Check 'CMYK export cell 1 is cyan-ish' ($cmykCyanPixel.A -eq 255 -and ($cmykCyanPixel.B - $cmykCyanPixel.R) -ge 60 -and ($cmykCyanPixel.G - $cmykCyanPixel.R) -ge 40) ('got R=' + $cmykCyanPixel.R + ' G=' + $cmykCyanPixel.G + ' B=' + $cmykCyanPixel.B + ' A=' + $cmykCyanPixel.A)
}
$cmykRedPixel = Read-Pixel $pngCmyk 140 20
if ($null -eq $cmykRedPixel) {
    Check 'CMYK export cell 2 is red-ish' $false ('cannot read pixel from ' + $pngCmyk)
} else {
    Check 'CMYK export cell 2 is red-ish' ($cmykRedPixel.A -eq 255 -and ($cmykRedPixel.R - $cmykRedPixel.G) -ge 60 -and ($cmykRedPixel.R - $cmykRedPixel.B) -ge 60) ('got R=' + $cmykRedPixel.R + ' G=' + $cmykRedPixel.G + ' B=' + $cmykRedPixel.B + ' A=' + $cmykRedPixel.A)
}

$dCmykState = Get-Step 'D-cmyk-state-unchanged'
Check 'CMYK source document keeps mode and layers' ($null -ne $dCmykState -and $dCmykState.same -eq $true) (Step-Detail 'D-cmyk-state-unchanged')

# =========================================================================
# E - JPG quality is applied.
# =========================================================================
$q2 = Get-Step 'E-quality-2'
$q12 = Get-Step 'E-quality-12'
Check 'E-quality-2 wrote a JPEG' ($null -ne $q2 -and $q2.ok -eq $true -and $q2.fileName -eq 'QPE-Collage-q-01.jpg' -and $q2.newFileCount -eq 1) (Step-Detail 'E-quality-2')
Check 'E-quality-12 wrote a JPEG' ($null -ne $q12 -and $q12.ok -eq $true -and $q12.fileName -eq 'QPE-Collage-q-02.jpg' -and $q12.newFileCount -eq 1) (Step-Detail 'E-quality-12')
if ($null -ne $q2 -and $null -ne $q12) {
    $sizeOk = ($q2.fileSize -gt 0) -and ($q12.fileSize -gt ($q2.fileSize * 1.5))
    Check 'quality 12 file is clearly larger than quality 2' $sizeOk ('q2=' + $q2.fileSize + ' q12=' + $q12.fileSize)
} else {
    Check 'quality 12 file is clearly larger than quality 2' $false 'missing step'
}
Check-Jpeg 'E-quality-2 file is a JPEG' (Join-Path $outDir 'QPE-Collage-q-01.jpg')
Check-Jpeg 'E-quality-12 file is a JPEG' (Join-Path $outDir 'QPE-Collage-q-02.jpg')

# =========================================================================
# F - displayDialogs is restored.
# =========================================================================
$fExport = Get-Step 'F-export'
Check 'F-export succeeded while displayDialogs was ERROR' ($null -ne $fExport -and $fExport.ok -eq $true -and $fExport.fileName -eq 'QPE-Collage-dlg-01.png') (Step-Detail 'F-export')
$fDialogs = Get-Step 'F-display-dialogs'
Check 'displayDialogs was restored after the error-mode export' ($null -ne $fDialogs -and $fDialogs.restored -eq $true -and $fDialogs.exportOk -eq $true) (Step-Detail 'F-display-dialogs')
$dlgPng = Join-Path $outDir 'QPE-Collage-dlg-01.png'
Check-Png 'F-export is a 40x40 RGBA PNG' $dlgPng 40 40
Check-Pixel 'F-export keeps the red patch' $dlgPng 15 15 200 0 0 2 255

# =========================================================================
# G - cleanup: temporary files, open documents, display dialogs.
# =========================================================================
$gTemp = Get-Step 'G-temp-clean'
Check 'no leftover qpe-collage-* temporary files' ($null -ne $gTemp -and @($gTemp.collageLeftovers).Count -eq 0) (Step-Detail 'G-temp-clean')
Check 'no leftover qpe-estimate-* temporary files' ($gTemp -ne $null -and @($gTemp.estimateLeftovers).Count -eq 0) (Step-Detail 'G-temp-clean')

$runCleanup = Get-Step 'run-cleanup'
Check 'harness closed every test document' ($null -ne $runCleanup -and $runCleanup.openDocuments -eq 0) (Step-Detail 'run-cleanup')
Check 'harness restored displayDialogs at the end' ($null -ne $runCleanup -and $runCleanup.displayDialogs -eq $runCleanup.originalDialogs) (Step-Detail 'run-cleanup')

# =========================================================================
# Output folder contents.
# =========================================================================
$fileNames = @()
if ($result.files) { $fileNames = @($result.files | ForEach-Object { [string]$_.name }) }
Check 'output folder contains exactly 19 files (13 exports + 6 seeds)' ($fileNames.Count -eq 19) ($fileNames -join ', ')

$expectedFiles = @(
    'QPE-Collage-shared-03.png',
    'QPE-Collage-shared-04.png',
    'QPE-Collage-shared-05.png',
    'QPE-Collage-shared-07.tif',
    'QPE-Collage-sep-01.png',
    'QPE-Collage-sep-02.jpg',
    'QPE-Collage-mix-06.JPG',
    'QPE-Collage-mix-07.jpeg',
    'QPE-Collage-mix-08.png',
    'QPE-Collage-jpg-01.jpg',
    'QPE-Collage-over-01.png',
    'QPE-Collage-over-02.png',
    'QPE-Collage-small-01.png',
    'QPE-Collage-skip-01.png',
    'QPE-Collage-16-01.png',
    'QPE-Collage-CMYK-01.png',
    'QPE-Collage-q-01.jpg',
    'QPE-Collage-q-02.jpg',
    'QPE-Collage-dlg-01.png'
)
foreach ($expectedFile in $expectedFiles) {
    $expectedPath = Join-Path $outDir $expectedFile
    Check ('output file present: ' + $expectedFile) (Test-Path -LiteralPath $expectedPath) $expectedPath
}
Check 'seed file QPE-Collage-shared-03.png is unchanged' ((Get-Content -LiteralPath (Join-Path $outDir 'QPE-Collage-shared-03.png') -Raw) -eq 'seed') 'expected seed'

$bigFiles = @()
if (Test-Path -LiteralPath $outDir) { $bigFiles = @(Get-ChildItem -LiteralPath $outDir -Filter 'QPE-Collage-big-*') }
Check 'no QPE-Collage-big-* file was written' ($bigFiles.Count -eq 0) (($bigFiles | ForEach-Object { $_.Name }) -join ', ')
$strayFiles = @()
if (Test-Path -LiteralPath $outDir) { $strayFiles = @(Get-ChildItem -LiteralPath $outDir -Filter '.qpe-write-test.tmp') }
Check 'no writability probe file was left behind' ($strayFiles.Count -eq 0) (($strayFiles | ForEach-Object { $_.Name }) -join ', ')

# =========================================================================
# Summary.
# =========================================================================
Write-Host ''
Write-Host ('Report: ' + $resultFile)
Write-Host ('Output: ' + $outDir)
if ($failures.Count -gt 0) {
    Write-Host ('RESULT: FAIL (' + $failures.Count + ' check(s) failed)')
    exit 1
}
Write-Host 'RESULT: PASS'
exit 0
