# Quick PNG Export - real acceptance run against an installed Photoshop.
#
# This drives Photoshop over COM: it loads jsx/host.jsx into Photoshop's
# ExtendScript engine, creates throw-away documents, and exercises the same
# QPE_call() entry point the panel uses. The test documents are closed without
# saving; Photoshop is only quit if this script started it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-photoshop.ps1
#
# The script is pure ASCII on purpose: Windows PowerShell 5.1 reads a .ps1
# without a BOM as ANSI, so Chinese literals here would be corrupted. Chinese
# file names are built from code points and passed to ExtendScript as \uXXXX
# escapes, exactly like the panel's bridge does.
#
# Exit code 0 = every check passed. Exported PNGs stay in .tmp\ps-verify\.

[CmdletBinding()]
param(
    [string]$OutputDir,
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) {
    $OutputDir = Join-Path $root '.tmp\ps-verify\export'
}
$hostFile = Join-Path $root 'jsx\host.jsx'
if (-not (Test-Path $hostFile)) {
    throw "jsx\host.jsx is missing. Run 'node scripts/build-host.mjs' first."
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

# "QPE-" + U+6D4B + U+8BD5 (Chinese "test"). No literal non-ASCII in this file.
$prefix = 'QPE-' + [char]0x6D4B + [char]0x8BD5

# ---- prepare a clean output folder -----------------------------------------
if (Test-Path $OutputDir) {
    Remove-Item -Path $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

# Seeds: -05 exists (gap + max+1), -09.PNG uses another case (case-insensitive
# match), one directory and two near misses must be ignored.
[System.IO.File]::WriteAllText((Join-Path $OutputDir ($prefix + '-05.png')), 'seed05')
[System.IO.File]::WriteAllText((Join-Path $OutputDir ('qpe-' + [char]0x6D4B + [char]0x8BD5 + '-09.PNG')), 'seed09')
[System.IO.File]::WriteAllText((Join-Path $OutputDir ($prefix + '-3 (1).png')), 'decoy')
[System.IO.File]::WriteAllText((Join-Path $OutputDir ($prefix + '-abc.png')), 'decoy')
New-Item -ItemType Directory -Path (Join-Path $OutputDir ($prefix + '-20.png')) -Force | Out-Null

function To-JsPath([string]$path) {
    return $path.Replace('\', '/')
}
$jsxPath = To-JsPath $hostFile
$jsxOut = To-JsPath $OutputDir

# ---- ExtendScript acceptance body (ASCII only) -----------------------------
$script = @'
(function () {
    var out = {};
    var hostFile = new File("__HOST__");
    if (!hostFile.exists) { return "HOST_MISSING"; }
    $.evalFile(hostFile);

    function describe(doc) {
        var info = {
            name: doc.name,
            saved: doc.saved,
            width: Math.round(doc.width.as("px")),
            height: Math.round(doc.height.as("px")),
            layers: doc.layers.length,
            path: "",
            fullName: "untitled"
        };
        try { info.path = doc.path ? doc.path.fsName : ""; } catch (e) { info.path = ""; }
        try { info.fullName = doc.fullName ? doc.fullName.fsName : "untitled"; } catch (e) { info.fullName = "untitled"; }
        return info;
    }

    function call(method, payload) {
        var text = QPE_call(method, QPECore.toJson(payload));
        return eval("(" + text + ")");
    }

    // Close leftovers from earlier runs of this script (our own document names).
    for (var i = app.documents.length - 1; i >= 0; i--) {
        var leftover = app.documents[i].name;
        if (leftover === "QPE-Test" || leftover === "QPE-16" || leftover === "QuickPNG-temp") {
            app.documents[i].close(SaveOptions.DONOTSAVECHANGES);
        }
    }
    out.baseline = app.documents.length;
    if (out.baseline > 0) {
        out.skipped = true;
        return QPECore.toJson(out);
    }

    var oldUnits = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    var doc = app.documents.add(new UnitValue(800, "px"), new UnitValue(600, "px"), 72,
        "QPE-Test", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
        BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
    app.preferences.rulerUnits = oldUnits;
    doc = app.activeDocument;

    var args = { prefix: "QPE-\u6d4b\u8bd5", digits: 2, folder: "__OUT__" };
    out.docBefore = describe(doc);
    out.statusBefore = call("status", {});
    out.preview = call("preview", args);
    out.export1 = call("exportPng", args);
    out.export2 = call("exportPng", args);
    out.activeAfterExport = app.activeDocument.name;
    out.docAfter = describe(doc);

    // 16-bit source: must be converted on a temporary copy, source untouched.
    var oldUnits2 = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    var doc16 = app.documents.add(new UnitValue(100, "px"), new UnitValue(80, "px"), 72,
        "QPE-16", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
        BitsPerChannelType.SIXTEEN, "sRGB IEC61966-2.1");
    app.preferences.rulerUnits = oldUnits2;
    doc16 = app.activeDocument;
    var depthBefore = doc16.bitsPerChannel;
    out.export16 = call("exportPng", args);
    out.doc16After = describe(doc16);
    out.doc16DepthKept = (doc16.bitsPerChannel === BitsPerChannelType.SIXTEEN) && (depthBefore === BitsPerChannelType.SIXTEEN);
    doc16.close(SaveOptions.DONOTSAVECHANGES);

    out.badPrefix = call("exportPng", { prefix: "a/b", digits: 2, folder: "__OUT__" });
    out.badDigits = call("preview", { prefix: "QPE-\u6d4b\u8bd5", digits: 5, folder: "__OUT__" });
    out.missingFolder = call("preview", { prefix: "QPE-\u6d4b\u8bd5", digits: 2, folder: "__OUT__/nope" });

    doc.close(SaveOptions.DONOTSAVECHANGES);
    out.docsAfterClose = app.documents.length;
    out.noDoc = call("exportPng", args);
    return QPECore.toJson(out);
}());
'@
$script = $script.Replace('__HOST__', $jsxPath).Replace('__OUT__', $jsxOut)

# ---- drive Photoshop ------------------------------------------------------
$startedHere = $false
$com = $null
$running = Get-Process -Name Photoshop -ErrorAction SilentlyContinue
if (-not $running) {
    $startedHere = $true
}
try {
    $com = New-Object -ComObject Photoshop.Application
    Write-Host 'Photoshop connected.'
    $raw = $com.DoJavaScript($script)
    if (-not $raw) {
        throw 'DoJavaScript returned nothing.'
    }
    $result = $raw | ConvertFrom-Json
} finally {
    if ($com) {
        if ($startedHere -and -not $KeepOpen) {
            try { $com.Quit() } catch { Write-Host "Quit note: $_" }
        }
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($com)
    }
}

# ---- assertions -----------------------------------------------------------
if ($result.skipped -eq $true) {
    Write-Host ''
    Write-Host "SKIP: Photoshop already has $($result.baseline) other document(s) open."
    Write-Host 'Close them and rerun this script so your work is never touched.'
    exit 2
}

$expected1 = $prefix + '-10.png'
$expected2 = $prefix + '-11.png'
$expected16 = $prefix + '-12.png'
$path1 = Join-Path $OutputDir $expected1
$path2 = Join-Path $OutputDir $expected2
$path16 = Join-Path $OutputDir $expected16

Check 'test starts from a clean document state' ($result.baseline -eq 0) ("baseline=$($result.baseline)")
Check 'status reports the 800x600 document' ($result.statusBefore.hasDocument -eq $true -and $result.statusBefore.width -eq 800 -and $result.statusBefore.height -eq 600) ($result.statusBefore | ConvertTo-Json -Compress)
Check 'new document is 800x600' ($result.docBefore.width -eq 800 -and $result.docBefore.height -eq 600) ($result.docBefore | ConvertTo-Json -Compress)
Check 'preview uses max+1, ignores gaps, decoys and directories' ($result.preview.fileName -eq $expected1 -and $result.preview.nextNumber -eq 10) ($result.preview | ConvertTo-Json -Compress)
Check 'preview counts the case-variant -09.PNG' ($result.preview.existingCount -eq 2) ($result.preview | ConvertTo-Json -Compress)
Check 'first export is -10' ($result.export1.ok -eq $true -and $result.export1.fileName -eq $expected1) ($result.export1 | ConvertTo-Json -Compress)
Check 'second export is -11' ($result.export2.ok -eq $true -and $result.export2.fileName -eq $expected2) ($result.export2 | ConvertTo-Json -Compress)
Check 'first PNG exists and is not empty' ((Test-Path -LiteralPath $path1) -and ((Get-Item -LiteralPath $path1).Length -gt 0)) $path1
Check 'second PNG exists and is not empty' ((Test-Path -LiteralPath $path2) -and ((Get-Item -LiteralPath $path2).Length -gt 0)) $path2
Check 'seeded -05 was not overwritten' ((Get-Content -LiteralPath (Join-Path $OutputDir ($prefix + '-05.png')) -Raw) -eq 'seed05') 'seed05'
Check 'seeded -09.PNG was not overwritten' ((Get-Content -LiteralPath (Join-Path $OutputDir ('qpe-' + [char]0x6D4B + [char]0x8BD5 + '-09.PNG')) -Raw) -eq 'seed09') 'seed09'
Check 'numbers 01-04 were not reused' (-not (Get-ChildItem -LiteralPath $OutputDir -Filter ($prefix + '-0[1-4].png') -File -ErrorAction SilentlyContinue)) 'unexpected file'
Check 'source document keeps its name, size, layer and stays untitled' ($result.docAfter.name -eq 'QPE-Test' -and $result.docAfter.width -eq 800 -and $result.docAfter.height -eq 600 -and $result.docAfter.layers -eq 1 -and $result.docAfter.path -eq '' -and $result.docAfter.fullName -eq 'untitled') ($result.docAfter | ConvertTo-Json -Compress)
Check 'source document is active again after export' ($result.activeAfterExport -eq 'QPE-Test') ("active=$($result.activeAfterExport)")
Check 'no extra document was left open' ($result.docsAfterClose -eq 0) ("docsAfterClose=$($result.docsAfterClose)")
Check '16-bit export reports converted=true' ($result.export16.ok -eq $true -and $result.export16.converted -eq $true -and $result.export16.fileName -eq $expected16) ($result.export16 | ConvertTo-Json -Compress)
Check '16-bit export emits a warning' (@($result.export16.warnings).Count -ge 1) ($result.export16 | ConvertTo-Json -Compress)
Check '16-bit source document is untouched (still 16-bit, still untitled)' ($result.doc16DepthKept -eq $true -and $result.doc16After.path -eq '' -and $result.doc16After.fullName -eq 'untitled' -and $result.doc16After.layers -eq 1) ($result.doc16After | ConvertTo-Json -Compress)
Check 'illegal prefix is rejected with ILLEGAL_CHARS' ($result.badPrefix.code -eq 'ILLEGAL_CHARS') ($result.badPrefix | ConvertTo-Json -Compress)
Check 'invalid digits are rejected' ($result.badDigits.code -eq 'BAD_DIGITS') ($result.badDigits | ConvertTo-Json -Compress)
Check 'missing folder is reported' ($result.missingFolder.code -eq 'FOLDER_MISSING') ($result.missingFolder | ConvertTo-Json -Compress)
$expectedNoDoc = -join ([int[]]@(0x8BF7, 0x5148, 0x6253, 0x5F00, 0x4E00, 0x4E2A, 0x20, 0x50, 0x68, 0x6F, 0x74, 0x6F, 0x73, 0x68, 0x6F, 0x70, 0x20, 0x6587, 0x6863) | ForEach-Object { [char]$_ })
Check 'no document gives the documented message' ($result.noDoc.code -eq 'NO_DOCUMENT' -and $result.noDoc.message -eq $expectedNoDoc) ($result.noDoc | ConvertTo-Json -Compress)

# PNG structure: signature + IHDR size, proves Photoshop wrote a real PNG.
$bytes = [System.IO.File]::ReadAllBytes($path1)
$signature = ($bytes[0..7] | ForEach-Object { $_.ToString('X2') }) -join ''
$pngWidth = [int]$bytes[16] * 16777216 + [int]$bytes[17] * 65536 + [int]$bytes[18] * 256 + [int]$bytes[19]
$pngHeight = [int]$bytes[20] * 16777216 + [int]$bytes[21] * 65536 + [int]$bytes[22] * 256 + [int]$bytes[23]
$colorType = [int]$bytes[25]
Check 'exported file is a PNG with IHDR 800x600' ($signature -eq '89504E470D0A1A0A' -and $pngWidth -eq 800 -and $pngHeight -eq 600) ("sig=$signature ${pngWidth}x${pngHeight}")
Check 'exported PNG keeps an alpha channel (color type 6)' ($colorType -eq 6) "colorType=$colorType"

Write-Host ''
Write-Host "Output folder: $OutputDir"
if ($failures.Count -gt 0) {
    Write-Host ("FAILED: {0} check(s): {1}" -f $failures.Count, ($failures -join ', '))
    exit 1
}
Write-Host 'ALL CHECKS PASSED'
exit 0
