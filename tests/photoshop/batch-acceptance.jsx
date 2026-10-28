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

    function selectedIds() {
        var ids = [];
        try {
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var desc = executeActionGet(ref);
            if (!desc.hasKey(stringIDToTypeID("targetLayersIDs"))) { return ids; }
            var list = desc.getList(stringIDToTypeID("targetLayersIDs"));
            for (var i = 0; i < list.count; i++) {
                try { ids[ids.length] = list.getReference(i).getIdentifier(); } catch (e) { ids[ids.length] = -1; }
            }
        } catch (e2) { ids[ids.length] = -1; }
        return ids;
    }

    function captureState(doc) {
        var state = { layers: [], active: "", saved: false, selection: [], count: 0 };
        function walk(container, path) {
            var layers = container.layers;
            for (var i = 0; i < layers.length; i++) {
                var layer = layers[i];
                var visible;
                try { visible = layer.visible ? "1" : "0"; } catch (e) { visible = "?"; }
                state.layers[state.layers.length] = path + "." + i + "|" + layer.name + "|" + visible;
                if (layer.typename === "LayerSet") { walk(layer, path + "." + i); }
            }
        }
        walk(doc, "root");
        state.count = doc.layers.length;
        try { state.active = String(doc.activeLayer.id); } catch (e2) { state.active = "?"; }
        state.saved = doc.saved;
        state.selection = selectedIds();
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

    function makeDocA(folderPath) {
        var doc = app.documents.add(new UnitValue(120, "px"), new UnitValue(120, "px"), 72,
            "QPE-Batch-A", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
            BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
        openedDocs.push(doc);
        var red = fillRect(doc, "red", 10, 10, 30, 30, rgb(200, 0, 0));
        var green = fillRect(doc, "green", 40, 40, 60, 60, rgb(0, 200, 0));
        var clip = fillRect(doc, "clip-shadow", 5, 35, 25, 55, rgb(255, 0, 255));
        try { clip.grouped = true; } catch (e) { out.steps.push({ name: "clip-grouped-failed", message: e.message }); }
        var blue = fillRect(doc, "hidden-blue", 70, 70, 90, 90, rgb(0, 0, 200));
        blue.visible = false;

        var group = doc.layerSets.add();
        group.name = "G";
        var yellow = group.artLayers.add();
        yellow.name = "g-yellow";
        doc.activeLayer = yellow;
        doc.selection.select([[90, 10], [110, 10], [110, 30], [90, 30]]);
        doc.selection.fill(rgb(220, 220, 0));
        doc.selection.deselect();
        // Clipped child inside the group: must stay clipped to g-yellow when the
        // whole group is exported on its own.
        var clipChild = group.artLayers.add();
        clipChild.name = "g-clip";
        doc.activeLayer = clipChild;
        doc.selection.select([[95, 15], [115, 15], [115, 35], [95, 35]]);
        doc.selection.fill(rgb(0, 200, 200));
        doc.selection.deselect();
        try { clipChild.grouped = true; } catch (e) { out.steps.push({ name: "clip-child-failed", message: e.message }); }
        // Hidden child inside the group: must stay hidden when the group is
        // exported.
        var hiddenChild = group.artLayers.add();
        hiddenChild.name = "g-hidden";
        doc.activeLayer = hiddenChild;
        doc.selection.select([[95, 60], [115, 60], [115, 80], [95, 80]]);
        doc.selection.fill(rgb(255, 120, 0));
        doc.selection.deselect();
        hiddenChild.visible = false;

        var emptyChild = group.artLayers.add();
        emptyChild.name = "g-empty";

        var empty = doc.artLayers.add();
        empty.name = "empty-layer";

        var multiply = fillRect(doc, "multiply", 15, 45, 35, 65, rgb(180, 0, 180));
        multiply.blendMode = BlendMode.MULTIPLY;

        app.runMenuItem(stringIDToTypeID("selectAllLayers"));
        return doc;
    }

    // Scenario B: a normal layer that acts as the base of clipped content above
    // it. Exporting the base alone silently drops the clipped content, so the
    // host must report it as a skipped dependency instead.
    function makeDocB() {
        var doc = app.documents.add(new UnitValue(60, "px"), new UnitValue(60, "px"), 72,
            "QPE-Batch-B", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
            BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
        openedDocs.push(doc);
        var base = fillRect(doc, "base-red", 10, 10, 30, 30, rgb(200, 0, 0));
        var clipped = doc.artLayers.add();
        clipped.name = "clip-on-base";
        doc.selection.select([[15, 15], [25, 15], [25, 25], [15, 25]]);
        doc.selection.fill(rgb(0, 0, 200));
        doc.selection.deselect();
        clipped.grouped = true;
        var sibling = fillRect(doc, "plain-above", 40, 40, 55, 55, rgb(0, 200, 0));
        doc.activeLayer = base;
        sibling.visible = true;
        return doc;
    }

    function makeDocD() {
        var doc = app.documents.add(new UnitValue(60, "px"), new UnitValue(60, "px"), 72,
            "QPE-Batch-D", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
            BitsPerChannelType.SIXTEEN, "sRGB IEC61966-2.1");
        openedDocs.push(doc);
        fillRect(doc, "d-red", 10, 10, 30, 30, rgb(200, 0, 0));
        app.runMenuItem(stringIDToTypeID("selectAllLayers"));
        return doc;
    }

    try {
        app.displayDialogs = DialogModes.NO;
        if (app.documents.length > 0) {
            out.skipped = true;
            out.reason = "Photoshop 中还有 " + app.documents.length + " 个用户文档，为安全起见跳过验收";
            return jsonValue(out);
        }

        var baseDir = "__QPE_BASE_DIR__";
        var outFolder = new Folder(baseDir + "export");
        if (outFolder.exists) {
            var existing = outFolder.getFiles();
            for (var f = 0; f < existing.length; f++) {
                try { existing[f].remove(); } catch (e1) {}
            }
        } else {
            outFolder.create();
        }

        /* ---------- scenario A ---------- */
        var docA = makeDocA(outFolder.fsName);
        var beforeA = captureState(docA);
        var previewA = hostCall("previewSelectedLayers", {
            prefix: "QPE-A", digits: 2, folder: outFolder.fsName
        });
        out.steps.push({ name: "A-preview", result: previewA });

        // Stale-selection guard: change the selection, then send the old key.
        docA.activeLayer = findLayerByName(docA, "red");
        var stale = hostCall("exportSelectedLayers", {
            prefix: "QPE-A", digits: 2, folder: outFolder.fsName,
            selectionKey: previewA.selectionKey
        });
        out.steps.push({ name: "A-stale-selection", result: stale });

        app.runMenuItem(stringIDToTypeID("selectAllLayers"));
        var previewStarted = new Date().getTime();
        var previewA2 = hostCall("previewSelectedLayers", {
            prefix: "QPE-A", digits: 2, folder: outFolder.fsName
        });
        out.steps.push({ name: "A-preview-2-ms", result: new Date().getTime() - previewStarted });
        var exportStarted = new Date().getTime();
        var exportA1 = hostCall("exportSelectedLayers", {
            prefix: "QPE-A", digits: 2, folder: outFolder.fsName,
            selectionKey: previewA2.selectionKey
        });
        out.steps.push({ name: "A-export-1-ms", result: new Date().getTime() - exportStarted });
        out.steps.push({ name: "A-export-1", result: exportA1 });

        var exportA2 = hostCall("exportSelectedLayers", {
            prefix: "QPE-A", digits: 2, folder: outFolder.fsName,
            selectionKey: previewA2.selectionKey
        });
        out.steps.push({ name: "A-export-2", result: exportA2 });

        var afterA = captureState(docA);
        out.steps.push({ name: "A-state-unchanged", result: sameState(beforeA, afterA), before: beforeA, after: afterA });

        docA.close(SaveOptions.DONOTSAVECHANGES);

        /* ---------- scenario D: 16-bit RGB conversion ---------- */
        var docD;
        try {
            docD = makeDocD();
            var beforeD = captureState(docD);
            var previewD = hostCall("previewSelectedLayers", {
                prefix: "QPE-D", digits: 2, folder: outFolder.fsName
            });
            out.steps.push({ name: "D-preview", result: previewD });
            var exportD = hostCall("exportSelectedLayers", {
                prefix: "QPE-D", digits: 2, folder: outFolder.fsName,
                selectionKey: previewD.selectionKey
            });
            out.steps.push({ name: "D-export", result: exportD });
            var afterD = captureState(docD);
            out.steps.push({ name: "D-state-unchanged", result: sameState(beforeD, afterD) });
            docD.close(SaveOptions.DONOTSAVECHANGES);
        } catch (dError) {
            out.steps.push({ name: "D-skipped", message: dError.message });
            try { if (docD) { docD.close(SaveOptions.DONOTSAVECHANGES); } } catch (e3) {}
        }

        /* ---------- scenario C: empty selection ---------- */
        try {
            var noSelection = hostCall("previewSelectedLayers", {
                prefix: "QPE-C", digits: 2, folder: outFolder.fsName
            });
            out.steps.push({ name: "C-preview-no-doc", result: noSelection });
        } catch (cError) {
            out.steps.push({ name: "C-skipped", message: cError.message });
        }

        /* ---------- scenario B: external adjustment layer ---------- */
        var docB;
        try {
            docB = makeDocB();
            var previewB = hostCall("previewSelectedLayers", {
                prefix: "QPE-B", digits: 2, folder: outFolder.fsName
            });
            out.steps.push({ name: "B-preview", result: previewB });
            var exportB = hostCall("exportSelectedLayers", {
                prefix: "QPE-B", digits: 2, folder: outFolder.fsName,
                selectionKey: previewB.selectionKey
            });
            out.steps.push({ name: "B-export", result: exportB });
            docB.close(SaveOptions.DONOTSAVECHANGES);
        } catch (bError) {
            out.steps.push({ name: "B-skipped", message: bError.message });
            try { if (docB) { docB.close(SaveOptions.DONOTSAVECHANGES); } } catch (e2) {}
        }

        /* ---------- scenario F: host restores displayDialogs ---------- */
        var docF;
        app.displayDialogs = DialogModes.ERROR;
        var dialogsBeforeF = String(app.displayDialogs);
        try {
            docF = app.documents.add(new UnitValue(40, "px"), new UnitValue(40, "px"), 72,
                "QPE-Batch-F", NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0,
                BitsPerChannelType.EIGHT, "sRGB IEC61966-2.1");
            openedDocs.push(docF);
            fillRect(docF, "f-red", 5, 5, 20, 20, rgb(200, 0, 0));
            app.runMenuItem(stringIDToTypeID("selectAllLayers"));
            var previewF = hostCall("previewSelectedLayers", {
                prefix: "QPE-F", digits: 2, folder: outFolder.fsName
            });
            var exportF = hostCall("exportSelectedLayers", {
                prefix: "QPE-F", digits: 2, folder: outFolder.fsName,
                selectionKey: previewF.selectionKey
            });
            out.steps.push({
                name: "F-display-dialogs",
                result: {
                    exported: exportF.ok === true && exportF.successes.length === 1,
                    dialogsBefore: dialogsBeforeF,
                    dialogsAfter: String(app.displayDialogs),
                    restored: String(app.displayDialogs) === dialogsBeforeF
                }
            });
            docF.close(SaveOptions.DONOTSAVECHANGES);
        } catch (fError) {
            out.steps.push({ name: "F-skipped", message: fError.message });
            try { if (docF) { docF.close(SaveOptions.DONOTSAVECHANGES); } } catch (e4) {}
        }

        out.steps.push({
            name: "run-cleanup",
            result: {
                openDocuments: app.documents.length,
                displayDialogs: String(app.displayDialogs),
                originalDialogs: String(originalDialogs)
            }
        });

        out.files = [];
        var files = outFolder.getFiles("*.png");
        for (var i = 0; i < files.length; i++) {
            out.files[out.files.length] = { name: files[i].name, size: files[i].length };
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
