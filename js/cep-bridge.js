/*
 * CEPBridge - the panel's only door to Photoshop.
 *
 * Inside Photoshop (CEP 9) it calls the host script through
 *   window.__adobe_cep__.evalScript('QPE_call("<method>", "<json>")')
 * and parses the ASCII JSON string that jsx/host.jsx returns.
 *
 * When index.html is opened directly in a browser there is no CEP object, so
 * the bridge switches to a mock backend that keeps the same request/response
 * shapes. The mock exists for layout checks only - it never touches Photoshop
 * and never writes a real file. The panel shows a banner when it is active.
 */
var CEPBridge = (function () {
    "use strict";

    var cep = (typeof window !== "undefined" && window.__adobe_cep__)
        ? window.__adobe_cep__
        : null;

    var MOCK_FOLDER = "C:\\Users\\Public\\Pictures\\PNG 输出";
    var mockFileNames = {};
    var mockDocOpen = true;
    var mockDoc = {
        name: "示例海报.psd",
        width: 1080,
        height: 1920,
        mode: "RGB",
        bitDepth: 8,
        layerCount: 6,
        saved: true,
        path: MOCK_FOLDER
    };
    // Pre-existing files so the shared / per-format numbering strategies are
    // visibly different in the browser preview.
    mockFileNames[MOCK_FOLDER] = ["示例海报-01.png", "示例海报-03.jpg"];
    // Fixed fake selection: two plain layers and one group. The mock skips the
    // group as fully transparent so the panel's partial-result path is visible
    // in a browser preview without touching Photoshop.
    var MOCK_SELECTION = [
        { id: 2, name: "标题文字", isGroup: false },
        { id: 3, name: "产品图", isGroup: false },
        { id: 5, name: "装饰组", isGroup: true }
    ];
    // Fixed fake collage selection: four selected objects, three exportable and
    // one clipping-mask dependent layer that the host skips (so the collage
    // partial result path is visible in a browser preview without touching
    // Photoshop). Three valid objects make the default grid 2 columns x 2 rows.
    var MOCK_COLLAGE_SELECTION = [
        { id: 2, name: "标题文字", isGroup: false },
        { id: 3, name: "产品图", isGroup: false },
        { id: 5, name: "装饰组", isGroup: true }
    ];
    var MOCK_COLLAGE_SKIPPED = [
        {
            id: 9,
            name: "剪贴高光",
            isGroup: false,
            code: "CLIPPING_DEPENDENCY",
            message: "依赖下方图层（剪贴蒙版），已跳过"
        }
    ];
    var MOCK_COLLAGE_SELECTION_KEY = "mock-collage-selection";

    /* ---------- public API ---------- */

    function call(method, args, done) {
        var callback = (typeof done === "function") ? done : function () {};
        var payload = args || {};
        if (cep) {
            realCall(method, payload, callback);
        } else {
            mockCall(method, payload, callback);
        }
    }

    function isMock() {
        return !cep;
    }

    function applyTheme() {
        var light = false;
        if (cep) {
            try {
                var environment = JSON.parse(cep.getHostEnvironment());
                var skin = environment && environment.appSkinInfo;
                var color = skin && skin.panelBackgroundColor && skin.panelBackgroundColor.color;
                if (color) {
                    var luminance = (0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue) / 255;
                    light = luminance > 0.6;
                }
            } catch (error) {
                light = false;
            }
        }
        document.body.classList.remove("theme-dark", "theme-light");
        document.body.classList.add(light ? "theme-light" : "theme-dark");
    }

    /* ---------- real CEP backend ---------- */

    function hex4(code) {
        var hex = code.toString(16);
        while (hex.length < 4) {
            hex = "0" + hex;
        }
        return hex.toUpperCase();
    }

    function quoteForEval(jsonText) {
        // The JSON text is embedded into a double-quoted ExtendScript string.
        // Everything outside printable ASCII is escaped so the expression that
        // crosses the evalScript boundary is pure ASCII: Chinese prefixes and
        // U+2028/U+2029 cannot be mangled by the host's text encoding.
        var out = "";
        for (var i = 0; i < jsonText.length; i++) {
            var ch = jsonText.charAt(i);
            var code = jsonText.charCodeAt(i);
            if (ch === "\\") {
                out += "\\\\";
            } else if (ch === '"') {
                out += '\\"';
            } else if (code < 32 || code > 126) {
                out += "\\u" + hex4(code);
            } else {
                out += ch;
            }
        }
        return out;
    }

    function bridgeError(code, message) {
        return {
            ok: false,
            code: code,
            message: message
        };
    }

    function realCall(method, args, callback) {
        var argsJson;
        try {
            argsJson = JSON.stringify(args);
        } catch (serializeError) {
            callback(bridgeError("BAD_ARGS", "无法序列化调用参数"));
            return;
        }
        var expression = 'QPE_call("' + method + '", "' + quoteForEval(argsJson) + '")';
        try {
            cep.evalScript(expression, function (raw) {
                if (typeof raw !== "string" || raw.length === 0) {
                    callback(bridgeError("NO_RESPONSE", "Photoshop 没有返回数据"));
                    return;
                }
                if (raw === "EvalScript error.") {
                    callback(bridgeError("EVAL_ERROR", "无法执行 Photoshop 脚本（EvalScript error）"));
                    return;
                }
                var parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch (parseError) {
                    callback(bridgeError("BAD_RESPONSE", "无法解析 Photoshop 返回的数据"));
                    return;
                }
                callback(parsed);
            });
        } catch (callError) {
            callback(bridgeError("BRIDGE_ERROR", "调用 Photoshop 失败：" + String(callError)));
        }
    }

    /* ---------- mock backend (browser preview only) ---------- */

    var MOCK_DELAY_MS = 60;

    function mockPad(number, digits) {
        var text = String(number);
        while (text.length < digits) {
            text = "0" + text;
        }
        return text;
    }

    function mockFormat(args) {
        var value = String(args.format || "").toLowerCase();
        return (value === "jpg" || value === "jpeg") ? "jpg" : "png";
    }

    function mockNumbering(args) {
        return String(args.numbering || "") === "separate" ? "separate" : "shared";
    }

    function mockExtension(format) {
        return format === "jpg" ? ".jpg" : ".png";
    }

    function mockFiles(folderPath) {
        if (!mockFileNames[folderPath]) {
            mockFileNames[folderPath] = [];
        }
        return mockFileNames[folderPath];
    }

    // Mirrors QPECore.buildMatcher: shared counts PNG and JPG/JPEG together,
    // separate counts only the extension of the format being exported.
    function mockExtensionPattern(format, numbering) {
        if (numbering === "shared") {
            return "png|jpe?g";
        }
        return format === "jpg" ? "jpe?g" : "png";
    }

    function mockScan(prefix, digits, format, numbering) {
        var escaped = prefix.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
        var matcher = new RegExp("^" + escaped + "-(\\d+)\\.(" +
            mockExtensionPattern(format, numbering) + ")$", "i");
        var names = mockFiles(MOCK_FOLDER);
        var maxNumber = 0;
        var count = 0;
        for (var i = 0; i < names.length; i++) {
            var match = matcher.exec(names[i]);
            if (match) {
                count = count + 1;
                var number = parseInt(match[1], 10);
                if (number > maxNumber) {
                    maxNumber = number;
                }
            }
        }
        return {
            fileName: prefix + "-" + mockPad(maxNumber + 1, digits) + mockExtension(format),
            nextNumber: maxNumber + 1,
            maxNumber: maxNumber,
            existingCount: count
        };
    }

    function mockQualityError(args) {
        if (mockFormat(args) !== "jpg") {
            return null;
        }
        var quality = Number(args.quality);
        if (!isFinite(quality) || Math.floor(quality) !== quality || quality < 0 || quality > 12) {
            return {
                ok: false,
                code: "BAD_QUALITY",
                message: "JPG 质量必须是 0–12 的整数"
            };
        }
        return null;
    }

    function mockPreview(args) {
        var prefix = String(args.prefix || "").replace(/^\s+|\s+$/g, "");
        if (!prefix) {
            return {
                ok: false,
                code: "EMPTY",
                message: "请输入文件名前缀"
            };
        }
        var format = mockFormat(args);
        var numbering = mockNumbering(args);
        var digits = Number(args.digits) || 2;
        if (!args.folder) {
            return {
                ok: true,
                fileName: prefix + "-" + mockPad(1, digits) + mockExtension(format),
                nextNumber: 1,
                maxNumber: 0,
                existingCount: 0,
                folderAvailable: false
            };
        }
        if (args.folder !== MOCK_FOLDER) {
            return {
                ok: false,
                code: "FOLDER_MISSING",
                message: "输出文件夹不存在或无法访问：" + args.folder
            };
        }
        var scan = mockScan(prefix, digits, format, numbering);
        scan.ok = true;
        scan.folderAvailable = true;
        return scan;
    }

    function mockExport(args) {
        if (!mockDocOpen) {
            return {
                ok: false,
                code: "NO_DOCUMENT",
                message: "请先打开一个 Photoshop 文档"
            };
        }
        var qualityResult = mockQualityError(args);
        if (qualityResult) {
            return qualityResult;
        }
        var previewResult = mockPreview(args);
        if (!previewResult.ok) {
            return previewResult;
        }
        if (!args.folder) {
            return {
                ok: false,
                code: "NO_FOLDER",
                message: "请选择输出文件夹"
            };
        }
        if (args.folder !== MOCK_FOLDER) {
            return {
                ok: false,
                code: "FOLDER_MISSING",
                message: "输出文件夹不存在或无法访问：" + args.folder
            };
        }
        mockFiles(MOCK_FOLDER).push(previewResult.fileName);
        mockDoc.saved = true;
        return {
            ok: true,
            fileName: previewResult.fileName,
            fullPath: MOCK_FOLDER + "\\" + previewResult.fileName,
            number: previewResult.nextNumber,
            maxNumber: previewResult.maxNumber,
            existingCount: previewResult.existingCount,
            format: mockFormat(args),
            quality: mockFormat(args) === "jpg" ? Number(args.quality) : null,
            converted: false,
            warnings: [],
            document: mockDoc.name
        };
    }

    // Deterministic estimate so the panel's byte formatting is visible in a
    // browser preview: PNG is large, JPG grows with the quality setting.
    function mockEstimate(args) {
        if (!mockDocOpen) {
            return {
                ok: false,
                code: "NO_DOCUMENT",
                message: "请先打开一个 Photoshop 文档"
            };
        }
        var qualityResult = mockQualityError(args);
        if (qualityResult) {
            return qualityResult;
        }
        var format = mockFormat(args);
        var pixels = mockDoc.width * mockDoc.height;
        var bytes;
        if (format === "jpg") {
            bytes = Math.round(pixels * (0.02 + (Number(args.quality) || 10) * 0.016));
        } else {
            bytes = Math.round(pixels * 1.3);
        }
        return {
            ok: true,
            format: format,
            quality: format === "jpg" ? Number(args.quality) : null,
            bytes: bytes
        };
    }

    // Returns the fake selection with expected names, mirroring the host's
    // previewSelectedLayers payload.
    function mockPreviewSelected(args) {
        if (!mockDocOpen) {
            return {
                ok: false,
                code: "NO_DOCUMENT",
                message: "请先打开一个 Photoshop 文档"
            };
        }
        var prefix = String(args.prefix || "").replace(/^\s+|\s+$/g, "");
        if (!prefix) {
            return {
                ok: false,
                code: "EMPTY",
                message: "请输入文件名前缀"
            };
        }
        var qualityResult = mockQualityError(args);
        if (qualityResult) {
            return qualityResult;
        }
        var format = mockFormat(args);
        var numbering = mockNumbering(args);
        var digits = Number(args.digits) || 2;
        var folderAvailable = false;
        var start = 1;
        var maxNumber = 0;
        var existingCount = 0;
        if (args.folder) {
            if (args.folder !== MOCK_FOLDER) {
                return {
                    ok: false,
                    code: "FOLDER_MISSING",
                    message: "输出文件夹不存在或无法访问：" + args.folder
                };
            }
            var scan = mockScan(prefix, digits, format, numbering);
            start = scan.nextNumber;
            maxNumber = scan.maxNumber;
            existingCount = scan.existingCount;
            folderAvailable = true;
        }
        var items = [];
        for (var i = 0; i < MOCK_SELECTION.length; i++) {
            items[items.length] = {
                id: MOCK_SELECTION[i].id,
                name: MOCK_SELECTION[i].name,
                isGroup: MOCK_SELECTION[i].isGroup,
                expectedFileName: prefix + "-" + mockPad(start + i, digits) + mockExtension(format)
            };
        }
        return {
            ok: true,
            document: mockDoc.name,
            selectionKey: "mock-selection",
            selectedCount: MOCK_SELECTION.length,
            count: items.length,
            items: items,
            skipped: [],
            folderAvailable: folderAvailable,
            startNumber: start,
            maxNumber: maxNumber,
            existingCount: existingCount,
            format: format,
            warnings: []
        };
    }

    function mockExportSelected(args) {
        if (!mockDocOpen) {
            return {
                ok: false,
                code: "NO_DOCUMENT",
                message: "请先打开一个 Photoshop 文档"
            };
        }
        var prefix = String(args.prefix || "").replace(/^\s+|\s+$/g, "");
        if (!prefix) {
            return {
                ok: false,
                code: "EMPTY",
                message: "请输入文件名前缀"
            };
        }
        var qualityResult = mockQualityError(args);
        if (qualityResult) {
            return qualityResult;
        }
        var format = mockFormat(args);
        var numbering = mockNumbering(args);
        var digits = Number(args.digits) || 2;
        if (!args.folder) {
            return {
                ok: false,
                code: "NO_FOLDER",
                message: "请选择输出文件夹"
            };
        }
        if (args.folder !== MOCK_FOLDER) {
            return {
                ok: false,
                code: "FOLDER_MISSING",
                message: "输出文件夹不存在或无法访问：" + args.folder
            };
        }
        if (args.selectionKey && args.selectionKey !== "mock-selection") {
            return {
                ok: false,
                code: "SELECTION_CHANGED",
                message: "当前文档或选中的图层已发生变化，请刷新选择后重试"
            };
        }
        var scan = mockScan(prefix, digits, format, numbering);
        var successes = [];
        for (var i = 0; i < 2; i++) {
            var number = scan.nextNumber + i;
            var fileName = prefix + "-" + mockPad(number, digits) + mockExtension(format);
            successes[successes.length] = {
                id: MOCK_SELECTION[i].id,
                name: MOCK_SELECTION[i].name,
                isGroup: MOCK_SELECTION[i].isGroup,
                number: number,
                fileName: fileName,
                fullPath: MOCK_FOLDER + "\\" + fileName
            };
            mockFiles(MOCK_FOLDER).push(fileName);
        }
        var skipped = [{
            id: MOCK_SELECTION[2].id,
            name: MOCK_SELECTION[2].name,
            isGroup: MOCK_SELECTION[2].isGroup,
            code: "EMPTY",
            message: "完全透明，已跳过（不占编号）"
        }];
        mockDoc.saved = true;
        return {
            ok: true,
            code: "OK",
            message: "批量导出完成：成功 2 张，跳过 1 项",
            completed: true,
            total: MOCK_SELECTION.length,
            successes: successes,
            skipped: skipped,
            failed: null,
            unprocessedCount: 0,
            converted: false,
            warnings: [],
            cleanupErrors: [],
            document: mockDoc.name,
            format: format,
            counts: {
                exported: 2,
                skipped: 1,
                failed: 0,
                unprocessed: 0,
                total: 3,
                allSkipped: false
            }
        };
    }

    // Mirrors the host's previewCollage payload: the effective object count,
    // the grid the panel will show, and the document size every cell uses.
    function mockPreviewCollage(args) {
        if (!mockDocOpen) {
            return {
                ok: false,
                code: "NO_DOCUMENT",
                message: "请先打开一个 Photoshop 文档"
            };
        }
        var prefix = String(args.prefix || "").replace(/^\s+|\s+$/g, "");
        if (!prefix) {
            return {
                ok: false,
                code: "EMPTY",
                message: "请输入文件名前缀"
            };
        }
        var qualityResult = mockQualityError(args);
        if (qualityResult) {
            return qualityResult;
        }
        var format = mockFormat(args);
        var numbering = mockNumbering(args);
        var digits = Number(args.digits) || 2;
        var folderAvailable = false;
        var start = 1;
        var maxNumber = 0;
        var existingCount = 0;
        if (args.folder) {
            if (args.folder !== MOCK_FOLDER) {
                return {
                    ok: false,
                    code: "FOLDER_MISSING",
                    message: "输出文件夹不存在或无法访问：" + args.folder
                };
            }
            var scan = mockScan(prefix, digits, format, numbering);
            start = scan.nextNumber;
            maxNumber = scan.maxNumber;
            existingCount = scan.existingCount;
            folderAvailable = true;
        }
        var items = [];
        for (var i = 0; i < MOCK_COLLAGE_SELECTION.length; i++) {
            items[items.length] = {
                id: MOCK_COLLAGE_SELECTION[i].id,
                name: MOCK_COLLAGE_SELECTION[i].name,
                isGroup: MOCK_COLLAGE_SELECTION[i].isGroup
            };
        }
        return {
            ok: true,
            document: mockDoc.name,
            documentWidth: mockDoc.width,
            documentHeight: mockDoc.height,
            selectionKey: MOCK_COLLAGE_SELECTION_KEY,
            selectedCount: MOCK_COLLAGE_SELECTION.length + MOCK_COLLAGE_SKIPPED.length,
            count: items.length,
            items: items,
            skipped: MOCK_COLLAGE_SKIPPED,
            folderAvailable: folderAvailable,
            fileName: prefix + "-" + mockPad(start, digits) + mockExtension(format),
            startNumber: start,
            maxNumber: maxNumber,
            existingCount: existingCount,
            format: format,
            warnings: []
        };
    }

    // Mirrors the host's collage geometry rules closely enough for the browser
    // preview: effective columns are clamped to the object count, the target
    // size keeps the original aspect ratio, and upsizing is rejected.
    function mockCollageColumns(args, count) {
        var auto = Math.ceil(Math.sqrt(count));
        var raw = args.columns;
        var columns;
        if (raw === null || raw === undefined || String(raw).replace(/^\s+|\s+$/g, "") === "") {
            columns = auto;
        } else {
            columns = Math.round(Number(raw));
        }
        if (!isFinite(columns) || columns < 1) {
            columns = auto;
        }
        if (columns > count) {
            columns = count;
        }
        return columns;
    }

    function mockCollageTarget(args, originalWidth, originalHeight) {
        var widthText = (args.targetWidth === null || args.targetWidth === undefined)
            ? ""
            : String(args.targetWidth).replace(/^\s+|\s+$/g, "");
        var heightText = (args.targetHeight === null || args.targetHeight === undefined)
            ? ""
            : String(args.targetHeight).replace(/^\s+|\s+$/g, "");
        if (!widthText && !heightText) {
            return {
                ok: true,
                width: originalWidth,
                height: originalHeight
            };
        }
        var width = null;
        var height = null;
        if (widthText) {
            width = Math.round(Number(widthText));
            if (!isFinite(width) || width < 1) {
                return {
                    ok: false,
                    code: "TARGET_INVALID",
                    message: "目标尺寸必须是大于 0 的整数（至少 1 px）。"
                };
            }
            if (width > originalWidth) {
                return {
                    ok: false,
                    code: "TARGET_UPSCALE",
                    message: "目标尺寸不能大于原始拼图尺寸（" + originalWidth + " × " +
                        originalHeight + " px），不支持放大。"
                };
            }
            height = Math.max(1, Math.round(width * originalHeight / originalWidth));
            return {
                ok: true,
                width: width,
                height: height
            };
        }
        height = Math.round(Number(heightText));
        if (!isFinite(height) || height < 1) {
            return {
                ok: false,
                code: "TARGET_INVALID",
                message: "目标尺寸必须是大于 0 的整数（至少 1 px）。"
            };
        }
        if (height > originalHeight) {
            return {
                ok: false,
                code: "TARGET_UPSCALE",
                message: "目标尺寸不能大于原始拼图尺寸（" + originalWidth + " × " +
                    originalHeight + " px），不支持放大。"
            };
        }
        width = Math.max(1, Math.round(height * originalWidth / originalHeight));
        return {
            ok: true,
            width: width,
            height: height
        };
    }

    function mockExportCollage(args) {
        if (!mockDocOpen) {
            return {
                ok: false,
                code: "NO_DOCUMENT",
                message: "请先打开一个 Photoshop 文档"
            };
        }
        var prefix = String(args.prefix || "").replace(/^\s+|\s+$/g, "");
        if (!prefix) {
            return {
                ok: false,
                code: "EMPTY",
                message: "请输入文件名前缀"
            };
        }
        var qualityResult = mockQualityError(args);
        if (qualityResult) {
            return qualityResult;
        }
        if (!args.folder) {
            return {
                ok: false,
                code: "NO_FOLDER",
                message: "请选择输出文件夹"
            };
        }
        if (args.folder !== MOCK_FOLDER) {
            return {
                ok: false,
                code: "FOLDER_MISSING",
                message: "输出文件夹不存在或无法访问：" + args.folder
            };
        }
        if (args.selectionKey && args.selectionKey !== MOCK_COLLAGE_SELECTION_KEY) {
            return {
                ok: false,
                code: "SELECTION_CHANGED",
                message: "当前文档或选中的图层已发生变化，请刷新选择后重试"
            };
        }
        var count = MOCK_COLLAGE_SELECTION.length;
        var columns = mockCollageColumns(args, count);
        var rows = Math.ceil(count / columns);
        var originalWidth = columns * mockDoc.width;
        var originalHeight = rows * mockDoc.height;
        var target = mockCollageTarget(args, originalWidth, originalHeight);
        if (!target.ok) {
            return target;
        }
        var format = mockFormat(args);
        var numbering = mockNumbering(args);
        var digits = Number(args.digits) || 2;
        var scan = mockScan(prefix, digits, format, numbering);
        var fileName = prefix + "-" + mockPad(scan.nextNumber, digits) + mockExtension(format);
        // The mock intentionally does not touch mockFileNames here: the file is
        // never written, and pushing it would desync the other mock previews.
        mockDoc.saved = true;
        var placed = [];
        for (var i = 0; i < MOCK_COLLAGE_SELECTION.length; i++) {
            placed[placed.length] = {
                id: MOCK_COLLAGE_SELECTION[i].id,
                name: MOCK_COLLAGE_SELECTION[i].name,
                isGroup: MOCK_COLLAGE_SELECTION[i].isGroup,
                cellColumn: i % columns + 1,
                cellRow: Math.floor(i / columns) + 1
            };
        }
        return {
            ok: true,
            code: "OK",
            message: "拼图导出完成：放入 " + count + " 个对象，跳过 " +
                MOCK_COLLAGE_SKIPPED.length + " 项",
            completed: true,
            fileName: fileName,
            fullPath: MOCK_FOLDER + "\\" + fileName,
            number: scan.nextNumber,
            maxNumber: scan.maxNumber,
            existingCount: scan.existingCount,
            format: format,
            quality: format === "jpg" ? Number(args.quality) : null,
            width: target.width,
            height: target.height,
            originalWidth: originalWidth,
            originalHeight: originalHeight,
            columns: columns,
            rows: rows,
            placedCount: count,
            placed: placed,
            targetWidth: target.width,
            targetHeight: target.height,
            total: MOCK_COLLAGE_SELECTION.length + MOCK_COLLAGE_SKIPPED.length,
            selectedCount: MOCK_COLLAGE_SELECTION.length + MOCK_COLLAGE_SKIPPED.length,
            skipped: MOCK_COLLAGE_SKIPPED,
            converted: false,
            warnings: [],
            document: mockDoc.name
        };
    }

    function mockSuggestPrefix(name) {
        var base = String(name).replace(/\.[A-Za-z0-9]{1,5}$/, "");
        var cleaned = base.replace(/[\\/:*?"<>|]/g, "").replace(/^\s+|\s+$/g, "");
        return {
            prefix: cleaned,
            changed: cleaned !== base
        };
    }

    function mockDispatch(method, args) {
        if (method === "status") {
            if (!mockDocOpen) {
                return {
                    ok: true,
                    hasDocument: false,
                    message: "当前没有打开任何 Photoshop 文档"
                };
            }
            var suggestion = mockSuggestPrefix(mockDoc.name);
            return {
                ok: true,
                hasDocument: true,
                name: mockDoc.name,
                width: mockDoc.width,
                height: mockDoc.height,
                mode: mockDoc.mode,
                bitDepth: mockDoc.bitDepth,
                layerCount: mockDoc.layerCount,
                saved: mockDoc.saved,
                path: mockDoc.path,
                suggestedPrefix: suggestion.prefix,
                suggestedAdjusted: suggestion.changed
            };
        }
        if (method === "preview") {
            return mockPreview(args);
        }
        if (method === "exportImage") {
            return mockExport(args);
        }
        if (method === "exportPng") {
            args.format = "png";
            return mockExport(args);
        }
        if (method === "estimateSize") {
            return mockEstimate(args);
        }
        if (method === "previewSelectedLayers") {
            return mockPreviewSelected(args);
        }
        if (method === "exportSelectedLayers") {
            return mockExportSelected(args);
        }
        if (method === "previewCollage") {
            return mockPreviewCollage(args);
        }
        if (method === "exportCollage") {
            return mockExportCollage(args);
        }
        if (method === "pickFolder") {
            mockFiles(MOCK_FOLDER);
            return {
                ok: true,
                path: MOCK_FOLDER
            };
        }
        if (method === "openFolder") {
            return {
                ok: true,
                path: args.path || MOCK_FOLDER
            };
        }
        return {
            ok: false,
            code: "UNKNOWN_METHOD",
            message: "未知的调用：" + method
        };
    }

    function mockCall(method, args, callback) {
        window.setTimeout(function () {
            var result = mockDispatch(method, args);
            if ((method === "exportPng" || method === "exportImage" ||
                method === "exportCollage" ||
                method === "exportSelectedLayers") && result.ok) {
                mockDoc.saved = true;
            }
            callback(result);
        }, MOCK_DELAY_MS);
    }

    return {
        call: call,
        isMock: isMock,
        applyTheme: applyTheme
    };
}());
