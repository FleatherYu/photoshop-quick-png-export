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
        saved: false,
        path: ""
    };
    // Fixed fake selection: two plain layers and one group. The mock skips the
    // group as fully transparent so the panel's partial-result path is visible
    // in a browser preview without touching Photoshop.
    var MOCK_SELECTION = [
        { id: 2, name: "标题文字", isGroup: false },
        { id: 3, name: "产品图", isGroup: false },
        { id: 5, name: "装饰组", isGroup: true }
    ];

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

    function mockFiles(folderPath) {
        if (!mockFileNames[folderPath]) {
            mockFileNames[folderPath] = [];
        }
        return mockFileNames[folderPath];
    }

    function mockScan(prefix, digits) {
        var escaped = prefix.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
        var matcher = new RegExp("^" + escaped + "-(\\d+)\\.png$", "i");
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
            fileName: prefix + "-" + mockPad(maxNumber + 1, digits) + ".png",
            nextNumber: maxNumber + 1,
            maxNumber: maxNumber,
            existingCount: count
        };
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
        var digits = Number(args.digits) || 2;
        if (!args.folder) {
            return {
                ok: true,
                fileName: prefix + "-" + mockPad(1, digits) + ".png",
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
        var scan = mockScan(prefix, digits);
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
        var previewResult = mockPreview(args);
        if (!previewResult.ok) {
            return previewResult;
        }
        if (!args.folder) {
            return {
                ok: false,
                code: "NO_FOLDER",
                message: "请选择 PNG 输出文件夹"
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
        return {
            ok: true,
            fileName: previewResult.fileName,
            fullPath: MOCK_FOLDER + "\\" + previewResult.fileName,
            number: previewResult.nextNumber,
            maxNumber: previewResult.maxNumber,
            existingCount: previewResult.existingCount,
            converted: false,
            warnings: [],
            document: mockDoc.name
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
            var scan = mockScan(prefix, digits);
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
                expectedFileName: prefix + "-" + mockPad(start + i, digits) + ".png"
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
        var digits = Number(args.digits) || 2;
        if (!args.folder) {
            return {
                ok: false,
                code: "NO_FOLDER",
                message: "请选择 PNG 输出文件夹"
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
        var scan = mockScan(prefix, digits);
        var successes = [];
        for (var i = 0; i < 2; i++) {
            var number = scan.nextNumber + i;
            var fileName = prefix + "-" + mockPad(number, digits) + ".png";
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
        if (method === "exportPng") {
            return mockExport(args);
        }
        if (method === "previewSelectedLayers") {
            return mockPreviewSelected(args);
        }
        if (method === "exportSelectedLayers") {
            return mockExportSelected(args);
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
            if ((method === "exportPng" || method === "exportSelectedLayers") && result.ok) {
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
