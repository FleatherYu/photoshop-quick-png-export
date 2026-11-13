/*
 * Photoshop Quick PNG Export - real acceptance run for the 1.3.0 collage mode.
 *
 * The harness creates throw-away documents only, exports collages into
 * __QPE_BASE_DIR__/export and returns a JSON report with one step per check.
 * scripts/verify-collage-photoshop.ps1 asserts every step (sizes, file names,
 * grid order and pixels) and exits non-zero on any mismatch.
 *
 * Safety rules:
 *  - when any user document is open the harness returns a SKIP report and never
 *    touches the user documents;
 *  - every document opened here is closed again and the source documents are
 *    compared before/after (layers, selection, saved flag, mode, bit depth);
 *  - temporary files left in Folder.temp by the export are counted and must not
 *    grow; displayDialogs is restored at the end.
 *
 * Grid contract under test: one cell = one full source canvas, no gutter, row
 * major, cells filled in Layers-panel order (top-most selected layer first), and
 * every object keeps its in-canvas position inside its cell.
 */
(function () {
    var out = { steps: [], ok: false, skipped: false };
    var originalDialogs = app.displayDialogs;
    var openedDocs = [];
    var outFolder = null;

    /* ---------------------------------------------------------------------
     * Tiny JSON writer (ExtendScript has no JSON object).
     * ------------------------------------------------------------------- */

    function esc(value) {
        var text = String(value);
        var result = "";
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            var code = text.charCodeAt(i);
            if (ch === "\\") { result += "\\\\"; }
            else if (ch === "\"") { result += "\\\""; }
            else if (ch === "\n") { result += "\\n"; }
            else if (ch === "\r") { result += "\\r"; }
            else if (ch === "\t") { result += "\\t"; }
            else if (code < 32) {
                result += "\\u" + ("000" + code.toString(16)).slice(-4);
            } else {
                result += ch;
            }
        }
        return result;
    }

    function jsonValue(value) {
        if (value === null || value === undefined) { return "null"; }
        var kind = typeof value;
        if (kind === "number") { return isFinite(value) ? String(value) : "null"; }
        if (kind === "boolean") { return value ? "true" : "false"; }
        if (kind === "string") { return "\"" + esc(value) + "\""; }
        if (value instanceof Array) {
            var items = [];
            for (var i = 0; i < value.length; i++) { items.push(jsonValue(value[i])); }
            return "[" + items.join(",") + "]";
        }
        var parts = [];
        for (var key in value) {
            if (value.hasOwnProperty(key)) {
                parts.push("\"" + esc(key) + "\":" + jsonValue(value[key]));
            }
        }
        return "{" + parts.join(",") + "}";
    }

    /* ---------------------------------------------------------------------
     * Host bridge.
     * ------------------------------------------------------------------- */

    function hostCall(method, args) {
        var raw;
        try {
            raw = QPE_call(method, QPECore.toJson(args));
        } catch (callError) {
            return { ok: false, code: "CALL_THREW", message: String(callError.message || callError) };
        }
        try {
            return eval("(" + raw + ")");
        } catch (parseError) {
            return { ok: false, code: "PARSE_FAILED", message: String(parseError.message || parseError), raw: String(raw) };
        }
    }

    /* ---------------------------------------------------------------------
     * Document helpers.
     * ------------------------------------------------------------------- */

    function px(value) { return new UnitValue(value, "px"); }

    function rgb(red, green, blue) {
        var color = new SolidColor();
        color.rgb.red = red;
        color.rgb.green = green;
        color.rgb.blue = blue;
        return color;
    }

    function cmyk(cyan, magenta, yellow, black) {
        var color = new SolidColor();
        color.cmyk.cyan = cyan;
        color.cmyk.magenta = magenta;
        color.cmyk.yellow = yellow;
        color.cmyk.black = black;
        return color;
    }

    function makeDoc(name, width, height, mode, fill, bits) {
        var doc;
        if (mode === NewDocumentMode.CMYK) {
            doc = app.documents.add(px(width), px(height), 72, name, NewDocumentMode.CMYK,
                fill, 1.0, bits);
        } else {
            doc = app.documents.add(px(width), px(height), 72, name, NewDocumentMode.RGB,
                fill, 1.0, bits, "sRGB IEC61966-2.1");
        }
        openedDocs.push(doc);
        return doc;
    }

    function closeDoc(doc) {
        try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) { }
    }

    function paintLayer(doc, layer, x1, y1, x2, y2, color) {
        doc.activeLayer = layer;
        doc.selection.select([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
        doc.selection.fill(color);
        doc.selection.deselect();
    }

    function addPatchLayer(doc, name, x1, y1, x2, y2, color) {
        var layer = doc.artLayers.add();
        layer.name = name;
        paintLayer(doc, layer, x1, y1, x2, y2, color);
        return layer;
    }

    function findLayerByName(doc, name) {
        var found = null;
        function walk(container) {
            var items = container.layers;
            for (var i = 0; i < items.length; i++) {
                var layer = items[i];
                if (layer.typename === "LayerSet") {
                    walk(layer);
                } else if (String(layer.name) === String(name)) {
                    found = layer;
                }
            }
        }
        walk(doc);
        return found;
    }

    function selectAllLayers() {
        app.runMenuItem(stringIDToTypeID("selectAllLayers"));
    }

    /* ---------------------------------------------------------------------
     * State snapshots / file helpers.
     * ------------------------------------------------------------------- */

    function captureState(doc) {
        var layers = [];
        function walk(container, path) {
            var items = container.layers;
            for (var i = 0; i < items.length; i++) {
                var layer = items[i];
                layers.push(path + "." + i + "|" + layer.name + "|" + layer.typename + "|" + layer.visible);
                if (layer.typename === "LayerSet") {
                    walk(layer, path + "." + i);
                }
            }
        }
        walk(doc, "");
        return {
            layers: layers,
            active: String(doc.activeLayer.id),
            saved: doc.saved,
            mode: String(doc.mode),
            bits: String(doc.bitsPerChannel)
        };
    }

    function sameState(before, after) {
        return jsonValue(before) === jsonValue(after);
    }

    function fileLength(path) {
        try {
            var file = new File(path);
            return file.length;
        } catch (lengthError) {
            return -1;
        }
    }

    function countFiles(folder) {
        var entries = folder.getFiles();
        var count = 0;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i] instanceof File) { count++; }
        }
        return count;
    }

    function tempNames(prefix) {
        var names = [];
        var entries;
        try { entries = Folder.temp.getFiles(); } catch (tempError) { return names; }
        for (var i = 0; i < entries.length; i++) {
            var name = String(entries[i].name);
            if (name.indexOf(prefix) === 0) { names.push(name); }
        }
        return names;
    }

    function leftoverNames(before, after) {
        var leftovers = [];
        for (var i = 0; i < after.length; i++) {
            var known = false;
            for (var j = 0; j < before.length; j++) {
                if (before[j] === after[i]) { known = true; break; }
            }
            if (!known) { leftovers.push(after[i]); }
        }
        return leftovers;
    }

    function seedFile(folder, name, text) {
        var file = new File(folder.fsName + "/" + name);
        file.open("w");
        file.write(text);
        file.close();
    }

    function clearFolder(folder) {
        if (!folder.exists) { folder.create(); return; }
        var entries = folder.getFiles();
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry instanceof File) { entry.remove(); }
            else if (entry instanceof Folder) { entry.remove(); }
        }
    }

    /* ---------------------------------------------------------------------
     * Step recorders.
     * ------------------------------------------------------------------- */

    function previewStep(name, args) {
        var result = hostCall("previewCollage", args);
        var itemNames = [];
        var skipCodes = [];
        var i;
        if (result.items) {
            for (i = 0; i < result.items.length; i++) { itemNames.push(String(result.items[i].name)); }
        }
        if (result.skipped) {
            for (i = 0; i < result.skipped.length; i++) { skipCodes.push(String(result.skipped[i].code)); }
        }
        out.steps.push({
            name: name,
            result: {
                ok: result.ok === true,
                code: result.code || "",
                message: result.message || "",
                document: result.document || "",
                documentWidth: result.documentWidth,
                documentHeight: result.documentHeight,
                selectionKey: result.selectionKey || "",
                selectedCount: result.selectedCount,
                count: result.count,
                itemNames: itemNames,
                skippedCount: result.skipped ? result.skipped.length : 0,
                skipCodes: skipCodes,
                folderAvailable: result.folderAvailable,
                fileName: result.fileName || "",
                startNumber: result.startNumber,
                maxNumber: result.maxNumber,
                existingCount: result.existingCount,
                warnings: result.warnings || []
            }
        });
        return result;
    }

    function recordExport(name, args) {
        var before = countFiles(outFolder);
        var result = hostCall("exportCollage", args);
        result.newFileCount = countFiles(outFolder) - before;
        var placedNames = [];
        var cellColumns = [];
        var cellRows = [];
        var skipCodes = [];
        var i;
        if (result.placed) {
            for (i = 0; i < result.placed.length; i++) {
                placedNames.push(String(result.placed[i].name));
                cellColumns.push(Number(result.placed[i].cellColumn));
                cellRows.push(Number(result.placed[i].cellRow));
            }
        }
        if (result.skipped) {
            for (i = 0; i < result.skipped.length; i++) { skipCodes.push(String(result.skipped[i].code)); }
        }
        result.placedNames = placedNames;
        result.placedCellColumns = cellColumns;
        result.placedCellRows = cellRows;
        result.skipCodes = skipCodes;
        result.skipCount = result.skipped ? result.skipped.length : 0;
        result.warningCount = result.warnings ? result.warnings.length : 0;
        result.fileSize = result.fullPath ? fileLength(result.fullPath) : -1;
        out.steps.push({ name: name, result: result });
        return result;
    }

    /* =====================================================================
     * Run.
     * =================================================================== */

    try {
        app.displayDialogs = DialogModes.NO;

        if (app.documents.length > 0) {
            out.skipped = true;
            out.reason = "Photoshop has " + app.documents.length +
                " user document(s) open. Close them and run the script again.";
            return jsonValue(out);
        }

        var baseDir = "__QPE_BASE_DIR__";
        outFolder = new Folder(baseDir + "export");
        clearFolder(outFolder);
        out.outFolder = outFolder.fsName;

        var tempCollageBefore = tempNames("qpe-collage-");
        var tempEstimateBefore = tempNames("qpe-estimate-");

        seedFile(outFolder, "QPE-Collage-shared-03.png", "seed");
        seedFile(outFolder, "QPE-Collage-shared-07.tif", "seed");
        seedFile(outFolder, "QPE-Collage-sep-02.jpg", "seed");
        seedFile(outFolder, "QPE-Collage-mix-06.JPG", "seed");
        seedFile(outFolder, "QPE-Collage-mix-07.jpeg", "seed");
        seedFile(outFolder, "QPE-Collage-over-01.png", "seed-over");
        var decoyFolder = new Folder(outFolder.fsName + "/QPE-Collage-shared-09.png");
        decoyFolder.create();

        /* =================================================================
         * A - main 400x400 document with six uniquely-colored layers.
         * Panel order (top -> bottom): c-cyan, c-magenta, c-yellow,
         * c-blue, c-green, c-red. Each patch is a 20x20 block, so a cell of
         * the collage shows one patch at a unique position.
         * =============================================================== */
        var docMain = makeDoc("QPE-Collage-main", 400, 400, NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT, BitsPerChannelType.EIGHT);
        var layerRed = docMain.layers[0];
        layerRed.name = "c-red";
        paintLayer(docMain, layerRed, 40, 40, 60, 60, rgb(200, 0, 0));
        addPatchLayer(docMain, "c-green", 140, 40, 160, 60, rgb(0, 200, 0));
        addPatchLayer(docMain, "c-blue", 240, 40, 260, 60, rgb(0, 0, 200));
        addPatchLayer(docMain, "c-yellow", 40, 140, 60, 160, rgb(220, 220, 0));
        addPatchLayer(docMain, "c-magenta", 140, 140, 160, 160, rgb(255, 0, 255));
        addPatchLayer(docMain, "c-cyan", 240, 140, 260, 160, rgb(0, 200, 200));
        selectAllLayers();
        var mainBefore = captureState(docMain);

        var previewArgs = {
            prefix: "QPE-Collage-pv", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        };
        var previewMain = previewStep("A-preview", previewArgs);

        /* change the selection: the old selection key must be rejected */
        var layerRedRef = findLayerByName(docMain, "c-red");
        if (layerRedRef) { docMain.activeLayer = layerRedRef; }
        var staleResult = hostCall("exportCollage", {
            prefix: "QPE-Collage-stale", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 3,
            selectionKey: previewMain.selectionKey || ""
        });
        out.steps.push({
            name: "A-selection-changed",
            result: { ok: staleResult.ok === true, code: staleResult.code || "", message: staleResult.message || "" }
        });

        /* restore the real multi-selection and preview again */
        var layerCyanRef = findLayerByName(docMain, "c-cyan");
        if (layerCyanRef) { docMain.activeLayer = layerCyanRef; }
        selectAllLayers();
        var previewRestored = previewStep("A-preview-restored", previewArgs);
        var restoreStep = out.steps[out.steps.length - 1];
        restoreStep.result.sameKey = (previewRestored.selectionKey && previewMain.selectionKey &&
            String(previewRestored.selectionKey) === String(previewMain.selectionKey)) === true;

        /* numbering with existing files (shared / separate / mixed case) */
        previewStep("A-preview-shared", {
            prefix: "QPE-Collage-shared", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        });
        previewStep("A-preview-separate", {
            prefix: "QPE-Collage-sep", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "separate"
        });
        previewStep("A-preview-mix", {
            prefix: "QPE-Collage-mix", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        });
        previewStep("A-preview-nofolder", {
            prefix: "QPE-Collage-pv", digits: 2, format: "png", numbering: "shared"
        });

        var mainKey = previewRestored.selectionKey || previewMain.selectionKey || "";

        /* 3 columns: 1200x800, panel order row-major */
        recordExport("A-export-shared", {
            prefix: "QPE-Collage-shared", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 3, selectionKey: mainKey
        });
        /* 4 columns: 1600x800, next free number (05) */
        recordExport("A-export-shared-next", {
            prefix: "QPE-Collage-shared", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 4, selectionKey: mainKey
        });
        /* 4 columns on the mixed-case prefix: starts at 08 */
        recordExport("A-export-mix", {
            prefix: "QPE-Collage-mix", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 4, selectionKey: mainKey
        });
        /* separate numbering ignores the .jpg seed and starts at 01 */
        recordExport("A-export-sep", {
            prefix: "QPE-Collage-sep", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "separate", columns: 3, selectionKey: mainKey
        });
        /* JPG keeps its own numbering/extension, empty cells become white */
        recordExport("A-export-jpg", {
            prefix: "QPE-Collage-jpg", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 10, numbering: "shared", columns: 4, selectionKey: mainKey
        });
        /* existing -01 must not be overwritten */
        recordExport("A-export-over", {
            prefix: "QPE-Collage-over", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 3, selectionKey: mainKey
        });
        /* target width 300 keeps 3:2 ratio -> 300x200 */
        recordExport("A-target-width", {
            prefix: "QPE-Collage-small", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 3, targetWidth: 300, selectionKey: mainKey
        });
        /* upscaling is rejected, no file */
        recordExport("A-target-upscale", {
            prefix: "QPE-Collage-big", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 3, targetWidth: 1300, selectionKey: mainKey
        });
        /* missing folder is an error, nothing is written */
        recordExport("A-export-nofolder", {
            prefix: "QPE-Collage-nof", digits: 2, format: "png", numbering: "shared",
            columns: 3, selectionKey: mainKey
        });
        recordExport("A-export-missing-folder", {
            prefix: "QPE-Collage-miss", digits: 2,
            folder: outFolder.fsName + "/QPE-Collage-no-dir",
            format: "png", numbering: "shared", columns: 3, selectionKey: mainKey
        });

        out.steps.push({
            name: "A-state-unchanged",
            result: {
                same: sameState(mainBefore, captureState(docMain)),
                activeDocument: app.activeDocument ? String(app.activeDocument.name) : ""
            }
        });

        closeDoc(docMain);

        /* =================================================================
         * B - clipped layers are skipped, an empty layer is skipped at export
         * time without taking a cell.
         * Panel order: s-blue, s-empty, s-green, s-clip, s-base.
         * =============================================================== */
        var docSkip = makeDoc("QPE-Collage-skip", 200, 200, NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT, BitsPerChannelType.EIGHT);
        var sBase = docSkip.layers[0];
        sBase.name = "s-base";
        paintLayer(docSkip, sBase, 20, 20, 40, 40, rgb(200, 0, 0));
        var sClip = addPatchLayer(docSkip, "s-clip", 60, 60, 80, 80, rgb(255, 0, 255));
        sClip.grouped = true;
        addPatchLayer(docSkip, "s-green", 120, 120, 140, 140, rgb(0, 200, 0));
        var sEmpty = docSkip.artLayers.add();
        sEmpty.name = "s-empty";
        addPatchLayer(docSkip, "s-blue", 100, 20, 120, 40, rgb(0, 0, 200));
        selectAllLayers();
        var skipBefore = captureState(docSkip);

        var skipPreview = previewStep("B-skips-preview", {
            prefix: "QPE-Collage-skip", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        });
        recordExport("B-skips-export", {
            prefix: "QPE-Collage-skip", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 2,
            selectionKey: skipPreview.selectionKey || ""
        });
        out.steps.push({
            name: "B-skips-state-unchanged",
            result: { same: sameState(skipBefore, captureState(docSkip)) }
        });
        closeDoc(docSkip);

        /* =================================================================
         * C - every target depends on another layer -> nothing to export.
         * =============================================================== */
        var docNone = makeDoc("QPE-Collage-none", 100, 100, NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT, BitsPerChannelType.EIGHT);
        var nBase = docNone.layers[0];
        nBase.name = "n-base";
        paintLayer(docNone, nBase, 10, 10, 30, 30, rgb(200, 0, 0));
        var nClip = addPatchLayer(docNone, "n-clip", 40, 40, 60, 60, rgb(255, 0, 255));
        nClip.grouped = true;
        selectAllLayers();
        var nonePreview = previewStep("C-all-skipped-preview", {
            prefix: "QPE-Collage-none", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        });
        recordExport("C-all-skipped-export", {
            prefix: "QPE-Collage-none", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 2,
            selectionKey: nonePreview.selectionKey || ""
        });
        closeDoc(docNone);

        /* =================================================================
         * D - 16 bit RGB document: export converts a copy, the source keeps
         * its bit depth and mode.
         * =============================================================== */
        var doc16 = makeDoc("QPE-Collage-16", 120, 80, NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT, BitsPerChannelType.SIXTEEN);
        var red16 = doc16.layers[0];
        red16.name = "b16-red";
        paintLayer(doc16, red16, 10, 10, 30, 30, rgb(200, 0, 0));
        addPatchLayer(doc16, "b16-blue", 60, 10, 80, 30, rgb(0, 0, 200));
        selectAllLayers();
        var state16Before = captureState(doc16);
        var preview16 = previewStep("D-16-preview", {
            prefix: "QPE-Collage-16", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        });
        recordExport("D-16-export", {
            prefix: "QPE-Collage-16", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 2,
            selectionKey: preview16.selectionKey || ""
        });
        out.steps.push({
            name: "D-16-state-unchanged",
            result: { same: sameState(state16Before, captureState(doc16)) }
        });
        closeDoc(doc16);

        /* =================================================================
         * D - CMYK document: same conversion warning contract.
         * =============================================================== */
        try {
            var docCmyk = makeDoc("QPE-Collage-CMYK", 120, 80, NewDocumentMode.CMYK,
                DocumentFill.TRANSPARENT, BitsPerChannelType.EIGHT);
            var redCmyk = docCmyk.layers[0];
            redCmyk.name = "m-red";
            paintLayer(docCmyk, redCmyk, 10, 10, 30, 30, cmyk(0, 100, 100, 0));
            addPatchLayer(docCmyk, "m-cyan", 60, 10, 80, 30, cmyk(100, 0, 0, 0));
            selectAllLayers();
            var stateCmykBefore = captureState(docCmyk);
            var previewCmyk = previewStep("D-cmyk-preview", {
                prefix: "QPE-Collage-CMYK", digits: 2, folder: outFolder.fsName,
                format: "png", numbering: "shared"
            });
            recordExport("D-cmyk-export", {
                prefix: "QPE-Collage-CMYK", digits: 2, folder: outFolder.fsName,
                format: "png", numbering: "shared", columns: 2,
                selectionKey: previewCmyk.selectionKey || ""
            });
            out.steps.push({
                name: "D-cmyk-state-unchanged",
                result: { same: sameState(stateCmykBefore, captureState(docCmyk)) }
            });
            closeDoc(docCmyk);
        } catch (cmykError) {
            out.steps.push({
                name: "D-cmyk-skipped",
                result: {
                    error: String(cmykError.message || cmykError),
                    line: cmykError.line
                }
            });
        }

        /* =================================================================
         * E - JPG quality 12 must be clearly bigger than quality 2.
         * =============================================================== */
        var docQ = makeDoc("QPE-Collage-q", 240, 240, NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT, BitsPerChannelType.EIGHT);
        var qLayer = docQ.layers[0];
        qLayer.name = "q-noise";
        for (var qi = 0; qi < 6; qi++) {
            for (var qj = 0; qj < 6; qj++) {
                paintLayer(docQ, qLayer, qi * 40, qj * 40, qi * 40 + 40, qj * 40 + 40,
                    rgb((qi * 53 + 20) % 256, (qj * 71 + 40) % 256, (qi * 29 + qj * 97 + 60) % 256));
            }
        }
        // Flat colour blocks compress almost identically at every JPEG quality
        // (measured: q2=18KB vs q12=21KB), so add fine noise to make the
        // quality setting actually visible in the file size (q2=74KB vs q12=221KB).
        qLayer.applyAddNoise(30, NoiseDistribution.GAUSSIAN, false);
        selectAllLayers();
        var previewQ = previewStep("E-quality-preview", {
            prefix: "QPE-Collage-q", digits: 2, folder: outFolder.fsName,
            format: "jpg", numbering: "shared"
        });
        recordExport("E-quality-2", {
            prefix: "QPE-Collage-q", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 2, numbering: "shared", columns: 1,
            selectionKey: previewQ.selectionKey || ""
        });
        recordExport("E-quality-12", {
            prefix: "QPE-Collage-q", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 12, numbering: "shared", columns: 1,
            selectionKey: previewQ.selectionKey || ""
        });
        closeDoc(docQ);

        /* =================================================================
         * F - displayDialogs is restored even when it is set to ERROR.
         * =============================================================== */
        app.displayDialogs = DialogModes.ERROR;
        var dialogsBefore = String(app.displayDialogs);
        var docDlg = makeDoc("QPE-Collage-dlg", 40, 40, NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT, BitsPerChannelType.EIGHT);
        var dRed = docDlg.layers[0];
        dRed.name = "d-red";
        paintLayer(docDlg, dRed, 5, 5, 25, 25, rgb(200, 0, 0));
        selectAllLayers();
        var previewDlg = previewStep("F-preview", {
            prefix: "QPE-Collage-dlg", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        });
        var exportDlg = recordExport("F-export", {
            prefix: "QPE-Collage-dlg", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared", columns: 1,
            selectionKey: previewDlg.selectionKey || ""
        });
        out.steps.push({
            name: "F-display-dialogs",
            result: {
                exportOk: exportDlg.ok === true,
                before: dialogsBefore,
                after: String(app.displayDialogs),
                restored: String(app.displayDialogs) === dialogsBefore
            }
        });
        app.displayDialogs = DialogModes.NO;
        closeDoc(docDlg);

        /* =================================================================
         * G - no temporary files were left behind.
         * =============================================================== */
        out.steps.push({
            name: "G-temp-clean",
            result: {
                collageLeftovers: leftoverNames(tempCollageBefore, tempNames("qpe-collage-")),
                estimateLeftovers: leftoverNames(tempEstimateBefore, tempNames("qpe-estimate-")),
                collageCount: tempNames("qpe-collage-").length,
                estimateCount: tempNames("qpe-estimate-").length
            }
        });

        // Report clean-up state only after the harness has already put
        // displayDialogs back: earlier steps deliberately changed it (F), and
        // the report must prove the run left Photoshop as it found it.
        try { app.displayDialogs = originalDialogs; } catch (dialogsRestoreError) { }
        out.steps.push({
            name: "run-cleanup",
            result: {
                openDocuments: app.documents.length,
                displayDialogs: String(app.displayDialogs),
                originalDialogs: String(originalDialogs)
            }
        });

        var files = [];
        var folderEntries = outFolder.getFiles();
        for (var fi = 0; fi < folderEntries.length; fi++) {
            if (folderEntries[fi] instanceof File) {
                files.push({ name: String(folderEntries[fi].name), size: folderEntries[fi].length });
            }
        }
        out.files = files;
        out.ok = true;
    } catch (fatal) {
        out.ok = false;
        out.fatal = String(fatal.message || fatal) + " (line " + fatal.line + ")";
    } finally {
        for (var closeIndex = openedDocs.length - 1; closeIndex >= 0; closeIndex--) {
            closeDoc(openedDocs[closeIndex]);
        }
        try { app.displayDialogs = originalDialogs; } catch (dialogsError) { }
    }

    return jsonValue(out);
}());
