/*
 * Photoshop Quick PNG Export - Photoshop host script (ExtendScript).
 *
 * This file is concatenated after jsx/core.jsx by scripts/build-host.mjs into
 * the shipped jsx/host.jsx that CEP loads as the panel's ScriptPath. Keeping
 * the two halves separate lets the Node test-suite exercise the pure logic
 * without a Photoshop install.
 *
 * Entry point used by the panel:
 *   QPE_call(method, argsJson) -> JSON string
 * Methods: status / preview / exportImage / estimateSize / exportPng (legacy
 *          PNG-only alias) / previewSelectedLayers / exportSelectedLayers /
 *          previewCollage / exportCollage / pickFolder / openFolder
 */

var QPE = (function () {
    var PROBE_NAME = ".qpe-write-test.tmp";
    var MAX_COLLISION_ATTEMPTS = 100;

    /* ---------- small helpers ---------- */

    function fail(code, message, extra) {
        var result = {
            ok: false,
            code: code,
            message: message
        };
        if (extra) {
            for (var key in extra) {
                if (extra.hasOwnProperty(key)) {
                    result[key] = extra[key];
                }
            }
        }
        return result;
    }

    function errorText(error) {
        if (!error) {
            return "未知错误";
        }
        var text = error.message ? String(error.message) : String(error);
        if (error.line) {
            text += "（行 " + error.line + "）";
        }
        return text;
    }

    function joinPath(base, name) {
        if (base.length === 0) {
            return name;
        }
        var last = base.charAt(base.length - 1);
        if (last === "/" || last === "\\") {
            return base + name;
        }
        return base + "/" + name;
    }

    function folderFromPath(pathText) {
        if (!pathText) {
            return null;
        }
        var folder = new Folder(String(pathText));
        if (!folder.exists) {
            return null;
        }
        return folder;
    }

    // ExtendScript percent-encodes non-ASCII characters of File.name as UTF-8
    // (verified on Photoshop CC 2019 with Chinese prefixes: "QPE-%E6%B5%8B...").
    // Raw names are kept here; QPECore.matchSequence decodes them before matching.
    function listFileNames(folder) {
        var names = [];
        var entries;
        try {
            entries = folder.getFiles();
        } catch (error) {
            return names;
        }
        if (!entries) {
            return names;
        }
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            // Directories (and anything that is not a plain file) are ignored.
            if (!(entry instanceof File)) {
                continue;
            }
            names[names.length] = entry.name;
        }
        return names;
    }

    function folderWritable(folder) {
        var probe = new File(joinPath(folder.fsName, PROBE_NAME));
        var opened = false;
        try {
            opened = probe.open("w");
            if (opened) {
                probe.write("qpe");
                probe.close();
                probe.remove();
                return {
                    ok: true
                };
            }
        } catch (error) {
            // fall through to the failure object
        }
        try {
            probe.remove();
        } catch (cleanupError) {
            // ignore: the file was never created
        }
        return {
            ok: false,
            message: "输出文件夹不可写入：" + folder.fsName
        };
    }

    function modeName(mode) {
        try {
            if (mode === DocumentMode.RGB) {
                return "RGB";
            }
            if (mode === DocumentMode.CMYK) {
                return "CMYK";
            }
            if (mode === DocumentMode.GRAYSCALE) {
                return "灰度";
            }
            if (mode === DocumentMode.LAB) {
                return "Lab";
            }
            if (mode === DocumentMode.BITMAP) {
                return "位图";
            }
            if (mode === DocumentMode.INDEXED) {
                return "索引色";
            }
            if (mode === DocumentMode.DUOTONE) {
                return "双色调";
            }
            if (mode === DocumentMode.MULTICHANNEL) {
                return "多通道";
            }
        } catch (error) {
            return "未知";
        }
        return "未知";
    }

    function bitDepthName(bits) {
        try {
            if (bits === BitsPerChannelType.EIGHT) {
                return 8;
            }
            if (bits === BitsPerChannelType.SIXTEEN) {
                return 16;
            }
            if (bits === BitsPerChannelType.THIRTYTWO) {
                return 32;
            }
            if (bits === BitsPerChannelType.ONE) {
                return 1;
            }
        } catch (error) {
            return 8;
        }
        return 8;
    }

    function describeDocument(doc) {
        var info = {
            hasDocument: true,
            name: doc.name,
            width: Math.round(doc.width.as("px")),
            height: Math.round(doc.height.as("px")),
            mode: modeName(doc.mode),
            bitDepth: bitDepthName(doc.bitsPerChannel),
            layerCount: doc.layers.length,
            saved: doc.saved
        };
        try {
            info.path = doc.path ? doc.path.fsName : "";
        } catch (pathError) {
            info.path = "";
        }
        return info;
    }

    /* ---------- export options shared by preview / export / estimate ---------- */

    function exportFormat(args) {
        return QPECore.normalizeFormat(args.format);
    }

    function scanOptions(args) {
        return {
            format: QPECore.normalizeFormat(args.format),
            numbering: QPECore.normalizeNumbering(args.numbering)
        };
    }

    function qualityError(format, quality) {
        if (format !== "jpg") {
            return null;
        }
        if (!QPECore.isValidJpegQuality(quality)) {
            return fail("BAD_QUALITY", "JPG 质量必须是 0–12 的整数");
        }
        return null;
    }

    function saveOptionsFor(format, quality) {
        if (format === "jpg") {
            var jpeg = new JPEGSaveOptions();
            jpeg.quality = QPECore.normalizeJpegQuality(quality);
            return jpeg;
        }
        var png = new PNGSaveOptions();
        png.interlaced = false;
        return png;
    }

    // Finds the next file name that does not exist yet. The numbering rules
    // live in QPECore so the panel preview and the host always agree.
    function nextFreeTarget(folder, prefix, digits, caseInsensitive, options) {
        var fileName = "";
        var fullPath = "";
        var number = 0;
        var maxNumber = 0;
        var existingCount = 0;
        for (var attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
            var files = listFileNames(folder);
            var computed = QPECore.computeExport(files, prefix, digits, caseInsensitive, options);
            number = computed.nextNumber;
            maxNumber = computed.maxNumber;
            existingCount = computed.existingCount;
            fileName = computed.fileName;
            fullPath = joinPath(folder.fsName, fileName);
            if (!new File(fullPath).exists) {
                break;
            }
        }
        if (new File(fullPath).exists) {
            return {
                ok: false,
                code: "COLLISION",
                message: "目标文件已存在且无法自动分配序号：" + fileName
            };
        }
        return {
            ok: true,
            number: number,
            maxNumber: maxNumber,
            existingCount: existingCount,
            fileName: fileName,
            fullPath: fullPath
        };
    }

    /* ---------- status ---------- */

    function status() {
        if (app.documents.length === 0) {
            return {
                ok: true,
                hasDocument: false,
                message: "当前没有打开任何 Photoshop 文档"
            };
        }
        var info = describeDocument(app.activeDocument);
        var suggestion = QPECore.derivePrefixFromDocument(info.name);
        info.suggestedPrefix = suggestion.prefix;
        info.suggestedAdjusted = suggestion.changed;
        info.ok = true;
        return info;
    }

    /* ---------- preview ---------- */

    function preview(args) {
        var prefixCheck = QPECore.validatePrefix(args.prefix);
        if (!prefixCheck.ok) {
            return fail(prefixCheck.code, prefixCheck.message, prefixCheck.chars ? {
                chars: prefixCheck.chars
            } : null);
        }
        if (!QPECore.isValidDigits(args.digits)) {
            return fail("BAD_DIGITS", "序号位数只能是 1、2 或 3 位");
        }
        if (!args.folder) {
            // No directory yet: still show what the first export would be
            // called, but flag that the number is not based on a real scan.
            return {
                ok: true,
                fileName: QPECore.buildFileName(prefixCheck.prefix, args.digits, 1, exportFormat(args)),
                nextNumber: 1,
                maxNumber: 0,
                existingCount: 0,
                folderAvailable: false
            };
        }
        var folder = folderFromPath(args.folder);
        if (!folder) {
            return fail("FOLDER_MISSING", "输出文件夹不存在或无法访问：" + args.folder);
        }
        var files = listFileNames(folder);
        var computed = QPECore.computeExport(files, prefixCheck.prefix, args.digits, true, scanOptions(args));
        return {
            ok: true,
            fileName: computed.fileName,
            nextNumber: computed.nextNumber,
            maxNumber: computed.maxNumber,
            existingCount: computed.existingCount,
            folderAvailable: true
        };
    }

    /* ---------- export ---------- */

    function needsConversion(doc) {
        try {
            return doc.mode !== DocumentMode.RGB || doc.bitsPerChannel !== BitsPerChannelType.EIGHT;
        } catch (error) {
            return false;
        }
    }

    // A JPG has no alpha channel, so transparent areas have to become white.
    // This always happens on the temporary copy: the source document keeps its
    // layers, visibility, mode and bit depth.
    //
    // Flattening fills transparency with white; when the copy has no Background
    // layer an explicit white layer is added at the bottom first so the result
    // is white regardless of the application's background colour. Documents
    // that already have a Background layer are opaque and only need flattening.
    function fillWhiteAndFlatten(copy) {
        var hasBackground = false;
        try {
            hasBackground = copy.backgroundLayer !== null && typeof copy.backgroundLayer !== "undefined";
        } catch (backgroundError) {
            hasBackground = false;
        }
        if (!hasBackground) {
            var white = new SolidColor();
            white.rgb.red = 255;
            white.rgb.green = 255;
            white.rgb.blue = 255;
            var background = copy.artLayers.add();
            background.name = "QPE-white-background";
            background.move(copy, ElementPlacement.PLACEATEND);
            copy.activeLayer = background;
            copy.selection.selectAll();
            copy.selection.fill(white);
            copy.selection.deselect();
        }
        copy.flatten();
    }

    function prepareCopyForExport(doc, format) {
        var warnings = [];
        var copy = doc.duplicate("QuickPNG-temp");
        try {
            if (copy.bitsPerChannel !== BitsPerChannelType.EIGHT) {
                copy.bitsPerChannel = BitsPerChannelType.EIGHT;
            }
            if (copy.mode !== DocumentMode.RGB) {
                copy.changeMode(ChangeMode.RGB); // assigning .mode is a silent no-op in CC 2019
            }
            if (format === "jpg") {
                fillWhiteAndFlatten(copy);
            }
        } catch (conversionError) {
            try {
                copy.close(SaveOptions.DONOTSAVECHANGES);
            } catch (closeError) {
                // ignore
            }
            throw conversionError;
        }

        if (needsConversion(doc)) {
            var originalMode = modeName(doc.mode);
            var originalDepth = bitDepthName(doc.bitsPerChannel);
            warnings[warnings.length] =
                "原文档为 " + originalMode + " / " + originalDepth +
                " 位，已在临时副本中转换为 RGB / 8 位后导出（颜色可能有偏移，源文档未被修改）";
            if (originalMode !== "RGB") {
                warnings[warnings.length] =
                    "原文档没有透明通道；转换为 RGB 后透明区域会变为白色/背景色";
            }
        }
        return {
            copy: copy,
            warnings: warnings
        };
    }

    function exportImage(args) {
        if (app.documents.length === 0) {
            return fail("NO_DOCUMENT", "请先打开一个 Photoshop 文档");
        }
        var doc = app.activeDocument;

        var prefixCheck = QPECore.validatePrefix(args.prefix);
        if (!prefixCheck.ok) {
            return fail(prefixCheck.code, prefixCheck.message, prefixCheck.chars ? {
                chars: prefixCheck.chars
            } : null);
        }
        if (!QPECore.isValidDigits(args.digits)) {
            return fail("BAD_DIGITS", "序号位数只能是 1、2 或 3 位");
        }
        var format = exportFormat(args);
        var badQuality = qualityError(format, args.quality);
        if (badQuality) {
            return badQuality;
        }
        var options = scanOptions(args);
        if (!args.folder) {
            return fail("NO_FOLDER", "请选择输出文件夹");
        }
        var folder = folderFromPath(args.folder);
        if (!folder) {
            return fail("FOLDER_MISSING", "输出文件夹不存在或无法访问：" + args.folder);
        }
        var writable = folderWritable(folder);
        if (!writable.ok) {
            return fail("FOLDER_NOT_WRITABLE", writable.message);
        }

        var prefix = prefixCheck.prefix;
        var digits = args.digits;

        // Re-scan right before saving: the preview/predicted name is never
        // trusted for the final write.
        var target = nextFreeTarget(folder, prefix, digits, true, options);
        if (!target.ok) {
            return fail(target.code, target.message);
        }
        var number = target.number;
        var maxNumber = target.maxNumber;
        var existingCount = target.existingCount;
        var fileName = target.fileName;
        var fullPath = target.fullPath;

        var oldDialogs = app.displayDialogs;
        var copy = null;
        var warnings = [];
        var converted = false;
        try {
            app.displayDialogs = DialogModes.NO;

            var saveTarget = doc;
            if (needsConversion(doc) || format === "jpg") {
                var prepared = prepareCopyForExport(doc, format);
                saveTarget = prepared.copy;
                copy = prepared.copy;
                warnings = prepared.warnings;
                converted = needsConversion(doc);
            }

            saveTarget.saveAs(new File(fullPath), saveOptionsFor(format, args.quality), true, Extension.LOWERCASE);

            if (copy) {
                copy.close(SaveOptions.DONOTSAVECHANGES);
                copy = null;
            }
            try {
                app.activeDocument = doc;
            } catch (activateError) {
                // ignore: the document is still open
            }
        } catch (saveError) {
            if (copy) {
                try {
                    copy.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeError) {
                    // ignore
                }
                copy = null;
            }
            return fail("SAVE_FAILED", "导出失败：" + errorText(saveError));
        } finally {
            try {
                app.displayDialogs = oldDialogs;
            } catch (dialogRestoreError) {
                // ignore
            }
        }

        var savedFile = new File(fullPath);
        if (!savedFile.exists) {
            return fail("VERIFY_FAILED", "导出后找不到输出文件：" + fullPath);
        }
        if (savedFile.length <= 0) {
            return fail("VERIFY_FAILED", "导出的文件为空（0 字节）：" + fullPath);
        }

        return {
            ok: true,
            fileName: fileName,
            fullPath: savedFile.fsName,
            number: number,
            maxNumber: maxNumber,
            existingCount: existingCount,
            format: format,
            quality: format === "jpg" ? QPECore.normalizeJpegQuality(args.quality) : null,
            converted: converted,
            warnings: warnings,
            document: doc.name
        };
    }

    // Legacy PNG-only entry point kept for older panel builds and scripts.
    function exportPng(args) {
        args.format = "png";
        return exportImage(args);
    }

    /* ---------- size estimate ---------- */

    var ESTIMATE_TEMP_PREFIX = "qpe-estimate-";

    // The estimate must never touch the output folder or the source document,
    // so it saves with the exact same options to a throw-away system temp file.
    function uniqueTempFile(extension) {
        var tempFolder;
        try {
            tempFolder = Folder.temp;
        } catch (tempError) {
            return null;
        }
        if (!tempFolder || !tempFolder.fsName) {
            return null;
        }
        var stamp = (new Date()).getTime();
        for (var attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
            var candidate = new File(joinPath(tempFolder.fsName,
                ESTIMATE_TEMP_PREFIX + stamp + "-" + attempt + extension));
            if (!candidate.exists) {
                return candidate;
            }
        }
        return null;
    }

    function estimateSize(args) {
        if (app.documents.length === 0) {
            return fail("NO_DOCUMENT", "请先打开一个 Photoshop 文档");
        }
        var doc = app.activeDocument;
        var format = exportFormat(args);
        var badQuality = qualityError(format, args.quality);
        if (badQuality) {
            return badQuality;
        }
        var tempFile = uniqueTempFile(QPECore.formatExtension(format));
        if (!tempFile) {
            return fail("ESTIMATE_FAILED", "无法创建临时文件用于估算");
        }
        var oldDialogs = app.displayDialogs;
        var copy = null;
        var bytes = 0;
        try {
            app.displayDialogs = DialogModes.NO;
            var saveTarget = doc;
            if (needsConversion(doc) || format === "jpg") {
                var prepared = prepareCopyForExport(doc, format);
                saveTarget = prepared.copy;
                copy = prepared.copy;
            }
            saveTarget.saveAs(tempFile, saveOptionsFor(format, args.quality), true, Extension.LOWERCASE);
            if (copy) {
                copy.close(SaveOptions.DONOTSAVECHANGES);
                copy = null;
            }
            try {
                app.activeDocument = doc;
            } catch (activateError) {
                // ignore: the source document is still open and unchanged
            }
            var savedFile = new File(tempFile.fsName);
            if (!savedFile.exists) {
                return fail("ESTIMATE_FAILED", "估算后找不到临时文件");
            }
            bytes = savedFile.length;
            if (bytes <= 0) {
                return fail("ESTIMATE_FAILED", "估算结果为空文件");
            }
        } catch (estimateError) {
            return fail("ESTIMATE_FAILED", "无法估算大小：" + errorText(estimateError));
        } finally {
            if (copy) {
                try {
                    copy.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeError) {
                    // ignore
                }
                copy = null;
            }
            try {
                if (tempFile.exists) {
                    tempFile.remove();
                }
            } catch (removeError) {
                // best effort: reporting is more useful than throwing here
            }
            try {
                app.displayDialogs = oldDialogs;
            } catch (dialogRestoreError) {
                // ignore
            }
        }
        return {
            ok: true,
            bytes: bytes,
            format: format,
            quality: format === "jpg" ? QPECore.normalizeJpegQuality(args.quality) : null
        };
    }

    /* ---------- batch: selected layers ---------- */

    var BATCH_TEMP_NAME = "QPE-batch-temp";

    // Collage (1.3.0): Photoshop refuses documents wider or taller than this.
    var COLLAGE_TEMP_NAME = "QPE-collage-temp";
    var COLLAGE_WORK_TEMP_NAME = "QPE-collage-work-temp";
    var MAX_DOCUMENT_DIMENSION = 300000;

    // ExtendScript has no Array.prototype.indexOf; keep a tiny helper local to
    // the batch code instead of touching the shipped core contract.
    function listContains(list, value) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] === value) {
                return true;
            }
        }
        return false;
    }

    // Walks the document top to bottom (panel order) and records every layer:
    // its id, its path of sibling indexes, its parent and its children.
    function buildLayerIndex(doc) {
        var index = {
            records: [],
            rootChildren: [],
            byId: {}
        };

        function walk(container, parent, path) {
            var layers;
            try {
                layers = container.layers;
            } catch (layersError) {
                return;
            }
            if (!layers) {
                return;
            }
            var siblings = parent ? parent.children : index.rootChildren;
            for (var i = 0; i < layers.length; i++) {
                var layer = layers[i];
                var layerPath = path.concat([i]);
                var isGroup = layer.typename === "LayerSet";
                var record = {
                    layer: layer,
                    id: layer.id,
                    name: layer.name,
                    isGroup: isGroup,
                    path: layerPath,
                    parents: parent ? parent.parents.concat([parent]) : [],
                    parent: parent,
                    children: [],
                    order: index.records.length
                };
                index.records[index.records.length] = record;
                index.byId[record.id] = record;
                siblings[siblings.length] = record;
                if (isGroup) {
                    walk(layer, record, layerPath);
                }
            }
        }

        walk(doc, null, []);
        return index;
    }

    // Current Photoshop selection via ActionManager. The DOM only exposes
    // doc.activeLayer (one layer), so the document's target-layer lists are the
    // only way to read a real multi-selection.
    //
    // CC 2019 verified: "targetLayers" holds layer references addressed by
    // index. That encoding is unreliable here - the first index is 0, which
    // Photoshop cannot resolve, and a full select-all then misses the active
    // layer. "targetLayersIDs" holds the same objects addressed by layer ID;
    // getIdentifier() on each entry returns the ID that matches layer.id.
    // Always read the ID list first and only fall back to the index list.
    function readTargetLayerIdsByIds(documentDesc) {
        if (!documentDesc.hasKey(stringIDToTypeID("targetLayersIDs"))) {
            return null;
        }
        var ids = [];
        var failedPositions = [];
        var list = documentDesc.getList(stringIDToTypeID("targetLayersIDs"));
        for (var i = 0; i < list.count; i++) {
            var layerId = null;
            try {
                layerId = list.getReference(i).getIdentifier();
            } catch (identifierError) {
                layerId = null;
            }
            if (typeof layerId !== "number") {
                failedPositions[failedPositions.length] = i;
            } else {
                ids[ids.length] = layerId;
            }
        }
        if (failedPositions.length > 0) {
            return fail("SELECTION_READ_FAILED",
                "无法读取部分选中对象的图层引用（第 " + (failedPositions[0] + 1) + " 项），已停止导出");
        }
        return {
            ok: true,
            ids: ids
        };
    }

    function readTargetLayerIdsByIndex(documentDesc) {
        if (!documentDesc.hasKey(stringIDToTypeID("targetLayers"))) {
            return fail("SELECTION_READ_FAILED", "无法读取当前选中的图层：Photoshop 没有返回 targetLayers");
        }
        var ids = [];
        var failedIndexes = [];
        var list = documentDesc.getList(stringIDToTypeID("targetLayers"));
        for (var i = 0; i < list.count; i++) {
            var layerId = null;
            try {
                var layerRef = list.getReference(i);
                var layerDesc = executeActionGet(layerRef);
                layerId = layerDesc.getInteger(stringIDToTypeID("layerID"));
            } catch (layerError) {
                layerId = null;
            }
            if (layerId === null || typeof layerId === "undefined") {
                failedIndexes[failedIndexes.length] = i;
            } else {
                ids[ids.length] = layerId;
            }
        }
        if (failedIndexes.length > 0) {
            return fail("SELECTION_READ_FAILED",
                "无法读取部分选中对象的图层引用（第 " + (failedIndexes[0] + 1) + " 项），已停止导出");
        }
        return {
            ok: true,
            ids: ids
        };
    }

    function readTargetLayerIds() {
        var documentDesc;
        try {
            var documentRef = new ActionReference();
            documentRef.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            documentDesc = executeActionGet(documentRef);
        } catch (selectionError) {
            return fail("SELECTION_READ_FAILED", "无法读取当前选中的图层：" + errorText(selectionError));
        }
        var selection = null;
        try {
            selection = readTargetLayerIdsByIds(documentDesc);
        } catch (idReadError) {
            selection = null;
        }
        if (selection === null) {
            try {
                selection = readTargetLayerIdsByIndex(documentDesc);
            } catch (indexReadError) {
                return fail("SELECTION_READ_FAILED", "无法读取当前选中的图层：" + errorText(indexReadError));
            }
        }
        if (!selection.ok) {
            return selection;
        }
        if (selection.ids.length === 0) {
            return fail("NO_SELECTION", "请先在 Photoshop 中选中要导出的图层或图层组");
        }
        return selection;
    }

    // The panel sends this key back with the export request; it changes when
    // the active document or its selection changed since the preview.
    function selectionKeyOf(doc, ids) {
        var sorted = ids.slice(0);
        sorted.sort(function (left, right) {
            return left - right;
        });
        var width = 0;
        var height = 0;
        try {
            width = Math.round(doc.width.as("px"));
            height = Math.round(doc.height.as("px"));
        } catch (sizeError) {
            width = 0;
            height = 0;
        }
        return doc.name + "|" + width + "x" + height + "|" + sorted.join(",");
    }

    function resolveTargets(index, ids) {
        var found = [];
        var missing = [];
        for (var i = 0; i < ids.length; i++) {
            var record = index.byId[ids[i]];
            if (record) {
                found[found.length] = record;
            } else {
                missing[missing.length] = ids[i];
            }
        }
        if (missing.length > 0) {
            return fail("SELECTION_READ_FAILED",
                "有选中的图层无法在图层树中定位（ID " + missing.join(",") + "），已停止导出");
        }
        var ordered = QPECore.orderSelectedLayers(found, ids);
        if (ordered.length === 0) {
            return fail("NO_SELECTION", "请先在 Photoshop 中选中要导出的图层或图层组");
        }
        return {
            ok: true,
            targets: ordered
        };
    }

    var ADJUSTMENT_KINDS_CACHE = null;

    function getAdjustmentKinds() {
        if (ADJUSTMENT_KINDS_CACHE) {
            return ADJUSTMENT_KINDS_CACHE;
        }
        var kinds = [];
        var candidates = [
            LayerKind.BRIGHTNESS, LayerKind.LEVELS, LayerKind.CURVES, LayerKind.EXPOSURE,
            LayerKind.VIBRANCE, LayerKind.HUE_SATURATION, LayerKind.COLOR_BALANCE,
            LayerKind.BLACKANDWHITE, LayerKind.PHOTO_FILTER, LayerKind.CHANNEL_MIXER,
            LayerKind.COLOR_LOOKUP, LayerKind.INVERSION, LayerKind.POSTERIZE,
            LayerKind.THRESHOLD, LayerKind.GRADIENT_MAP, LayerKind.SELECTIVE_COLOR,
            LayerKind.MATCH_COLOR
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (typeof candidates[i] !== "undefined" && candidates[i] !== null) {
                kinds[kinds.length] = candidates[i];
            }
        }
        ADJUSTMENT_KINDS_CACHE = kinds;
        return kinds;
    }

    function isAdjustmentLayer(layer) {
        try {
            var kind = layer.kind;
            var kinds = getAdjustmentKinds();
            for (var i = 0; i < kinds.length; i++) {
                if (kinds[i] === kind) {
                    return true;
                }
            }
        } catch (kindError) {
            return false;
        }
        return false;
    }

    // True when a pass-through group contains a layer whose blend mode needs a
    // backdrop outside the group (multiply/screen on a pass-through group blend
    // against whatever is below the group in the original document).
    function subtreeHasExternalBlend(container) {
        var children;
        try {
            children = container.layers;
        } catch (childrenError) {
            return false;
        }
        if (!children) {
            return false;
        }
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            var blendMode;
            try {
                blendMode = child.blendMode;
            } catch (blendError) {
                blendMode = BlendMode.NORMAL;
            }
            var isGroup = child.typename === "LayerSet";
            if (isGroup) {
                if (blendMode !== BlendMode.NORMAL && blendMode !== BlendMode.PASSTHROUGH) {
                    return true;
                }
                if (subtreeHasExternalBlend(child)) {
                    return true;
                }
            } else if (blendMode !== BlendMode.NORMAL) {
                return true;
            }
        }
        return false;
    }

    function externalAdjustmentAbove(record, index) {
        for (var level = 0; level < record.path.length; level++) {
            var container = (level === 0) ? index.rootChildren : record.parents[level - 1].children;
            var position = record.path[level];
            for (var i = 0; i < position && i < container.length; i++) {
                if (isAdjustmentLayer(container[i].layer)) {
                    return {
                        code: "ADJUSTMENT",
                        message: "上方有调整图层「" + container[i].name + "」，单独导出会丢失它的效果，已跳过"
                    };
                }
            }
        }
        return null;
    }

    // A layer that is clipped to the target (a "clipping base") behaves like a
    // dependency: exporting the base on its own drops the clipped content that
    // the canvas shows on top of it. Clipped layers sit contiguously above
    // their base, so only the uninterrupted run directly above counts.
    function externalClipAbove(record, index) {
        for (var level = 0; level < record.path.length; level++) {
            var container = (level === 0) ? index.rootChildren : record.parents[level - 1].children;
            var position = record.path[level];
            for (var i = position - 1; i >= 0 && i < container.length; i--) {
                var layer = container[i].layer;
                var grouped = false;
                try {
                    grouped = layer.grouped === true;
                } catch (groupedError) {
                    grouped = false;
                }
                if (!grouped) {
                    break;
                }
                return {
                    code: "CLIPPED",
                    message: "「" + record.name + "」上方有依赖它的剪贴蒙版内容「" + container[i].name + "」，单独导出会丢失，已跳过"
                };
            }
        }
        return null;
    }

    // Conservative dependency detection for the first version. Only a target
    // that renders independently is exported; anything that reads layers
    // outside itself is reported as skipped instead of being silently wrong.
    function dependencyFor(record, index) {
        var layer = record.layer;
        var blendMode;
        try {
            blendMode = layer.blendMode;
        } catch (blendError) {
            blendMode = BlendMode.NORMAL;
        }
        if (!record.isGroup) {
            try {
                if (layer.grouped) {
                    return {
                        code: "CLIPPED",
                        message: "图层「" + record.name + "」是剪贴蒙版内容，依赖它下面的图层，已跳过"
                    };
                }
            } catch (groupedError) {
                // Old hosts may not expose .grouped; treat as not clipped.
            }
            if (blendMode !== BlendMode.NORMAL) {
                return {
                    code: "BLEND",
                    message: "图层「" + record.name + "」的混合模式不是「正常」，单独导出会失真，已跳过"
                };
            }
        } else if (blendMode === BlendMode.PASSTHROUGH) {
            if (subtreeHasExternalBlend(layer)) {
                return {
                    code: "BLEND",
                    message: "图层组「" + record.name + "」是穿透组且内部有非正常混合模式，已跳过"
                };
            }
        } else if (blendMode !== BlendMode.NORMAL) {
            return {
                code: "BLEND",
                message: "图层组「" + record.name + "」的混合模式不是「正常」，单独导出会失真，已跳过"
            };
        }
        for (var i = 0; i < record.parents.length; i++) {
            var ancestor = record.parents[i];
            try {
                if (ancestor.layer.grouped) {
                    return {
                        code: "CLIPPED",
                        message: "上级图层组「" + ancestor.name + "」是剪贴蒙版内容，已跳过"
                    };
                }
            } catch (ancestorGroupedError) {
                // ignore: not clipped
            }
            var ancestorBlend = BlendMode.NORMAL;
            try {
                ancestorBlend = ancestor.layer.blendMode;
            } catch (ancestorBlendError) {
                ancestorBlend = BlendMode.NORMAL;
            }
            if (ancestorBlend !== BlendMode.PASSTHROUGH && ancestorBlend !== BlendMode.NORMAL) {
                return {
                    code: "BLEND",
                    message: "上级图层组「" + ancestor.name + "」的混合模式不是「正常」，已跳过"
                };
            }
        }
        var clipDependency = externalClipAbove(record, index);
        if (clipDependency) {
            return clipDependency;
        }
        return externalAdjustmentAbove(record, index);
    }

    function setAllVisible(records, visible) {
        for (var i = 0; i < records.length; i++) {
            try {
                records[i].layer.visible = visible;
            } catch (visibilityError) {
                // A locked/background layer in the temporary copy may reject
                // this; the item is reported as a failure later if isolation
                // cannot be verified, never silently exported with leftovers.
            }
        }
    }

    function captureVisibility(index) {
        var snapshot = [];
        for (var i = 0; i < index.records.length; i++) {
            var visible = true;
            try {
                visible = index.records[i].layer.visible;
            } catch (visibilityError) {
                visible = true;
            }
            snapshot[snapshot.length] = {
                record: index.records[i],
                visible: visible
            };
        }
        return snapshot;
    }

    function restoreVisibility(snapshot, visibleById) {
        for (var i = 0; i < snapshot.length; i++) {
            try {
                snapshot[i].record.layer.visible = snapshot[i].visible;
            } catch (visibilityError) {
                // ignore
            }
            visibleById[snapshot[i].record.id] = snapshot[i].visible;
        }
    }

    function restoreDescendants(record, visibleById) {
        for (var i = 0; i < record.children.length; i++) {
            var child = record.children[i];
            var visible = visibleById[child.id];
            if (typeof visible === "undefined") {
                visible = true;
            }
            try {
                child.layer.visible = visible;
            } catch (visibilityError) {
                // ignore
            }
            restoreDescendants(child, visibleById);
        }
    }

    // Shows one record, its ancestor path and (for groups) the original child
    // visibility. Everything else in the temporary copy is hidden.
    function isolateRecord(record, index, visibleById) {
        setAllVisible(index.records, false);
        for (var i = 0; i < record.parents.length; i++) {
            try {
                record.parents[i].layer.visible = true;
            } catch (parentError) {
                // ignore
            }
        }
        try {
            record.layer.visible = true;
        } catch (targetError) {
            // ignore
        }
        if (record.isGroup) {
            restoreDescendants(record, visibleById);
        }
    }

    // Saves the isolated temporary copy as the next free file.
    //
    // PNG can be probed for transparency after saving (zero-area bounds mean an
    // empty selection), but a JPEG has no alpha channel. For JPG the copy is
    // therefore first written to a throw-away PNG, probed, and only a non-empty
    // item is flattened onto white and written as JPG. Empty items never
    // consume a number and never leave a file behind.
    function saveBatchImage(workDoc, folder, prefix, digits, format, quality, options) {
        if (format === "jpg") {
            return saveBatchJpg(workDoc, folder, prefix, digits, quality, options);
        }
        var target = nextFreeTarget(folder, prefix, digits, true, options);
        if (!target.ok) {
            return target;
        }
        workDoc.saveAs(new File(target.fullPath), saveOptionsFor("png", quality), true, Extension.LOWERCASE);
        var file = new File(target.fullPath);
        if (!file.exists) {
            return {
                ok: false,
                code: "VERIFY_FAILED",
                message: "导出后找不到输出文件：" + target.fullPath
            };
        }
        if (file.length <= 0) {
            return {
                ok: false,
                code: "VERIFY_FAILED",
                message: "导出的文件为空（0 字节）：" + target.fullPath
            };
        }
        var probe = probePngHasPixels(file);
        if (!probe.ok) {
            return {
                ok: false,
                code: "ALPHA_CHECK_FAILED",
                message: "无法检测导出结果的透明度：" + probe.message
            };
        }
        return {
            ok: true,
            empty: !probe.hasPixels,
            number: target.number,
            fileName: target.fileName,
            file: file
        };
    }

    function saveBatchJpg(workDoc, folder, prefix, digits, quality, options) {
        var tempPng = uniqueTempFile(".png");
        if (!tempPng) {
            return {
                ok: false,
                code: "TEMP_FAILED",
                message: "无法创建临时文件用于检测空图层"
            };
        }
        var probeDoc = null;
        try {
            workDoc.saveAs(tempPng, saveOptionsFor("png", quality), true, Extension.LOWERCASE);
            probeDoc = app.open(tempPng);
            var bounds = probeDoc.activeLayer.bounds;
            var width = bounds[2].as("px") - bounds[0].as("px");
            var height = bounds[3].as("px") - bounds[1].as("px");
            if (!(width > 0 && height > 0)) {
                return {
                    ok: true,
                    empty: true,
                    number: 0,
                    fileName: "",
                    file: null
                };
            }

            fillWhiteAndFlatten(probeDoc);

            // The number is allocated only after the item is known to have
            // pixels, so skipped items never consume a number.
            var target = nextFreeTarget(folder, prefix, digits, true, options);
            if (!target.ok) {
                return target;
            }
            probeDoc.saveAs(new File(target.fullPath), saveOptionsFor("jpg", quality), true, Extension.LOWERCASE);
            try {
                probeDoc.close(SaveOptions.DONOTSAVECHANGES);
            } catch (closeError) {
                // ignore
            }
            probeDoc = null;
            try {
                app.activeDocument = workDoc;
            } catch (activateError) {
                // ignore
            }
            var file = new File(target.fullPath);
            if (!file.exists) {
                return {
                    ok: false,
                    code: "VERIFY_FAILED",
                    message: "导出后找不到输出文件：" + target.fullPath
                };
            }
            if (file.length <= 0) {
                return {
                    ok: false,
                    code: "VERIFY_FAILED",
                    message: "导出的文件为空（0 字节）：" + target.fullPath
                };
            }
            return {
                ok: true,
                empty: false,
                number: target.number,
                fileName: target.fileName,
                file: file
            };
        } catch (saveError) {
            return {
                ok: false,
                code: "SAVE_FAILED",
                message: "导出失败：" + errorText(saveError)
            };
        } finally {
            if (probeDoc) {
                try {
                    probeDoc.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeProbeError) {
                    // ignore
                }
            }
            try {
                if (tempPng.exists) {
                    tempPng.remove();
                }
            } catch (removeError) {
                // best effort: the caller reports visible problems
            }
        }
    }

    // Re-opens the just-saved PNG and reads its single layer bounds. A fully
    // transparent PNG has zero-area bounds; any visible pixel makes them > 0.
    // This is the alpha check verified on CC 2019 (BMP/TIFF alpha and the
    // ActionManager histogram route were all unusable).
    function probePngHasPixels(file) {
        var result = {
            ok: false,
            hasPixels: false,
            message: ""
        };
        var probeDoc = null;
        try {
            probeDoc = app.open(file);
            var bounds = probeDoc.activeLayer.bounds;
            var width = bounds[2].as("px") - bounds[0].as("px");
            var height = bounds[3].as("px") - bounds[1].as("px");
            result.ok = true;
            result.hasPixels = width > 0 && height > 0;
        } catch (probeError) {
            result.message = errorText(probeError);
        } finally {
            if (probeDoc) {
                try {
                    probeDoc.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeError) {
                    // the closed document would be reported by the caller as a
                    // cleanup problem if it mattered for correctness
                }
            }
        }
        return result;
    }

    function batchConversionWarnings(doc) {
        var originalMode = modeName(doc.mode);
        var originalDepth = bitDepthName(doc.bitsPerChannel);
        var warnings = [];
        warnings[warnings.length] =
            "原文档为 " + originalMode + " / " + originalDepth +
            " 位，已在临时副本中转换为 RGB / 8 位后导出（颜色可能有偏移，源文档未被修改）";
        if (originalMode !== "RGB") {
            warnings[warnings.length] =
                "原文档没有透明通道；转换为 RGB 后透明区域会变为白色/背景色";
        }
        return warnings;
    }

    /* ---------- shared selection pipeline ---------- */

    // Reads Photoshop's real multi-selection once and turns it into the two
    // lists every selection-based command needs: objects that can be exported
    // on their own, and objects that depend on neighbouring layers (adjustment,
    // clipping, blend) and are skipped with a reason. The collage commands use
    // exactly the same pipeline as the selected-layer commands, so both modes
    // agree on order, dedupe and skip rules.
    function collectSelection(doc) {
        var selection = readTargetLayerIds();
        if (!selection.ok) {
            return selection;
        }
        var index = buildLayerIndex(doc);
        var resolved = resolveTargets(index, selection.ids);
        if (!resolved.ok) {
            return resolved;
        }
        var exportable = [];
        var knownSkips = [];
        for (var i = 0; i < resolved.targets.length; i++) {
            var target = resolved.targets[i];
            var dependency = dependencyFor(target, index);
            if (dependency) {
                knownSkips[knownSkips.length] = {
                    id: target.id,
                    name: target.name,
                    isGroup: target.isGroup,
                    code: dependency.code,
                    message: dependency.message
                };
            } else {
                exportable[exportable.length] = target;
            }
        }
        return {
            ok: true,
            index: index,
            selection: selection,
            resolved: resolved,
            exportable: exportable,
            knownSkips: knownSkips,
            selectionKey: selectionKeyOf(doc, selection.ids)
        };
    }

    function documentSize(doc) {
        var size = {
            width: 0,
            height: 0
        };
        try {
            size.width = Math.round(doc.width.as("px"));
            size.height = Math.round(doc.height.as("px"));
        } catch (sizeError) {
            size.width = 0;
            size.height = 0;
        }
        return size;
    }

    function copySkipList(list) {
        var copy = [];
        for (var i = 0; i < list.length; i++) {
            copy[copy.length] = list[i];
        }
        return copy;
    }

    /* ---------- collage: selected layers on a grid (1.3.0) ---------- */

    // The panel only knows the object count; the grid maths lives in QPECore so
    // the panel and the host compute exactly the same columns / rows / target
    // size. Preview returns one expected file name (a collage is one image).
    function previewCollage(args) {
        if (app.documents.length === 0) {
            return fail("NO_DOCUMENT", "请先打开一个 Photoshop 文档");
        }
        var doc = app.activeDocument;

        var prefixCheck = QPECore.validatePrefix(args.prefix);
        if (!prefixCheck.ok) {
            return fail(prefixCheck.code, prefixCheck.message, prefixCheck.chars ? {
                chars: prefixCheck.chars
            } : null);
        }
        if (!QPECore.isValidDigits(args.digits)) {
            return fail("BAD_DIGITS", "序号位数只能是 1、2 或 3 位");
        }
        var format = exportFormat(args);
        var badQuality = qualityError(format, args.quality);
        if (badQuality) {
            return badQuality;
        }
        var options = scanOptions(args);

        var collected = collectSelection(doc);
        if (!collected.ok) {
            return collected;
        }

        var files = [];
        var folderAvailable = false;
        if (args.folder) {
            var folder = folderFromPath(args.folder);
            if (!folder) {
                return fail("FOLDER_MISSING", "输出文件夹不存在或无法访问：" + args.folder);
            }
            files = listFileNames(folder);
            folderAvailable = true;
        }
        var plan = QPECore.buildBatchNames(files, prefixCheck.prefix, args.digits, 1, true, options);
        var fileName = plan.names.length > 0 ? plan.names[0] :
            QPECore.buildFileName(prefixCheck.prefix, args.digits, plan.startNumber, options.format);
        var items = [];
        for (var i = 0; i < collected.exportable.length; i++) {
            items[items.length] = {
                id: collected.exportable[i].id,
                name: collected.exportable[i].name,
                isGroup: collected.exportable[i].isGroup
            };
        }

        var warnings = [];
        if (needsConversion(doc)) {
            warnings[warnings.length] =
                "原文档为 " + modeName(doc.mode) + " / " + bitDepthName(doc.bitsPerChannel) +
                " 位，导出时会在临时副本中转换为 RGB / 8 位（预计文件名基于当前状态）";
        }
        var size = documentSize(doc);

        return {
            ok: true,
            document: doc.name,
            documentWidth: size.width,
            documentHeight: size.height,
            selectionKey: collected.selectionKey,
            selectedCount: collected.resolved.targets.length,
            count: collected.exportable.length,
            items: items,
            skipped: collected.knownSkips,
            folderAvailable: folderAvailable,
            fileName: fileName,
            startNumber: plan.startNumber,
            maxNumber: plan.maxNumber,
            existingCount: plan.existingCount,
            warnings: warnings
        };
    }

    // One collage image. Every cell is the whole canvas, filled row-major in
    // panel order with no gaps and no margins.
    //
    // Composition: isolate one object at a time on a temporary copy (same
    // isolation rules as the batch export), save that copy as a temporary
    // transparent PNG, re-open it, duplicate its flattened layer into the
    // collage document and translate it so the object keeps its original
    // position inside its cell. PNG keeps transparency; JPG gets the same white
    // fill as 1.2.0 (also for trailing empty cells). The target size is applied
    // once, to the finished collage.
    function exportCollage(args) {
        if (app.documents.length === 0) {
            return fail("NO_DOCUMENT", "请先打开一个 Photoshop 文档");
        }
        var doc = app.activeDocument;

        var prefixCheck = QPECore.validatePrefix(args.prefix);
        if (!prefixCheck.ok) {
            return fail(prefixCheck.code, prefixCheck.message, prefixCheck.chars ? {
                chars: prefixCheck.chars
            } : null);
        }
        if (!QPECore.isValidDigits(args.digits)) {
            return fail("BAD_DIGITS", "序号位数只能是 1、2 或 3 位");
        }
        var format = exportFormat(args);
        var badQuality = qualityError(format, args.quality);
        if (badQuality) {
            return badQuality;
        }
        var options = scanOptions(args);
        if (!args.folder) {
            return fail("NO_FOLDER", "请选择输出文件夹");
        }
        var folder = folderFromPath(args.folder);
        if (!folder) {
            return fail("FOLDER_MISSING", "输出文件夹不存在或无法访问：" + args.folder);
        }
        var writable = folderWritable(folder);
        if (!writable.ok) {
            return fail("FOLDER_NOT_WRITABLE", writable.message);
        }

        var collected = collectSelection(doc);
        if (!collected.ok) {
            return collected;
        }
        if (args.selectionKey && args.selectionKey !== collected.selectionKey) {
            return fail("SELECTION_CHANGED", "当前文档或选中的图层已发生变化，请刷新选择后重试");
        }

        var exportable = collected.exportable;
        var skipped = copySkipList(collected.knownSkips);
        var totalTargets = collected.resolved.targets.length;
        if (exportable.length === 0) {
            return fail("NOTHING_TO_EXPORT",
                "没有可导出的对象：全部 " + skipped.length + " 项依赖其它图层被跳过，未导出。", {
                    skipped: skipped,
                    total: totalTargets
                });
        }

        var columnInfo = QPECore.normalizeCollageColumns(args.columns, exportable.length);
        var columns = columnInfo.columns;
        var rows = QPECore.collageRows(exportable.length, columns);
        var docSize = documentSize(doc);
        var original = QPECore.collageOriginalSize(columns, rows, docSize.width, docSize.height);
        if (!(original.width > 0 && original.height > 0)) {
            return fail("COLLAGE_FAILED", "无法读取当前文档的像素尺寸，未导出。");
        }
        if (original.width > MAX_DOCUMENT_DIMENSION || original.height > MAX_DOCUMENT_DIMENSION) {
            return fail("COLLAGE_TOO_LARGE",
                "拼图尺寸 " + original.width + " × " + original.height +
                " px 超过 Photoshop 的文档上限（单边最多 " + MAX_DOCUMENT_DIMENSION +
                " px），请减少列数。", {
                    columns: columns,
                    rows: rows,
                    originalWidth: original.width,
                    originalHeight: original.height
                });
        }
        var target = QPECore.resolveCollageTarget(original.width, original.height,
            args.targetWidth, args.targetHeight);
        if (!target.ok) {
            return fail(target.code, target.message, {
                originalWidth: original.width,
                originalHeight: original.height
            });
        }

        var oldDialogs = app.displayDialogs;
        var workDoc = null;
        var collageDoc = null;
        var tempFiles = [];
        var placed = 0;
        var placedItems = [];
        var warnings = [];
        var converted = false;
        var cleanupErrors = [];
        var failure = null;
        var savedFile = null;
        var phase = "prepare";

        try {
            app.displayDialogs = DialogModes.NO;

            if (needsConversion(doc)) {
                warnings = batchConversionWarnings(doc);
                converted = true;
            }

            // Same one-copy-for-the-whole-run strategy as the batch export.
            workDoc = doc.duplicate(COLLAGE_WORK_TEMP_NAME);
            if (workDoc.bitsPerChannel !== BitsPerChannelType.EIGHT) {
                workDoc.bitsPerChannel = BitsPerChannelType.EIGHT;
            }
            if (workDoc.mode !== DocumentMode.RGB) {
                workDoc.changeMode(ChangeMode.RGB); // assigning .mode is a silent no-op in CC 2019
            }
            var workIndex = buildLayerIndex(workDoc);
            var snapshot = captureVisibility(workIndex);
            var visibleById = {};
            for (var v = 0; v < snapshot.length; v++) {
                visibleById[snapshot[v].record.id] = snapshot[v].visible;
            }

            phase = "canvas";
            collageDoc = app.documents.add(UnitValue(original.width, "px"),
                UnitValue(original.height, "px"), doc.resolution, COLLAGE_TEMP_NAME,
                NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1, BitsPerChannelType.EIGHT);

            for (var t = 0; t < exportable.length; t++) {
                var source = exportable[t];
                var workTarget = workIndex.byId[source.id];
                if (!workTarget) {
                    failure = {
                        code: "BATCH_MAPPING_FAILED",
                        message: "「" + source.name + "」在临时副本中找不到，无法拼图"
                    };
                    break;
                }
                phase = "isolate";
                // documents.add() and the previous placement leave the collage
                // canvas active; on CC 2019 visibility edits and saveAs follow
                // the active document, so switch back to the work copy first.
                app.activeDocument = workDoc;
                restoreVisibility(snapshot, visibleById);
                isolateRecord(workTarget, workIndex, visibleById);

                phase = "compose";
                var tempPng = uniqueTempFile(".png");
                if (!tempPng) {
                    failure = {
                        code: "TEMP_FAILED",
                        message: "无法创建临时文件用于拼图"
                    };
                    break;
                }
                tempFiles[tempFiles.length] = tempPng;
                var probeDoc = null;
                try {
                    workDoc.saveAs(tempPng, saveOptionsFor("png", args.quality), true,
                        Extension.LOWERCASE);
                    probeDoc = app.open(tempPng);
                    var probeLayer = probeDoc.activeLayer;
                    var sourceBounds = probeLayer.bounds;
                    var sourceWidth = sourceBounds[2].as("px") - sourceBounds[0].as("px");
                    var sourceHeight = sourceBounds[3].as("px") - sourceBounds[1].as("px");
                    if (!(sourceWidth > 0 && sourceHeight > 0)) {
                        skipped[skipped.length] = {
                            id: source.id,
                            name: source.name,
                            isGroup: source.isGroup,
                            code: "EMPTY",
                            message: "完全透明，已跳过（不占格子）"
                        };
                        continue;
                    }

                    var cellX = (placed % columns) * docSize.width;
                    var cellY = Math.floor(placed / columns) * docSize.height;
                    // Layer.duplicate() only works from the frontmost document;
                    // translate() then needs the collage canvas in front.
                    app.activeDocument = probeDoc;
                    var placedLayer = probeLayer.duplicate(collageDoc, ElementPlacement.PLACEATBEGINNING);
                    app.activeDocument = collageDoc;
                    collageDoc.activeLayer = placedLayer;
                    var placedBounds = placedLayer.bounds;
                    var deltaX = cellX + sourceBounds[0].as("px") - placedBounds[0].as("px");
                    var deltaY = cellY + sourceBounds[1].as("px") - placedBounds[1].as("px");
                    if (deltaX !== 0 || deltaY !== 0) {
                        placedLayer.translate(UnitValue(deltaX, "px"), UnitValue(deltaY, "px"));
                    }
                    placedItems[placedItems.length] = {
                        id: source.id,
                        name: source.name,
                        isGroup: source.isGroup,
                        cellColumn: (placed % columns) + 1,
                        cellRow: Math.floor(placed / columns) + 1
                    };
                    placed++;
                } finally {
                    if (probeDoc) {
                        try {
                            probeDoc.close(SaveOptions.DONOTSAVECHANGES);
                        } catch (closeProbeError) {
                            cleanupErrors[cleanupErrors.length] =
                                "关闭拼图探测文档失败：" + errorText(closeProbeError);
                        }
                    }
                    try {
                        if (tempPng.exists) {
                            tempPng.remove();
                        }
                    } catch (removeTempError) {
                        cleanupErrors[cleanupErrors.length] =
                            "无法删除拼图临时文件：" + tempPng.fsName;
                    }
                }
            }

            if (!failure && placed === 0) {
                failure = {
                    code: "NOTHING_TO_EXPORT",
                    message: "所有可导出对象都是完全透明的，未导出。"
                };
            }

            if (!failure) {
                phase = "resize";
                if (target.width !== original.width || target.height !== original.height) {
                    // Downscale only, once, on the finished collage.
                    collageDoc.resizeImage(UnitValue(target.width, "px"),
                        UnitValue(target.height, "px"), doc.resolution,
                        ResampleMethod.BICUBICSHARPER);
                }

                phase = "save";
                if (format === "jpg") {
                    fillWhiteAndFlatten(collageDoc);
                }
                var output = nextFreeTarget(folder, prefixCheck.prefix, args.digits, true, options);
                if (!output.ok) {
                    failure = {
                        code: output.code,
                        message: output.message
                    };
                } else {
                    collageDoc.saveAs(new File(output.fullPath),
                        saveOptionsFor(format, args.quality), true, Extension.LOWERCASE);
                    var file = new File(output.fullPath);
                    if (!file.exists) {
                        failure = {
                            code: "VERIFY_FAILED",
                            message: "导出后找不到输出文件：" + output.fullPath
                        };
                    } else if (file.length <= 0) {
                        try {
                            file.remove();
                        } catch (removeBrokenError) {
                            // best effort: the failure below is the real result
                        }
                        failure = {
                            code: "VERIFY_FAILED",
                            message: "导出的文件为空（0 字节）：" + output.fullPath
                        };
                    } else {
                        savedFile = {
                            number: output.number,
                            fileName: output.fileName,
                            fullPath: output.fullPath
                        };
                    }
                }
            }
        } catch (collageError) {
            if (!failure) {
                failure = {
                    code: "COLLAGE_FAILED",
                    message: "拼图导出失败：" + errorText(collageError)
                };
            }
        } finally {
            if (collageDoc) {
                try {
                    collageDoc.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeCanvasError) {
                    cleanupErrors[cleanupErrors.length] =
                        "关闭拼图临时文档失败：" + errorText(closeCanvasError);
                }
                collageDoc = null;
            }
            if (workDoc) {
                try {
                    workDoc.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeWorkError) {
                    cleanupErrors[cleanupErrors.length] =
                        "关闭拼图工作副本失败：" + errorText(closeWorkError);
                }
                workDoc = null;
            }
            for (var f = tempFiles.length - 1; f >= 0; f--) {
                try {
                    if (tempFiles[f].exists) {
                        tempFiles[f].remove();
                    }
                } catch (removeLeftoverError) {
                    cleanupErrors[cleanupErrors.length] =
                        "遗留拼图临时文件：" + tempFiles[f].fsName;
                }
            }
            try {
                app.activeDocument = doc;
            } catch (activateError) {
                cleanupErrors[cleanupErrors.length] =
                    "恢复源文档为活动文档失败：" + errorText(activateError);
            }
            try {
                app.displayDialogs = oldDialogs;
            } catch (dialogRestoreError) {
                // ignore
            }
        }

        if (failure) {
            return fail(failure.code || "COLLAGE_FAILED", failure.message, {
                columns: columns,
                rows: rows,
                originalWidth: original.width,
                originalHeight: original.height,
                targetWidth: target.width,
                targetHeight: target.height,
                total: totalTargets,
                placedCount: placed,
                placed: placedItems,
                skipped: skipped,
                converted: converted,
                warnings: warnings,
                cleanupErrors: cleanupErrors,
                document: doc.name
            });
        }

        var message = "拼图导出完成";
        if (skipped.length > 0) {
            message += "：已放入 " + placed + " 张，跳过 " + skipped.length + " 项";
        }
        return {
            ok: true,
            code: "OK",
            message: message,
            fileName: savedFile.fileName,
            fullPath: savedFile.fullPath,
            number: savedFile.number,
            width: target.width,
            height: target.height,
            columns: columns,
            rows: rows,
            placedCount: placed,
            placed: placedItems,
            skipped: skipped,
            total: totalTargets,
            converted: converted,
            warnings: warnings,
            cleanupErrors: cleanupErrors,
            document: doc.name,
            originalWidth: original.width,
            originalHeight: original.height
        };
    }

    function previewSelectedLayers(args) {
        if (app.documents.length === 0) {
            return fail("NO_DOCUMENT", "请先打开一个 Photoshop 文档");
        }
        var doc = app.activeDocument;

        var prefixCheck = QPECore.validatePrefix(args.prefix);
        if (!prefixCheck.ok) {
            return fail(prefixCheck.code, prefixCheck.message, prefixCheck.chars ? {
                chars: prefixCheck.chars
            } : null);
        }
        if (!QPECore.isValidDigits(args.digits)) {
            return fail("BAD_DIGITS", "序号位数只能是 1、2 或 3 位");
        }
        var format = exportFormat(args);
        var badQuality = qualityError(format, args.quality);
        if (badQuality) {
            return badQuality;
        }
        var options = scanOptions(args);

        var collected = collectSelection(doc);
        if (!collected.ok) {
            return collected;
        }
        var exportable = collected.exportable;
        var knownSkips = collected.knownSkips;
        var i;

        var files = [];
        var folderAvailable = false;
        if (args.folder) {
            var folder = folderFromPath(args.folder);
            if (!folder) {
                return fail("FOLDER_MISSING", "输出文件夹不存在或无法访问：" + args.folder);
            }
            files = listFileNames(folder);
            folderAvailable = true;
        }
        var plan = QPECore.buildBatchNames(files, prefixCheck.prefix, args.digits, exportable.length, true, options);
        var items = [];
        for (i = 0; i < exportable.length; i++) {
            items[items.length] = {
                id: exportable[i].id,
                name: exportable[i].name,
                isGroup: exportable[i].isGroup,
                expectedFileName: plan.names[i]
            };
        }

        var warnings = [];
        if (needsConversion(doc)) {
            warnings[warnings.length] =
                "原文档为 " + modeName(doc.mode) + " / " + bitDepthName(doc.bitsPerChannel) +
                " 位，导出时会在临时副本中转换为 RGB / 8 位（预计文件名基于当前状态）";
        }

        return {
            ok: true,
            document: doc.name,
            selectionKey: collected.selectionKey,
            selectedCount: collected.resolved.targets.length,
            count: exportable.length,
            items: items,
            skipped: knownSkips,
            folderAvailable: folderAvailable,
            startNumber: plan.startNumber,
            maxNumber: plan.maxNumber,
            existingCount: plan.existingCount,
            warnings: warnings
        };
    }

    function exportSelectedLayers(args) {
        if (app.documents.length === 0) {
            return fail("NO_DOCUMENT", "请先打开一个 Photoshop 文档");
        }
        var doc = app.activeDocument;

        var prefixCheck = QPECore.validatePrefix(args.prefix);
        if (!prefixCheck.ok) {
            return fail(prefixCheck.code, prefixCheck.message, prefixCheck.chars ? {
                chars: prefixCheck.chars
            } : null);
        }
        if (!QPECore.isValidDigits(args.digits)) {
            return fail("BAD_DIGITS", "序号位数只能是 1、2 或 3 位");
        }
        var format = exportFormat(args);
        var badQuality = qualityError(format, args.quality);
        if (badQuality) {
            return badQuality;
        }
        var options = scanOptions(args);
        if (!args.folder) {
            return fail("NO_FOLDER", "请选择输出文件夹");
        }
        var folder = folderFromPath(args.folder);
        if (!folder) {
            return fail("FOLDER_MISSING", "输出文件夹不存在或无法访问：" + args.folder);
        }
        var writable = folderWritable(folder);
        if (!writable.ok) {
            return fail("FOLDER_NOT_WRITABLE", writable.message);
        }

        var collected = collectSelection(doc);
        if (!collected.ok) {
            return collected;
        }
        var sourceIndex = collected.index;
        var targets = collected.resolved.targets;

        if (args.selectionKey && args.selectionKey !== collected.selectionKey) {
            return fail("SELECTION_CHANGED", "当前文档或选中的图层已发生变化，请刷新选择后重试");
        }

        var totalTargets = targets.length;
        var successes = [];
        var skipped = [];
        var failed = null;
        var warnings = [];
        var cleanupErrors = [];
        var converted = false;
        var unprocessed = 0;
        var phase = "prepare";
        var oldDialogs = app.displayDialogs;
        var workDoc = null;

        try {
            app.displayDialogs = DialogModes.NO;

            if (needsConversion(doc)) {
                warnings = batchConversionWarnings(doc);
                converted = true;
            }

            // One copy for the whole batch: changing the source visibility is
            // forbidden, and re-copying per item is much slower on big files.
            workDoc = doc.duplicate(BATCH_TEMP_NAME);

            if (workDoc.bitsPerChannel !== BitsPerChannelType.EIGHT) {
                workDoc.bitsPerChannel = BitsPerChannelType.EIGHT;
            }
            if (workDoc.mode !== DocumentMode.RGB) {
                workDoc.changeMode(ChangeMode.RGB); // assigning .mode is a silent no-op in CC 2019
            }

            var workIndex = buildLayerIndex(workDoc);
            var snapshot = captureVisibility(workIndex);
            var visibleById = {};
            for (var v = 0; v < snapshot.length; v++) {
                visibleById[snapshot[v].record.id] = snapshot[v].visible;
            }

            for (var t = 0; t < totalTargets; t++) {
                var target = targets[t];
                var workTarget = workIndex.byId[target.id];
                if (!workTarget) {
                    failed = {
                        id: target.id,
                        name: target.name,
                        phase: "map",
                        code: "BATCH_MAPPING_FAILED",
                        message: "临时副本中找不到该图层，无法导出"
                    };
                    unprocessed = totalTargets - t - 1;
                    break;
                }
                var dependency = dependencyFor(target, sourceIndex);
                if (dependency) {
                    skipped[skipped.length] = {
                        id: target.id,
                        name: target.name,
                        isGroup: target.isGroup,
                        code: dependency.code,
                        message: dependency.message
                    };
                    continue;
                }
                try {
                    phase = "isolate";
                    restoreVisibility(snapshot, visibleById);
                    isolateRecord(workTarget, workIndex, visibleById);

                    phase = "save";
                    var saved = saveBatchImage(workDoc, folder, prefixCheck.prefix, args.digits,
                        format, args.quality, options);
                    if (!saved.ok) {
                        failed = {
                            id: target.id,
                            name: target.name,
                            phase: phase,
                            code: saved.code,
                            message: saved.message
                        };
                        unprocessed = totalTargets - t - 1;
                        break;
                    }
                    if (saved.empty) {
                        var removed = false;
                        if (saved.file) {
                            try {
                                removed = saved.file.remove();
                            } catch (removeError) {
                                removed = false;
                            }
                            if (!removed) {
                                cleanupErrors[cleanupErrors.length] =
                                    "无法删除全透明探测文件，该编号已被占用：" + saved.file.fsName;
                            }
                        }
                        skipped[skipped.length] = {
                            id: target.id,
                            name: target.name,
                            isGroup: target.isGroup,
                            code: "EMPTY",
                            message: "完全透明，已跳过（不占编号）"
                        };
                        continue;
                    }

                    successes[successes.length] = {
                        id: target.id,
                        name: target.name,
                        isGroup: target.isGroup,
                        number: saved.number,
                        fileName: saved.fileName,
                        fullPath: saved.file.fsName
                    };
                } catch (itemError) {
                    failed = {
                        id: target.id,
                        name: target.name,
                        phase: phase,
                        code: "BATCH_ITEM_FAILED",
                        message: errorText(itemError)
                    };
                    unprocessed = totalTargets - t - 1;
                    break;
                }
            }
        } catch (batchError) {
            if (!failed) {
                failed = {
                    id: null,
                    name: "",
                    phase: phase,
                    code: "BATCH_FAILED",
                    message: errorText(batchError)
                };
                unprocessed = totalTargets - successes.length - skipped.length;
            }
        } finally {
            if (workDoc) {
                try {
                    workDoc.close(SaveOptions.DONOTSAVECHANGES);
                } catch (closeError) {
                    cleanupErrors[cleanupErrors.length] = "关闭临时副本失败：" + errorText(closeError);
                }
                workDoc = null;
            }
            try {
                app.activeDocument = doc;
            } catch (activateError) {
                cleanupErrors[cleanupErrors.length] = "恢复源文档为活动文档失败：" + errorText(activateError);
            }
            try {
                app.displayDialogs = oldDialogs;
            } catch (dialogRestoreError) {
                // ignore
            }
        }

        var counts = QPECore.summarizeBatch(successes, skipped, failed, unprocessed);
        if (failed) {
            var failure = fail(failed.code || "BATCH_FAILED",
                "批量导出在「" + (failed.name || "未知对象") + "」处停止：" + failed.message, {
                    completed: false,
                    total: totalTargets,
                    successes: successes,
                    skipped: skipped,
                    failed: failed,
                    unprocessedCount: unprocessed,
                    converted: converted,
                    warnings: warnings,
                    cleanupErrors: cleanupErrors,
                    document: doc.name,
                    counts: counts
                });
            return failure;
        }

        var message = "批量导出完成";
        if (counts.exported === 0 && counts.skipped > 0) {
            message = "未导出，已跳过 " + counts.skipped + " 项";
        } else if (counts.skipped > 0) {
            message = "批量导出完成：成功 " + counts.exported + " 张，跳过 " + counts.skipped + " 项";
        }
        return {
            ok: true,
            code: "OK",
            message: message,
            completed: true,
            total: totalTargets,
            successes: successes,
            skipped: skipped,
            failed: null,
            unprocessedCount: 0,
            converted: converted,
            warnings: warnings,
            cleanupErrors: cleanupErrors,
            document: doc.name,
            counts: counts
        };
    }



    function pickFolder(args) {
        var startFolder = null;
        if (args.current) {
            startFolder = folderFromPath(args.current);
        }
        if (!startFolder) {
            try {
                startFolder = Folder.myDocuments;
            } catch (documentsError) {
                startFolder = null;
            }
        }
        var chosen = null;
        if (startFolder) {
            chosen = Folder.selectDialog("请选择输出文件夹", startFolder);
        } else {
            chosen = Folder.selectDialog("请选择输出文件夹");
        }
        if (!chosen) {
            return {
                ok: false,
                canceled: true,
                message: "已取消选择文件夹"
            };
        }
        return {
            ok: true,
            path: chosen.fsName
        };
    }

    function openFolder(args) {
        if (!args.path) {
            return fail("NO_PATH", "没有可打开的文件夹");
        }
        var folder = folderFromPath(args.path);
        if (!folder) {
            return fail("FOLDER_MISSING", "文件夹不存在：" + args.path);
        }
        folder.execute();
        return {
            ok: true,
            path: folder.fsName
        };
    }

    /* ---------- dispatcher ---------- */

    var METHODS = {
        status: status,
        preview: preview,
        exportImage: exportImage,
        estimateSize: estimateSize,
        exportPng: exportPng,
        previewSelectedLayers: previewSelectedLayers,
        exportSelectedLayers: exportSelectedLayers,
        previewCollage: previewCollage,
        exportCollage: exportCollage,
        pickFolder: pickFolder,
        openFolder: openFolder
    };

    function parseArgs(argsJson) {
        if (!argsJson) {
            return {};
        }
        var parsed = eval("(" + argsJson + ")");
        if (parsed === null || typeof parsed !== "object") {
            return {};
        }
        return parsed;
    }

    function call(method, argsJson) {
        if (!METHODS.hasOwnProperty(method)) {
            return QPECore.toJson(fail("UNKNOWN_METHOD", "未知的调用：" + method));
        }
        var args;
        try {
            args = parseArgs(argsJson);
        } catch (parseError) {
            return QPECore.toJson(fail("BAD_ARGS", "无法解析调用参数：" + errorText(parseError)));
        }
        var result;
        try {
            result = METHODS[method](args);
        } catch (methodError) {
            result = fail("EXCEPTION", "Photoshop 脚本出错：" + errorText(methodError));
        }
        return QPECore.toJson(result);
    }

    return {
        status: status,
        preview: preview,
        exportImage: exportImage,
        estimateSize: estimateSize,
        exportPng: exportPng,
        previewSelectedLayers: previewSelectedLayers,
        exportSelectedLayers: exportSelectedLayers,
        previewCollage: previewCollage,
        exportCollage: exportCollage,
        pickFolder: pickFolder,
        openFolder: openFolder,
        call: call
    };
}());

function QPE_call(method, argsJson) {
    return QPE.call(method, argsJson);
}
