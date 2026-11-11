(function () {
    var out = { steps: [], ok: false, skipped: false };
    var originalDialogs = app.displayDialogs;
    var openedDocs = [];

    function esc(s) {
        s = String(s);
        var r = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c === 34) { r += '\\"'; }
            else if (c === 92) { r += '\\\\'; }
            else if (c < 32) { r += " "; }
            else { r += s.charAt(i); }
        }
        return r;
    }
    function jsonValue(v) {
        if (v === null || v === undefined) { return "null"; }
        if (typeof v === "number") { return isFinite(v) ? String(v) : "null"; }
        if (typeof v === "boolean") { return v ? "true" : "false"; }
        if (Object.prototype.toString.call(v) === "[object Array]") {
            var parts = [];
            for (var i = 0; i < v.length; i++) { parts.push(jsonValue(v[i])); }
            return "[" + parts.join(",") + "]";
        }
        if (typeof v === "object") {
            var pairs = [];
            for (var k in v) {
                if (v.hasOwnProperty(k)) { pairs.push('"' + esc(k) + '":' + jsonValue(v[k])); }
            }
            return "{" + pairs.join(",") + "}";
        }
        return '"' + esc(v) + '"';
    }
    function rgb(r, g, b) {
        var c = new SolidColor();
        c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b;
        return c;
    }
    function hostCall(method, args) {
        var raw;
        try {
            raw = QPE_call(method, QPECore.toJson(args));
        } catch (callError) {
            return { ok: false, code: "CALL_THREW", message: callError.message };
        }
        try {
            return eval("(" + raw + ")");
        } catch (parseError) {
            return { ok: false, code: "PARSE_FAILED", raw: String(raw).substring(0, 400) };
        }
    }

    function captureState(doc) {
        var state = { layers: [], active: "", saved: false, mode: "", bits: "" };
        function walk(container, path) {
            var layers = container.layers;
            for (var i = 0; i < layers.length; i++) {
                var layer = layers[i];
                var visible;
                try { visible = layer.visible ? "1" : "0"; } catch (e) { visible = "?"; }
                state.layers[state.layers.length] = path + "." + i + "|" + layer.name + "|" + layer.typename + "|" + visible;
                if (layer.typename === "LayerSet") { walk(layer, path + "." + i); }
            }
        }
        walk(doc, "root");
        try { state.active = String(doc.activeLayer.id); } catch (e2) { state.active = "?"; }
        state.saved = doc.saved;
        state.mode = String(doc.mode);
        state.bits = String(doc.bitsPerChannel);
        return state;
    }
    function sameState(a, b) {
        return jsonValue(a) === jsonValue(b);
    }

    function fillRect(doc, name, x1, y1, x2, y2, color) {
        var layer = doc.artLayers.add();
        layer.name = name;
        doc.activeLayer = layer;
        doc.selection.select([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
        doc.selection.fill(color);
        doc.selection.deselect();
        return layer;
    }
    function findLayerByName(doc, name) {
        function search(container) {
            var layers = container.layers;
            for (var i = 0; i < layers.length; i++) {
                if (layers[i].name === name) { return layers[i]; }
                if (layers[i].typename === "LayerSet") {
                    var found = search(layers[i]);
                    if (found) { return found; }
                }
            }
            return null;
        }
        return search(doc);
    }

    function fileLength(path) {
        var file = new File(String(path));
        return file.exists ? file.length : -1;
    }
    function countEstimateTempFiles() {
        var files = Folder.temp.getFiles();
        var names = [];
        for (var i = 0; i < files.length; i++) {
            var name = String(files[i].name);
            if (name.indexOf("qpe-estimate-") === 0) { names[names.length] = name; }
        }
        return { count: names.length, names: names };
    }
    function seedFile(folder, name, text) {
        var file = new File(folder.fsName + "/" + name);
        file.open("w");
        file.write(text);
        file.close();
    }
    function clearFolder(folder) {
        if (folder.exists) {
            var existing = folder.getFiles();
            for (var f = 0; f < existing.length; f++) {
                try {
                    if (existing[f] instanceof Folder) { existing[f].remove(); }
                    else { existing[f].remove(); }
                } catch (e1) {}
            }
        } else {
            folder.create();
        }
    }

    function makeDocA() {
        var doc = app.documents.add(new UnitValue(200, "px"), new UnitValue(160, "px"), 72,
            "QPE-JPG-A", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
            BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
        openedDocs.push(doc);
        fillRect(doc, "red", 10, 10, 60, 60, rgb(200, 0, 0));
        // A textured region makes low quality clearly smaller than high quality.
        for (var i = 0; i < 6; i++) {
            for (var j = 0; j < 5; j++) {
                var x = 75 + i * 18;
                var y = 10 + j * 28;
                fillRect(doc, "noise-" + i + "-" + j, x, y, x + 14, y + 24,
                    rgb((i * 53 + 20) % 256, (j * 71 + 40) % 256, (i * 29 + j * 97 + 60) % 256));
            }
        }
        return doc;
    }

    function makeDocS() {
        var doc = app.documents.add(new UnitValue(120, "px"), new UnitValue(120, "px"), 72,
            "QPE-JPG-S", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
            BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
        openedDocs.push(doc);
        fillRect(doc, "s-red", 10, 10, 30, 30, rgb(200, 0, 0));
        fillRect(doc, "s-green", 40, 40, 60, 60, rgb(0, 200, 0));
        var clip = fillRect(doc, "s-clip", 5, 35, 25, 55, rgb(255, 0, 255));
        clip.grouped = true;
        var hidden = fillRect(doc, "s-hidden-blue", 70, 70, 90, 90, rgb(0, 0, 200));
        hidden.visible = false;
        var empty = doc.artLayers.add();
        empty.name = "s-empty-layer";
        var group = doc.layerSets.add();
        group.name = "S-G";
        var yellow = group.artLayers.add();
        yellow.name = "s-yellow";
        doc.activeLayer = yellow;
        doc.selection.select([[90, 10], [110, 10], [110, 30], [90, 30]]);
        doc.selection.fill(rgb(220, 220, 0));
        doc.selection.deselect();
        var emptyGroup = doc.layerSets.add();
        emptyGroup.name = "S-EG";
        app.runMenuItem(stringIDToTypeID("selectAllLayers"));
        return doc;
    }

    try {
        app.displayDialogs = DialogModes.NO;
        if (app.documents.length > 0) {
            out.skipped = true;
            out.reason = "Photoshop has " + app.documents.length + " user document(s) open, skipping acceptance";
            return jsonValue(out);
        }

        var baseDir = "__QPE_BASE_DIR__";
        var outFolder = new Folder(baseDir + "export");
        var savedFolder = new Folder(baseDir + "saved");
        clearFolder(outFolder);
        clearFolder(savedFolder);
        var tempBefore = countEstimateTempFiles();

        seedFile(outFolder, "QPE-JPG-shared-03.png", "seed");
        seedFile(outFolder, "QPE-JPG-sep-03.png", "seed");
        seedFile(outFolder, "QPE-JPG-case-02.JPG", "seed");
        seedFile(outFolder, "QPE-JPG-case-04.jpeg", "seed");
        seedFile(outFolder, "QPE-JPG-over-01.jpg", "seed-over");
        var decoyFolder = new Folder(outFolder.fsName + "/QPE-JPG-shared-09.jpg");
        decoyFolder.create();

        /* ---------- A: document JPG export ---------- */
        var docA = makeDocA();
        var beforeA = captureState(docA);
        out.steps.push({ name: "A-status", result: hostCall("status", {}) });
        out.steps.push({
            name: "A-preview-shared",
            result: hostCall("preview", {
                prefix: "QPE-JPG-shared", digits: 2, folder: outFolder.fsName,
                format: "jpg", numbering: "shared"
            })
        });
        out.steps.push({
            name: "A-preview-separate",
            result: hostCall("preview", {
                prefix: "QPE-JPG-sep", digits: 2, folder: outFolder.fsName,
                format: "jpg", numbering: "separate"
            })
        });
        out.steps.push({
            name: "A-preview-case",
            result: hostCall("preview", {
                prefix: "QPE-JPG-case", digits: 2, folder: outFolder.fsName,
                format: "jpg", numbering: "shared"
            })
        });

        var estimateJpg = hostCall("estimateSize", { format: "jpg", quality: 10 });
        var exportJpg = hostCall("exportImage", {
            prefix: "QPE-JPG-shared", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 10, numbering: "shared"
        });
        out.steps.push({ name: "A-estimate-jpg", result: estimateJpg });
        out.steps.push({ name: "A-export-shared", result: exportJpg });
        out.steps.push({
            name: "A-estimate-match-jpg",
            result: { estimate: estimateJpg.bytes, actual: fileLength(exportJpg.fullPath) }
        });

        var estimatePng = hostCall("estimateSize", { format: "png" });
        var exportPng = hostCall("exportImage", {
            prefix: "QPE-JPG-pngest", digits: 2, folder: outFolder.fsName,
            format: "png", numbering: "shared"
        });
        out.steps.push({ name: "A-estimate-png", result: estimatePng });
        out.steps.push({ name: "A-export-pngest", result: exportPng });
        out.steps.push({
            name: "A-estimate-match-png",
            result: { estimate: estimatePng.bytes, actual: fileLength(exportPng.fullPath) }
        });

        var q2 = hostCall("exportImage", {
            prefix: "QPE-JPG-q", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 2, numbering: "shared"
        });
        var q12 = hostCall("exportImage", {
            prefix: "QPE-JPG-q", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 12, numbering: "shared"
        });
        out.steps.push({
            name: "A-quality-2",
            result: { ok: q2.ok, fileName: q2.fileName, size: fileLength(q2.fullPath) }
        });
        out.steps.push({
            name: "A-quality-12",
            result: { ok: q12.ok, fileName: q12.fileName, size: fileLength(q12.fullPath) }
        });

        var over = hostCall("exportImage", {
            prefix: "QPE-JPG-over", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 10, numbering: "shared"
        });
        out.steps.push({
            name: "A-overwrite",
            result: { ok: over.ok, fileName: over.fileName, size: fileLength(over.fullPath) }
        });

        var caseExport = hostCall("exportImage", {
            prefix: "QPE-JPG-case", digits: 2, folder: outFolder.fsName,
            format: "jpg", quality: 10, numbering: "shared"
        });
        out.steps.push({
            name: "A-case",
            result: { ok: caseExport.ok, fileName: caseExport.fileName, size: fileLength(caseExport.fullPath) }
        });

        var afterA = captureState(docA);
        out.steps.push({ name: "A-state-unchanged", result: sameState(beforeA, afterA) });
        out.steps.push({
            name: "A-bad-quality",
            result: hostCall("exportImage", {
                prefix: "QPE-JPG-bad", digits: 2, folder: outFolder.fsName,
                format: "jpg", quality: 13, numbering: "shared"
            })
        });
        docA.close(SaveOptions.DONOTSAVECHANGES);

        /* ---------- B: 16-bit and CMYK sources ---------- */
        var doc16;
        try {
            doc16 = app.documents.add(new UnitValue(80, "px"), new UnitValue(60, "px"), 72,
                "QPE-JPG-16", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
                BitsPerChannelType.SIXTEEN, "sRGB IEC61966-2.1");
            openedDocs.push(doc16);
            fillRect(doc16, "b16-red", 10, 10, 40, 40, rgb(200, 0, 0));
            var export16 = hostCall("exportImage", {
                prefix: "QPE-JPG-16", digits: 2, folder: outFolder.fsName,
                format: "jpg", quality: 10, numbering: "shared"
            });
            out.steps.push({
                name: "B-16-export",
                result: {
                    ok: export16.ok,
                    converted: export16.converted,
                    warningCount: export16.warnings ? export16.warnings.length : 0,
                    bitsKept: doc16.bitsPerChannel === BitsPerChannelType.SIXTEEN,
                    modeKept: doc16.mode === DocumentMode.RGB,
                    fileName: export16.fileName,
                    size: fileLength(export16.fullPath)
                }
            });
            doc16.close(SaveOptions.DONOTSAVECHANGES);
        } catch (b16Error) {
            out.steps.push({ name: "B-16-skipped", message: b16Error.message });
            try { if (doc16) { doc16.close(SaveOptions.DONOTSAVECHANGES); } } catch (e3) {}
        }

        var docCmyk;
        try {
            docCmyk = app.documents.add(new UnitValue(80, "px"), new UnitValue(60, "px"), 72,
                "QPE-JPG-CMYK", NewDocumentMode.CMYK, DocumentFill.WHITE, 1.0,
                BitsPerChannelType.EIGHT);
            openedDocs.push(docCmyk);
            var exportCmyk = hostCall("exportImage", {
                prefix: "QPE-JPG-CMYK", digits: 2, folder: outFolder.fsName,
                format: "jpg", quality: 10, numbering: "shared"
            });
            out.steps.push({
                name: "B-cmyk-export",
                result: {
                    ok: exportCmyk.ok,
                    converted: exportCmyk.converted,
                    warningCount: exportCmyk.warnings ? exportCmyk.warnings.length : 0,
                    modeKept: docCmyk.mode === DocumentMode.CMYK,
                    fileName: exportCmyk.fileName,
                    size: fileLength(exportCmyk.fullPath)
                }
            });
            docCmyk.close(SaveOptions.DONOTSAVECHANGES);
        } catch (cmykError) {
            out.steps.push({ name: "B-cmyk-skipped", message: cmykError.message });
            try { if (docCmyk) { docCmyk.close(SaveOptions.DONOTSAVECHANGES); } } catch (e4) {}
        }

        /* ---------- C: selection JPG export ---------- */
        var docS;
        try {
            docS = makeDocS();
            var beforeS = captureState(docS);
            var previewS = hostCall("previewSelectedLayers", {
                prefix: "QPE-JPG-S", digits: 2, folder: outFolder.fsName,
                format: "jpg", quality: 10, numbering: "shared"
            });
            out.steps.push({
                name: "C-preview",
                result: {
                    ok: previewS.ok,
                    itemCount: previewS.items ? previewS.items.length : -1,
                    skippedCount: previewS.skipped ? previewS.skipped.length : -1,
                    selectionKey: previewS.selectionKey || ""
                }
            });
            var exportS = hostCall("exportSelectedLayers", {
                prefix: "QPE-JPG-S", digits: 2, folder: outFolder.fsName,
                format: "jpg", quality: 10, numbering: "shared",
                selectionKey: previewS.selectionKey
            });
            var sNumbers = [];
            var sFiles = [];
            if (exportS.successes) {
                for (var s = 0; s < exportS.successes.length; s++) {
                    sNumbers[sNumbers.length] = exportS.successes[s].number;
                    sFiles[sFiles.length] = exportS.successes[s].fileName;
                }
            }
            var sSkipCodes = [];
            if (exportS.skipped) {
                for (var t = 0; t < exportS.skipped.length; t++) {
                    sSkipCodes[sSkipCodes.length] = exportS.skipped[t].code;
                }
            }
            out.steps.push({
                name: "C-export",
                result: {
                    ok: exportS.ok,
                    successCount: exportS.successes ? exportS.successes.length : -1,
                    numbers: sNumbers,
                    files: sFiles,
                    skipCount: exportS.skipped ? exportS.skipped.length : -1,
                    skipCodes: sSkipCodes,
                    changed: sameState(beforeS, captureState(docS)) ? false : true,
                    fileNameAfter: docS.name
                }
            });
            docS.close(SaveOptions.DONOTSAVECHANGES);
        } catch (sError) {
            out.steps.push({ name: "C-skipped", message: sError.message });
            try { if (docS) { docS.close(SaveOptions.DONOTSAVECHANGES); } } catch (e5) {}
        }

        /* ---------- D: saved document folder ---------- */
        var docSaved;
        try {
            docSaved = app.documents.add(new UnitValue(100, "px"), new UnitValue(80, "px"), 72,
                "QPE-JPG-saved", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
                BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
            openedDocs.push(docSaved);
            fillRect(docSaved, "d-red", 10, 10, 40, 40, rgb(200, 0, 0));
            docSaved.saveAs(new File(savedFolder.fsName + "/QPE-JPG-saved.psd"));
            var savedStatus = hostCall("status", {});
            out.steps.push({
                name: "D-status",
                result: {
                    hasDocument: savedStatus.hasDocument,
                    saved: savedStatus.saved,
                    path: savedStatus.path
                }
            });
            var exportSaved = hostCall("exportImage", {
                prefix: "QPE-JPG-saved", digits: 2, folder: savedStatus.path,
                format: "jpg", quality: 8, numbering: "shared"
            });
            out.steps.push({
                name: "D-export",
                result: {
                    ok: exportSaved.ok,
                    fileName: exportSaved.fileName,
                    size: fileLength(exportSaved.fullPath)
                }
            });
            docSaved.close(SaveOptions.DONOTSAVECHANGES);
        } catch (savedError) {
            out.steps.push({ name: "D-skipped", message: savedError.message });
            try { if (docSaved) { docSaved.close(SaveOptions.DONOTSAVECHANGES); } } catch (e6) {}
        }

        /* ---------- E: displayDialogs restore ---------- */
        var docF;
        app.displayDialogs = DialogModes.ERROR;
        var dialogsBefore = String(app.displayDialogs);
        try {
            docF = app.documents.add(new UnitValue(40, "px"), new UnitValue(40, "px"), 72,
                "QPE-JPG-F", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
                BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
            openedDocs.push(docF);
            fillRect(docF, "f-red", 5, 5, 20, 20, rgb(200, 0, 0));
            var exportF = hostCall("exportImage", {
                prefix: "QPE-JPG-F", digits: 2, folder: outFolder.fsName,
                format: "jpg", quality: 10, numbering: "shared"
            });
            var estimateF = hostCall("estimateSize", { format: "png" });
            out.steps.push({
                name: "E-display-dialogs",
                result: {
                    exportOk: exportF.ok === true,
                    estimateOk: estimateF.ok === true,
                    before: dialogsBefore,
                    after: String(app.displayDialogs),
                    restored: String(app.displayDialogs) === dialogsBefore
                }
            });
            docF.close(SaveOptions.DONOTSAVECHANGES);
        } catch (fError) {
            out.steps.push({ name: "E-skipped", message: fError.message });
            try { if (docF) { docF.close(SaveOptions.DONOTSAVECHANGES); } } catch (e7) {}
        }

        var tempAfter = countEstimateTempFiles();
        out.steps.push({
            name: "F-temp-clean",
            result: { before: tempBefore.count, after: tempAfter.count, leftovers: tempAfter.names }
        });

        out.steps.push({
            name: "run-cleanup",
            result: {
                openDocuments: app.documents.length,
                displayDialogs: String(app.displayDialogs)
            }
        });

        out.files = [];
        var files = outFolder.getFiles();
        for (var fi = 0; fi < files.length; fi++) {
            if (files[fi] instanceof File) {
                out.files[out.files.length] = { name: files[fi].name, size: files[fi].length };
            }
        }
        out.savedFiles = [];
        var savedFiles = savedFolder.getFiles();
        for (var si = 0; si < savedFiles.length; si++) {
            if (savedFiles[si] instanceof File) {
                out.savedFiles[out.savedFiles.length] = { name: savedFiles[si].name, size: savedFiles[si].length };
            }
        }
        out.ok = true;
    } catch (fatal) {
        out.ok = false;
        out.fatal = fatal.message + " (line " + fatal.line + ")";
    } finally {
        for (var d = openedDocs.length - 1; d >= 0; d--) {
            try { openedDocs[d].close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) {}
        }
        try { app.displayDialogs = originalDialogs; } catch (dialogError) {}
    }
    return jsonValue(out);
}());
