# PNG Smart Export - real acceptance run for the batch (selected layers) export.
#
# Drives Photoshop over COM: loads jsx/host.jsx, then runs
# tests/photoshop/batch-acceptance.jsx in the same ExtendScript engine. The
# harness creates throw-away documents, selects layers, exports PNGs into
# .tmp\ps-batch-verify\export and prints a JSON report; this script checks the
# report and exits non-zero on the first semantic mismatch.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-batch-photoshop.ps1
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
$harnessFile = Join-Path $root 'tests\photoshop\batch-acceptance.jsx'
$tmpDir = Join-Path $root '.tmp'
$resultFile = Join-Path $tmpDir 'batch-acceptance-result.json'

if (-not (Test-Path $hostFile)) {
    throw "jsx\host.jsx is missing. Run 'node scripts/build-host.mjs' first."
}
if (-not (Test-Path $harnessFile)) {
    throw "tests\photoshop\batch-acceptance.jsx is missing."
}
if (-not (Test-Path $tmpDir)) {
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
}

$hostSource = [System.IO.File]::ReadAllText($hostFile)
$harnessSource = [System.IO.File]::ReadAllText($harnessFile)
$baseDir = ($root.Replace('\', '/')) + '/.tmp/ps-batch-verify/'
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

Check 'report ok' ($result.ok -eq $true) 'harness reported a failure'

$previewA = $byName['A-preview'].result
Check 'A preview lists 5 exportable objects' ($previewA.count -eq 5) ('count=' + $previewA.count)
Check 'A preview skips blend + clipped dependencies' ($previewA.skipped.Count -eq 3) ('skipped=' + $previewA.skipped.Count)
Check 'A preview exposes a selection key' ([string]$previewA.selectionKey -ne '') 'selectionKey missing'

$stale = $byName['A-stale-selection'].result
Check 'stale selection is rejected' ($stale.code -eq 'SELECTION_CHANGED') ('code=' + $stale.code)

$export1 = $byName['A-export-1'].result
Check 'first batch exports 3 files' ($export1.successes.Count -eq 3) ('successes=' + $export1.successes.Count)
Check 'first batch numbers 1..3' (($export1.successes | ForEach-Object { $_.number }) -join ',' -eq '1,2,3') (($export1.successes | ForEach-Object { $_.number }) -join ',')
Check 'first batch skips 5 objects' ($export1.skipped.Count -eq 5) ('skipped=' + $export1.skipped.Count)
Check 'first batch leaves no failed item' ($null -eq $export1.failed) 'failed is not null'

$export2 = $byName['A-export-2'].result
Check 'second batch continues at 4..6' (($export2.successes | ForEach-Object { $_.number }) -join ',' -eq '4,5,6') (($export2.successes | ForEach-Object { $_.number }) -join ',')

Check 'source document A unchanged' ($byName['A-state-unchanged'].result -eq $true) 'layer state changed'
Check '16-bit document converts to 8-bit on export' ($byName['D-export'].result.converted -eq $true) 'converted is not true'
Check '16-bit source document unchanged' ($byName['D-state-unchanged'].result -eq $true) 'layer state changed'
Check 'no document reports NO_DOCUMENT' ($byName['C-preview-no-doc'].result.code -eq 'NO_DOCUMENT') ('code=' + $byName['C-preview-no-doc'].result.code)
Check 'external clip base is skipped' ($byName['B-export'].result.counts.allSkipped -eq $true) 'batch was not fully skipped'
Check 'displayDialogs restored after export' ($byName['F-display-dialogs'].result.restored -eq $true) 'dialogs changed'
Check 'no temporary documents left open' ($byName['run-cleanup'].result.openDocuments -eq 0) ('openDocuments=' + $byName['run-cleanup'].result.openDocuments)

$names = @($result.files | ForEach-Object { [string]$_.name })
$expected = @('QPE-A-01.png', 'QPE-A-02.png', 'QPE-A-03.png', 'QPE-A-04.png', 'QPE-A-05.png', 'QPE-A-06.png', 'QPE-D-01.png', 'QPE-F-01.png')
foreach ($name in $expected) {
    Check ('exported ' + $name) ($names -contains $name) 'missing'
}

# Pixel checks: proves that a group export keeps its internal clip and hidden
# child, and that a plain layer only contains its own pixels.
Add-Type -AssemblyName System.Drawing
$exportDir = Join-Path $root '.tmp\ps-batch-verify\export'
function Get-Pixel([string]$fileName, [int]$x, [int]$y) {
    $bitmap = [System.Drawing.Bitmap]::FromFile((Join-Path $exportDir $fileName))
    $pixel = $bitmap.GetPixel($x, $y)
    $bitmap.Dispose()
    return $pixel
}
function Test-Pixel([string]$fileName, [int]$x, [int]$y, [int]$a, [int]$r, [int]$g, [int]$b) {
    $pixel = Get-Pixel $fileName $x $y
    return (($pixel.A -eq $a) -and ($pixel.R -eq $r) -and ($pixel.G -eq $g) -and ($pixel.B -eq $b))
}

Check 'A-01 keeps the group internal clip (cyan over yellow)' (Test-Pixel 'QPE-A-01.png' 100 20 255 0 200 200) 'pixel mismatch'
Check 'A-01 keeps the yellow base outside the clip' (Test-Pixel 'QPE-A-01.png' 92 12 255 220 220 0) 'pixel mismatch'
Check 'A-01 keeps the hidden child hidden' ((Get-Pixel 'QPE-A-01.png' 100 70).A -eq 0) 'hidden child leaked'
Check 'A-02 contains the explicitly selected hidden layer' (Test-Pixel 'QPE-A-02.png' 80 80 255 0 0 200) 'pixel mismatch'
Check 'A-03 contains only the red layer' (Test-Pixel 'QPE-A-03.png' 20 20 255 200 0 0) 'pixel mismatch'
Check 'A-03 leaves the green layer out' ((Get-Pixel 'QPE-A-03.png' 50 50).A -eq 0) 'unexpected pixels'
Check 'A-04 repeats the A-01 group export' (Test-Pixel 'QPE-A-04.png' 100 20 255 0 200 200) 'pixel mismatch'
Check 'A-06 repeats the A-03 layer export' (Test-Pixel 'QPE-A-06.png' 20 20 255 200 0 0) 'pixel mismatch'
Check 'D-01 converted 16-bit content is opaque red' (Test-Pixel 'QPE-D-01.png' 20 20 255 200 0 0) 'pixel mismatch'

Write-Host ''
Write-Host ('Report: ' + $resultFile)
Write-Host ('Output: ' + (Join-Path $root '.tmp\ps-batch-verify\export'))

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host ($failures.Count.ToString() + ' CHECK(S) FAILED')
    exit 1
}

Write-Host ''
Write-Host 'ALL BATCH CHECKS PASSED'
exit 0

