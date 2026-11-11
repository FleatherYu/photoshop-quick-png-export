# Photoshop Quick PNG Export - real acceptance run for JPG export, size estimate
# and document-folder following (1.2.0).
#
# Drives Photoshop over COM: loads jsx/host.jsx, then runs
# tests/photoshop/jpg-acceptance.jsx in the same ExtendScript engine. The
# harness creates throw-away documents, exports PNG/JPG files into
# .tmp\ps-jpg-verify\ and prints a JSON report; this script checks the report
# and the produced files, then exits non-zero on the first semantic mismatch.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-jpg-photoshop.ps1
#
# The harness refuses to run while any user document is open (it prints a SKIP
# report instead) so it can never touch real work. The script is pure ASCII on
# purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI.
#
# Exit code 0 = every check passed, 1 = check failed, 2 = skipped.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$hostFile = Join-Path $root 'jsx\host.jsx'
$harnessFile = Join-Path $root 'tests\photoshop\jpg-acceptance.jsx'
$tmpDir = Join-Path $root '.tmp'
$resultFile = Join-Path $tmpDir 'jpg-acceptance-result.json'
$outDir = Join-Path $tmpDir 'ps-jpg-verify\export'
$savedDir = Join-Path $tmpDir 'ps-jpg-verify\saved'

if (-not (Test-Path $hostFile)) {
    throw "jsx\host.jsx is missing. Run 'node scripts/build-host.mjs' first."
}
if (-not (Test-Path $harnessFile)) {
    throw "tests\photoshop\jpg-acceptance.jsx is missing."
}
if (-not (Test-Path $tmpDir)) {
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
}

$hostSource = [System.IO.File]::ReadAllText($hostFile)
$harnessSource = [System.IO.File]::ReadAllText($harnessFile)
$baseDir = ($root.Replace('\', '/')) + '/.tmp/ps-jpg-verify/'
$harnessSource = $harnessSource.Replace('__QPE_BASE_DIR__', $baseDir)
$script = $hostSource + "`n" + $harnessSource

Write-Host 'Connecting to Photoshop ...'
$ps = New-Object -ComObject Photoshop.Application
$raw = $ps.DoJavaScript($script)
[System.IO.File]::WriteAllText($resultFile, $raw, (New-Object System.Text.UTF8Encoding($false)))
$result = $raw | ConvertFrom-Json

if ($result.skipped -eq $true) {
    Write-Host ('SKIP: ' + $result.reason)
    Write-Host 'Close the open document(s) and rerun this script so your work is never touched.'
    exit 2
}

$failures = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$condition, [string]$detail) {
    if ($condition) {
        Write-Host "PASS  $name"
    } else {
        Write-Host "FAIL  $name  $detail"
        [void]$failures.Add($name)
    }
}

$byName = @{}
foreach ($step in $result.steps) {
    $byName[[string]$step.name] = $step
}

Check 'report ok' ($result.ok -eq $true) ('fatal: ' + $result.fatal)

$status = $byName['A-status'].result
Check 'status reports an unsaved document without a path' ($status.hasDocument -eq $true -and $status.saved -eq $false -and [string]$status.path -eq '') ($status | ConvertTo-Json -Compress)

$previewShared = $byName['A-preview-shared'].result
Check 'shared numbering counts the JPG/JPEG files (next is 04)' ($previewShared.fileName -eq 'QPE-JPG-shared-04.jpg' -and $previewShared.nextNumber -eq 4) ($previewShared | ConvertTo-Json -Compress)

$previewSeparate = $byName['A-preview-separate'].result
Check 'separate numbering ignores PNG files (next is 01)' ($previewSeparate.fileName -eq 'QPE-JPG-sep-01.jpg' -and $previewSeparate.nextNumber -eq 1) ($previewSeparate | ConvertTo-Json -Compress)

$previewCase = $byName['A-preview-case'].result
Check 'shared numbering counts .JPG and .jpeg case variants' ($previewCase.fileName -eq 'QPE-JPG-case-05.jpg') ($previewCase | ConvertTo-Json -Compress)

$estimateJpg = $byName['A-estimate-jpg'].result
Check 'JPG size estimate succeeds' ($estimateJpg.ok -eq $true -and $estimateJpg.bytes -gt 0) ($estimateJpg | ConvertTo-Json -Compress)

$exportShared = $byName['A-export-shared'].result
Check 'document JPG export is written as -04.jpg' ($exportShared.ok -eq $true -and $exportShared.fileName -eq 'QPE-JPG-shared-04.jpg') ($exportShared | ConvertTo-Json -Compress)

$sharedJpg = Join-Path $outDir 'QPE-JPG-shared-04.jpg'
Check 'exported JPG exists and is not empty' ((Test-Path -LiteralPath $sharedJpg) -and ((Get-Item -LiteralPath $sharedJpg).Length -gt 0)) $sharedJpg

$matchJpg = $byName['A-estimate-match-jpg'].result
$diffJpg = [Math]::Abs([double]$matchJpg.estimate - [double]$matchJpg.actual)
Check 'JPG estimate matches the actual file size' ($matchJpg.actual -gt 0 -and $diffJpg -le 16) ('estimate=' + $matchJpg.estimate + ' actual=' + $matchJpg.actual)

$estimatePng = $byName['A-estimate-png'].result
Check 'PNG size estimate succeeds' ($estimatePng.ok -eq $true -and $estimatePng.bytes -gt 0) ($estimatePng | ConvertTo-Json -Compress)

$exportPng = $byName['A-export-pngest'].result
Check 'document PNG export still works alongside JPG' ($exportPng.ok -eq $true -and $exportPng.fileName -eq 'QPE-JPG-pngest-01.png') ($exportPng | ConvertTo-Json -Compress)

$matchPng = $byName['A-estimate-match-png'].result
$diffPng = [Math]::Abs([double]$matchPng.estimate - [double]$matchPng.actual)
Check 'PNG estimate matches the actual file size' ($matchPng.actual -gt 0 -and $diffPng -le 16) ('estimate=' + $matchPng.estimate + ' actual=' + $matchPng.actual)

$q2 = $byName['A-quality-2'].result
$q12 = $byName['A-quality-12'].result
Check 'quality 2 and quality 12 both export' ($q2.ok -eq $true -and $q12.ok -eq $true -and $q2.size -gt 0 -and $q12.size -gt 0) ('q2=' + $q2.size + ' q12=' + $q12.size)
Check 'quality 12 is clearly larger than quality 2' (($q12.size -gt ($q2.size * 1.5))) ('q2=' + $q2.size + ' q12=' + $q12.size)

$over = $byName['A-overwrite'].result
Check 'an existing target file is never overwritten (next is 02)' ($over.ok -eq $true -and $over.fileName -eq 'QPE-JPG-over-02.jpg') ($over | ConvertTo-Json -Compress)
$seedPath = Join-Path $outDir 'QPE-JPG-over-01.jpg'
Check 'the seeded -01.jpg is untouched' ((Get-Content -LiteralPath $seedPath -Raw) -eq 'seed-over') 'seed-over'

$caseExport = $byName['A-case'].result
Check 'JPG export continues after the case-variant files (next is 05)' ($caseExport.ok -eq $true -and $caseExport.fileName -eq 'QPE-JPG-case-05.jpg') ($caseExport | ConvertTo-Json -Compress)

Check 'source document is unchanged after JPG export' ($byName['A-state-unchanged'].result -eq $true) 'layer state changed'

$badQuality = $byName['A-bad-quality'].result
Check 'quality outside 0-12 is rejected with BAD_QUALITY' ($badQuality.code -eq 'BAD_QUALITY') ($badQuality | ConvertTo-Json -Compress)

$b16 = $byName['B-16-export'].result
Check '16-bit JPG export converts on a copy' ($b16.ok -eq $true -and $b16.converted -eq $true) ($b16 | ConvertTo-Json -Compress)
Check '16-bit JPG export emits a conversion warning' ($b16.warningCount -ge 1) ('warnings=' + $b16.warningCount)
Check '16-bit source document is untouched' ($b16.bitsKept -eq $true -and $b16.modeKept -eq $true) ($b16 | ConvertTo-Json -Compress)

$cmyk = $byName['B-cmyk-export'].result
Check 'CMYK JPG export converts on a copy' ($cmyk.ok -eq $true -and $cmyk.converted -eq $true) ($cmyk | ConvertTo-Json -Compress)
Check 'CMYK JPG export emits a conversion warning' ($cmyk.warningCount -ge 1) ('warnings=' + $cmyk.warningCount)
Check 'CMYK source document is untouched' ($cmyk.modeKept -eq $true) ($cmyk | ConvertTo-Json -Compress)

$previewS = $byName['C-preview'].result
Check 'selection preview exposes a selection key and plan' ($previewS.ok -eq $true -and [string]$previewS.selectionKey -ne '' -and $previewS.itemCount -ge 2) ($previewS | ConvertTo-Json -Compress)

$exportS = $byName['C-export'].result
Check 'selection JPG export skips dependencies and empty objects' ($exportS.ok -eq $true -and $exportS.successCount -eq 3) ($exportS | ConvertTo-Json -Compress)
Check 'selection JPG export numbers 1..3 without gaps' (($exportS.numbers -join ',') -eq '1,2,3') ($exportS.numbers -join ',')
Check 'empty layers/groups are skipped at export time' ($exportS.skipCount -ge 2 -and ($exportS.skipCodes -contains 'EMPTY')) ($exportS.skipCodes -join ',')
Check 'selection JPG export leaves the source document untouched' ($exportS.changed -eq $false) 'layer state changed'

foreach ($name in @('QPE-JPG-S-01.jpg', 'QPE-JPG-S-02.jpg', 'QPE-JPG-S-03.jpg')) {
    $path = Join-Path $outDir $name
    Check ('exported ' + $name) ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Length -gt 0)) $name
}

$dStatus = $byName['D-status'].result
$expectedPath = (Resolve-Path -LiteralPath $savedDir).Path
Check 'saved document status returns its folder' ($dStatus.saved -eq $true -and [string]$dStatus.path -ne '' -and ([string]$dStatus.path).TrimEnd('\') -eq $expectedPath.TrimEnd('\')) ('path=' + $dStatus.path + ' expected=' + $expectedPath)

$dExport = $byName['D-export'].result
Check 'JPG export into the document folder works' ($dExport.ok -eq $true -and $dExport.fileName -eq 'QPE-JPG-saved-01.jpg') ($dExport | ConvertTo-Json -Compress)
$dPath = Join-Path $savedDir 'QPE-JPG-saved-01.jpg'
Check 'saved-document JPG exists and is not empty' ((Test-Path -LiteralPath $dPath) -and ((Get-Item -LiteralPath $dPath).Length -gt 0)) $dPath

$dialogs = $byName['E-display-dialogs'].result
Check 'displayDialogs is restored after export and estimate' ($dialogs.exportOk -eq $true -and $dialogs.estimateOk -eq $true -and $dialogs.restored -eq $true) ($dialogs | ConvertTo-Json -Compress)

$temp = $byName['F-temp-clean'].result
Check 'no estimate temp files are left behind' ($temp.after -eq 0) ('temp leftovers: ' + ($temp.leftovers -join ','))

Check 'no temporary documents left open' ($byName['run-cleanup'].result.openDocuments -eq 0) ('openDocuments=' + $byName['run-cleanup'].result.openDocuments)

# Recorded estimate temp names must never show up in the output folder either.
$outFiles = @($result.files | ForEach-Object { [string]$_.name })
$estimateNoise = @($outFiles | Where-Object { $_ -like 'qpe-estimate-*' })
Check 'the output folder holds no estimate temp files' ($estimateNoise.Count -eq 0) ($estimateNoise -join ',')

# JPEG structure: SOI marker (FF D8 FF) proves Photoshop wrote a real JPEG.
$bytes = [System.IO.File]::ReadAllBytes($sharedJpg)
$signature = ($bytes[0..2] | ForEach-Object { $_.ToString('X2') }) -join ''
Check 'exported file is a real JPEG (SOI marker)' ($signature -eq 'FFD8FF') ("sig=$signature")

Add-Type -AssemblyName System.Drawing
function Get-Pixel([string]$path, [int]$x, [int]$y) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($path)
    $pixel = $bitmap.GetPixel($x, $y)
    $bitmap.Dispose()
    return $pixel
}

$corner = Get-Pixel $sharedJpg 2 2
Check 'transparent areas were filled white' (($corner.R -ge 240) -and ($corner.G -ge 240) -and ($corner.B -ge 240)) ("rgb=$($corner.R),$($corner.G),$($corner.B)")

$red = Get-Pixel $sharedJpg 30 30
Check 'the red artwork survived the export' (($red.R -ge 150) -and ($red.G -le 80) -and ($red.B -le 80)) ("rgb=$($red.R),$($red.G),$($red.B)")

Write-Host ''
Write-Host ('Report: ' + $resultFile)
Write-Host ('Output: ' + $outDir)

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host ($failures.Count.ToString() + ' CHECK(S) FAILED')
    exit 1
}

Write-Host ''
Write-Host 'ALL JPG CHECKS PASSED'
exit 0
