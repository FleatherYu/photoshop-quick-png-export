/*
 * Quick PNG Export - Photoshop host script (ExtendScript).
 *
 * This file is concatenated after jsx/core.jsx by scripts/build-host.mjs into
 * the shipped jsx/host.jsx that CEP loads as the panel's ScriptPath. Keeping
 * the two halves separate lets the Node test-suite exercise the pure logic
 * without a Photoshop install.
 *
 * Entry point used by the panel:
 *   QPE_call(method, argsJson) -> JSON string
 * Methods: status / preview / exportPng / pickFolder / openFolder
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
    function listPngNames(folder) {
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
                fileName: QPECore.buildFileName(prefixCheck.prefix, args.digits, 1),
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
        var files = listPngNames(folder);
        var computed = QPECore.computeExport(files, prefixCheck.prefix, args.digits, true);
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

    function convertCopyForPng(doc) {
        var warnings = [];
        var copy = doc.duplicate("QuickPNG-temp");
        try {
            if (copy.bitsPerChannel !== BitsPerChannelType.EIGHT) {
                copy.bitsPerChannel = BitsPerChannelType.EIGHT;
            }
            if (copy.mode !== DocumentMode.RGB) {
                copy.mode = DocumentMode.RGB;
            }
        } catch (conversionError) {
            try {
                copy.close(SaveOptions.DONOTSAVECHANGES);
            } catch (closeError) {
                // ignore
            }
            throw conversionError;
        }

        var originalMode = modeName(doc.mode);
        var originalDepth = bitDepthName(doc.bitsPerChannel);
        warnings[warnings.length] =
            "原文档为 " + originalMode + " / " + originalDepth +
            " 位，已在临时副本中转换为 RGB / 8 位后导出（颜色可能有偏移，源文档未被修改）";
        if (originalMode !== "RGB") {
            warnings[warnings.length] =
                "原文档没有透明通道；转换为 RGB 后透明区域会变为白色/背景色";
        }
        return {
            copy: copy,
            warnings: warnings
        };
    }

    function exportPng(args) {
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
        if (!args.folder) {
            return fail("NO_FOLDER", "请选择 PNG 输出文件夹");
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
        var maxNumber = 0;
        var existingCount = 0;
        var fileName = "";
        var fullPath = "";
        var number = 0;

        // Re-scan right before saving: the preview/predicted name is never
        // trusted for the final write.
        for (var attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
            var files = listPngNames(folder);
            var computed = QPECore.computeExport(files, prefix, digits, true);
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
            return fail("COLLISION", "目标文件已存在且无法自动分配序号：" + fileName);
        }

        var oldDialogs = app.displayDialogs;
        var copy = null;
        var warnings = [];
        var converted = false;
        try {
            app.displayDialogs = DialogModes.NO;

            var target = doc;
            if (needsConversion(doc)) {
                var prepared = convertCopyForPng(doc);
                target = prepared.copy;
                copy = prepared.copy;
                warnings = prepared.warnings;
                converted = true;
            }

            var options = new PNGSaveOptions();
            options.interlaced = false;
            target.saveAs(new File(fullPath), options, true, Extension.LOWERCASE);

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
            converted: converted,
            warnings: warnings,
            document: doc.name
        };
    }

    /* ---------- folder picker / reveal ---------- */

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
            chosen = Folder.selectDialog("请选择 PNG 输出文件夹", startFolder);
        } else {
            chosen = Folder.selectDialog("请选择 PNG 输出文件夹");
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
        exportPng: exportPng,
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
        exportPng: exportPng,
        pickFolder: pickFolder,
        openFolder: openFolder,
        call: call
    };
}());

function QPE_call(method, argsJson) {
    return QPE.call(method, argsJson);
}
