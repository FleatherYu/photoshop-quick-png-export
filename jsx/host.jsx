/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built from jsx/core.jsx + jsx/host-body.jsx by scripts/build-host.mjs.
 * Regenerate with: node scripts/build-host.mjs
 */

/*
 * Quick PNG Export - core naming / sequencing logic.
 *
 * This file is intentionally written in ES3 style (no let/const, no arrow
 * functions, no Array.prototype.forEach/map/filter, no String.prototype.trim)
 * because it runs inside Photoshop ExtendScript. It has no dependency on the
 * Photoshop DOM, so it is also loaded by the Node test-suite as the single
 * source of truth for the file-name rules.
 *
 * Public API (global QPECore):
 *   validatePrefix(raw)                       -> {ok, prefix} | {ok:false, code, message, chars}
 *   isValidDigits(digits)                     -> boolean
 *   padNumber(number, digits)                 -> string (minimum width, never truncated)
 *   buildFileName(prefix, digits, number)     -> "prefix-01.png"
 *   buildMatcher(prefix, caseInsensitive)     -> RegExp ^prefix-(\d+)\.png$
 *   matchSequence(fileName, prefix, caseInsensitive) -> number | null
 *   computeNext(fileNames, prefix, caseInsensitive)  -> {nextNumber, maxNumber, existingCount}
 *   computeExport(fileNames, prefix, digits, caseInsensitive) -> {nextNumber, maxNumber, existingCount, fileName}
 *   escapeRegExp(text)                        -> string
 *   derivePrefixFromDocument(docName)         -> {prefix, changed, documentName}
 *   toJson(value)                             -> ASCII-only JSON string (safe for evalScript)
 */

var QPECore = (function () {
    var ILLEGAL_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];
    var DOCUMENT_EXTENSIONS = ["psd", "psb", "png", "jpg", "jpeg", "gif", "bmp",
        "tif", "tiff", "webp", "pdf"];
    var MAX_PREFIX_LENGTH = 120;
    var VALID_DIGITS = [1, 2, 3];

    /* ---------- helpers ---------- */

    function trimText(text) {
        return String(text).replace(/^[\s\u3000\u00A0]+|[\s\u3000\u00A0]+$/g, "");
    }

    function indexOfValue(list, value) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] === value) {
                return i;
            }
        }
        return -1;
    }

    function isString(value) {
        return typeof value === "string";
    }

    function padNumber(value, digits) {
        var number = parseInt(String(value), 10);
        if (!isFinite(number) || number < 0) {
            return "";
        }
        var text = String(number);
        while (text.length < digits) {
            text = "0" + text;
        }
        return text;
    }

    function escapeRegExp(text) {
        var special = "\\^$.*+?()[]{}|";
        var out = "";
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            if (special.indexOf(ch) !== -1) {
                out += "\\";
            }
            out += ch;
        }
        return out;
    }

    function buildMatcher(prefix, caseInsensitive) {
        var flags = (caseInsensitive === false) ? "" : "i";
        return new RegExp("^" + escapeRegExp(prefix) + "-(\\d+)\\.png$", flags);
    }

    function matchSequence(fileName, prefix, caseInsensitive) {
        if (!isString(fileName) || !isString(prefix)) {
            return null;
        }
        // ExtendScript percent-encodes non-ASCII File.name values (verified on
        // Photoshop CC 2019), so matching runs on the decoded, readable name.
        var matched = buildMatcher(prefix, caseInsensitive).exec(decodePercentName(fileName));
        if (!matched) {
            return null;
        }
        var number = parseInt(matched[1], 10);
        if (!isFinite(number)) {
            return null;
        }
        return number;
    }

    /* ---------- document name -> prefix ---------- */

    function stripDocumentExtension(name) {
        var text = trimText(name);
        var dot = text.lastIndexOf(".");
        if (dot > 0) {
            var ext = text.substring(dot + 1).toLowerCase();
            // Strip a known document extension only, never a dot that is part
            // of the document name itself (e.g. "poster.v2").
            if (indexOfValue(DOCUMENT_EXTENSIONS, ext) !== -1) {
                return text.substring(0, dot);
            }
        }
        return text;
    }

    // Turns a Photoshop document name into a default prefix:
    //   "2610-10-\u72fc\u573a\u666f.psd" -> "2610-10-\u72fc\u573a\u666f"
    // Windows-illegal characters are removed (the panel explains that it did)
    // instead of being silently replaced with something else.
    function derivePrefixFromDocument(docName) {
        var raw = (docName === null || docName === undefined) ? "" : String(docName);
        var base = stripDocumentExtension(raw);
        var cleaned = "";
        for (var i = 0; i < base.length; i++) {
            var ch = base.charAt(i);
            var code = base.charCodeAt(i);
            if (code < 32 || indexOfValue(ILLEGAL_CHARS, ch) !== -1) {
                continue;
            }
            cleaned += ch;
        }
        cleaned = trimText(cleaned);
        while (cleaned.length > 0 && cleaned.charAt(cleaned.length - 1) === ".") {
            cleaned = trimText(cleaned.substring(0, cleaned.length - 1));
        }
        if (cleaned.length > MAX_PREFIX_LENGTH) {
            cleaned = trimText(cleaned.substring(0, MAX_PREFIX_LENGTH));
        }
        return {
            prefix: cleaned,
            changed: cleaned !== base,
            documentName: raw
        };
    }

    /* ---------- prefix validation ---------- */

    function validatePrefix(raw) {
        var prefix = (raw === null || raw === undefined) ? "" : trimText(raw);

        if (prefix.length === 0) {
            return {
                ok: false,
                code: "EMPTY",
                message: "\u8bf7\u8f93\u5165\u6587\u4ef6\u540d\u524d\u7f00"
            };
        }

        var foundIllegal = [];
        for (var i = 0; i < prefix.length; i++) {
            var ch = prefix.charAt(i);
            var code = prefix.charCodeAt(i);
            if (code < 32) {
                if (indexOfValue(foundIllegal, "\u63a7\u5236\u5b57\u7b26") === -1) {
                    foundIllegal.push("\u63a7\u5236\u5b57\u7b26");
                }
            } else if (indexOfValue(ILLEGAL_CHARS, ch) !== -1) {
                if (indexOfValue(foundIllegal, ch) === -1) {
                    foundIllegal.push(ch);
                }
            }
        }
        if (foundIllegal.length > 0) {
            return {
                ok: false,
                code: "ILLEGAL_CHARS",
                chars: foundIllegal,
                message: "\u524d\u7f00\u5305\u542b\u6587\u4ef6\u540d\u4e0d\u5141\u8bb8\u7684\u5b57\u7b26\uff1a" + foundIllegal.join(" ") +
                    "\uff08Windows \u6587\u4ef6\u540d\u4e0d\u80fd\u4f7f\u7528 \\ / : * ? \" < > |\uff09"
            };
        }

        if (prefix.charAt(prefix.length - 1) === ".") {
            return {
                ok: false,
                code: "TRAILING_DOT",
                message: "\u524d\u7f00\u4e0d\u80fd\u4ee5\u53e5\u70b9\u7ed3\u5c3e\uff08\u53e5\u70b9\u7ed3\u5c3e\u5728 Windows \u4e0a\u4f1a\u88ab\u7cfb\u7edf\u53bb\u6389\uff09"
            };
        }

        if (prefix.length > MAX_PREFIX_LENGTH) {
            return {
                ok: false,
                code: "TOO_LONG",
                message: "\u524d\u7f00\u8fc7\u957f\uff08\u6700\u591a " + MAX_PREFIX_LENGTH + " \u4e2a\u5b57\u7b26\uff09"
            };
        }

        return {
            ok: true,
            prefix: prefix
        };
    }

    /* ---------- digits ---------- */

    function isValidDigits(digits) {
        var value = parseInt(String(digits), 10);
        return indexOfValue(VALID_DIGITS, value) !== -1;
    }

    /* ---------- sequencing ---------- */

    function buildFileName(prefix, digits, number) {
        return prefix + "-" + padNumber(number, digits) + ".png";
    }

    function computeNext(fileNames, prefix, caseInsensitive) {
        var maxNumber = 0;
        var existingCount = 0;
        var names = fileNames || [];
        for (var i = 0; i < names.length; i++) {
            var number = matchSequence(names[i], prefix, caseInsensitive);
            if (number !== null) {
                existingCount++;
                if (number > maxNumber) {
                    maxNumber = number;
                }
            }
        }
        return {
            nextNumber: maxNumber + 1,
            maxNumber: maxNumber,
            existingCount: existingCount
        };
    }

    function computeExport(fileNames, prefix, digits, caseInsensitive) {
        var next = computeNext(fileNames, prefix, caseInsensitive);
        return {
            nextNumber: next.nextNumber,
            maxNumber: next.maxNumber,
            existingCount: next.existingCount,
            fileName: buildFileName(prefix, digits, next.nextNumber)
        };
    }

    /* ---------- JSON (ASCII only) ---------- */

    function hex4(code) {
        var hex = code.toString(16);
        while (hex.length < 4) {
            hex = "0" + hex;
        }
        return hex.toUpperCase();
    }

    // instanceof Array fails across realms (Node vm context vs the caller) and
    // is fragile in some ExtendScript hosts; the toString tag always works.
    function isArrayValue(value) {
        return Object.prototype.toString.call(value) === "[object Array]";
    }

    function hasOwn(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function quoteString(text) {
        var out = "\"";
        for (var i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            var code = text.charCodeAt(i);
            if (ch === "\"") {
                out += "\\\"";
            } else if (ch === "\\") {
                out += "\\\\";
            } else if (ch === "\b") {
                out += "\\b";
            } else if (ch === "\f") {
                out += "\\f";
            } else if (ch === "\n") {
                out += "\\n";
            } else if (ch === "\r") {
                out += "\\r";
            } else if (ch === "\t") {
                out += "\\t";
            } else if (code < 32 || code > 126) {
                // Keep the payload pure ASCII so it survives every
                // ExtendScript/evalScript encoding hop on Windows.
                out += "\\u" + hex4(code);
            } else {
                out += ch;
            }
        }
        return out + "\"";
    }

    function toJson(value) {
        var type = typeof value;
        var i;

        if (value === null || value === undefined) {
            return "null";
        }
        if (type === "string") {
            return quoteString(value);
        }
        if (type === "number") {
            if (!isFinite(value)) {
                return "null";
            }
            return String(value);
        }
        if (type === "boolean") {
            return value ? "true" : "false";
        }
        if (isArrayValue(value)) {
            var items = [];
            for (i = 0; i < value.length; i++) {
                items[items.length] = toJson(value[i]);
            }
            return "[" + items.join(",") + "]";
        }
        if (type === "object") {
            var pairs = [];
            for (var key in value) {
                if (!hasOwn(value, key)) {
                    continue;
                }
                if (typeof value[key] === "undefined" || typeof value[key] === "function") {
                    continue;
                }
                pairs[pairs.length] = quoteString(key) + ":" + toJson(value[key]);
            }
            return "{" + pairs.join(",") + "}";
        }
        return "null";
    }

    /* ---------- exports ---------- */

    // ExtendScript's File.name percent-encodes non-ASCII characters as UTF-8
    // (verified in Photoshop CC 2019: a file named "QPE-\u6d4b\u8bd5-05.png" reports
    // "QPE-%E6%B5%8B%E8%AF%95-05.png"). Decoding before matching keeps Chinese
    // prefixes working. A literal "%" that is not a valid escape sequence
    // throws inside decodeURIComponent; then the raw name is returned.
    function decodePercentName(name) {
        var text = String(name);
        if (text.indexOf("%") === -1) {
            return text;
        }
        try {
            if (typeof decodeURIComponent === "function") {
                return decodeURIComponent(text);
            }
        } catch (error) {
            // Not a valid percent-encoding: keep the raw name.
        }
        return text;
    }

    return {
        ILLEGAL_CHARS: ILLEGAL_CHARS,
        MAX_PREFIX_LENGTH: MAX_PREFIX_LENGTH,
        trimText: trimText,
        decodePercentName: decodePercentName,
        derivePrefixFromDocument: derivePrefixFromDocument,
        stripDocumentExtension: stripDocumentExtension,
        validatePrefix: validatePrefix,
        isValidDigits: isValidDigits,
        padNumber: padNumber,
        buildFileName: buildFileName,
        buildMatcher: buildMatcher,
        matchSequence: matchSequence,
        computeNext: computeNext,
        computeExport: computeExport,
        escapeRegExp: escapeRegExp,
        toJson: toJson
    };
}());

if (typeof module !== "undefined" && module.exports) {
    // Node test harness convenience; ExtendScript ignores this branch.
    module.exports = QPECore;
}

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
            return "\u672a\u77e5\u9519\u8bef";
        }
        var text = error.message ? String(error.message) : String(error);
        if (error.line) {
            text += "\uff08\u884c " + error.line + "\uff09";
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
            message: "\u8f93\u51fa\u6587\u4ef6\u5939\u4e0d\u53ef\u5199\u5165\uff1a" + folder.fsName
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
                return "\u7070\u5ea6";
            }
            if (mode === DocumentMode.LAB) {
                return "Lab";
            }
            if (mode === DocumentMode.BITMAP) {
                return "\u4f4d\u56fe";
            }
            if (mode === DocumentMode.INDEXED) {
                return "\u7d22\u5f15\u8272";
            }
            if (mode === DocumentMode.DUOTONE) {
                return "\u53cc\u8272\u8c03";
            }
            if (mode === DocumentMode.MULTICHANNEL) {
                return "\u591a\u901a\u9053";
            }
        } catch (error) {
            return "\u672a\u77e5";
        }
        return "\u672a\u77e5";
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
                message: "\u5f53\u524d\u6ca1\u6709\u6253\u5f00\u4efb\u4f55 Photoshop \u6587\u6863"
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
            return fail("BAD_DIGITS", "\u5e8f\u53f7\u4f4d\u6570\u53ea\u80fd\u662f 1\u30012 \u6216 3 \u4f4d");
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
            return fail("FOLDER_MISSING", "\u8f93\u51fa\u6587\u4ef6\u5939\u4e0d\u5b58\u5728\u6216\u65e0\u6cd5\u8bbf\u95ee\uff1a" + args.folder);
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
            "\u539f\u6587\u6863\u4e3a " + originalMode + " / " + originalDepth +
            " \u4f4d\uff0c\u5df2\u5728\u4e34\u65f6\u526f\u672c\u4e2d\u8f6c\u6362\u4e3a RGB / 8 \u4f4d\u540e\u5bfc\u51fa\uff08\u989c\u8272\u53ef\u80fd\u6709\u504f\u79fb\uff0c\u6e90\u6587\u6863\u672a\u88ab\u4fee\u6539\uff09";
        if (originalMode !== "RGB") {
            warnings[warnings.length] =
                "\u539f\u6587\u6863\u6ca1\u6709\u900f\u660e\u901a\u9053\uff1b\u8f6c\u6362\u4e3a RGB \u540e\u900f\u660e\u533a\u57df\u4f1a\u53d8\u4e3a\u767d\u8272/\u80cc\u666f\u8272";
        }
        return {
            copy: copy,
            warnings: warnings
        };
    }

    function exportPng(args) {
        if (app.documents.length === 0) {
            return fail("NO_DOCUMENT", "\u8bf7\u5148\u6253\u5f00\u4e00\u4e2a Photoshop \u6587\u6863");
        }
        var doc = app.activeDocument;

        var prefixCheck = QPECore.validatePrefix(args.prefix);
        if (!prefixCheck.ok) {
            return fail(prefixCheck.code, prefixCheck.message, prefixCheck.chars ? {
                chars: prefixCheck.chars
            } : null);
        }
        if (!QPECore.isValidDigits(args.digits)) {
            return fail("BAD_DIGITS", "\u5e8f\u53f7\u4f4d\u6570\u53ea\u80fd\u662f 1\u30012 \u6216 3 \u4f4d");
        }
        if (!args.folder) {
            return fail("NO_FOLDER", "\u8bf7\u9009\u62e9 PNG \u8f93\u51fa\u6587\u4ef6\u5939");
        }
        var folder = folderFromPath(args.folder);
        if (!folder) {
            return fail("FOLDER_MISSING", "\u8f93\u51fa\u6587\u4ef6\u5939\u4e0d\u5b58\u5728\u6216\u65e0\u6cd5\u8bbf\u95ee\uff1a" + args.folder);
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
            return fail("COLLISION", "\u76ee\u6807\u6587\u4ef6\u5df2\u5b58\u5728\u4e14\u65e0\u6cd5\u81ea\u52a8\u5206\u914d\u5e8f\u53f7\uff1a" + fileName);
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
            return fail("SAVE_FAILED", "\u5bfc\u51fa\u5931\u8d25\uff1a" + errorText(saveError));
        } finally {
            try {
                app.displayDialogs = oldDialogs;
            } catch (dialogRestoreError) {
                // ignore
            }
        }

        var savedFile = new File(fullPath);
        if (!savedFile.exists) {
            return fail("VERIFY_FAILED", "\u5bfc\u51fa\u540e\u627e\u4e0d\u5230\u8f93\u51fa\u6587\u4ef6\uff1a" + fullPath);
        }
        if (savedFile.length <= 0) {
            return fail("VERIFY_FAILED", "\u5bfc\u51fa\u7684\u6587\u4ef6\u4e3a\u7a7a\uff080 \u5b57\u8282\uff09\uff1a" + fullPath);
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
            chosen = Folder.selectDialog("\u8bf7\u9009\u62e9 PNG \u8f93\u51fa\u6587\u4ef6\u5939", startFolder);
        } else {
            chosen = Folder.selectDialog("\u8bf7\u9009\u62e9 PNG \u8f93\u51fa\u6587\u4ef6\u5939");
        }
        if (!chosen) {
            return {
                ok: false,
                canceled: true,
                message: "\u5df2\u53d6\u6d88\u9009\u62e9\u6587\u4ef6\u5939"
            };
        }
        return {
            ok: true,
            path: chosen.fsName
        };
    }

    function openFolder(args) {
        if (!args.path) {
            return fail("NO_PATH", "\u6ca1\u6709\u53ef\u6253\u5f00\u7684\u6587\u4ef6\u5939");
        }
        var folder = folderFromPath(args.path);
        if (!folder) {
            return fail("FOLDER_MISSING", "\u6587\u4ef6\u5939\u4e0d\u5b58\u5728\uff1a" + args.path);
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
            return QPECore.toJson(fail("UNKNOWN_METHOD", "\u672a\u77e5\u7684\u8c03\u7528\uff1a" + method));
        }
        var args;
        try {
            args = parseArgs(argsJson);
        } catch (parseError) {
            return QPECore.toJson(fail("BAD_ARGS", "\u65e0\u6cd5\u89e3\u6790\u8c03\u7528\u53c2\u6570\uff1a" + errorText(parseError)));
        }
        var result;
        try {
            result = METHODS[method](args);
        } catch (methodError) {
            result = fail("EXCEPTION", "Photoshop \u811a\u672c\u51fa\u9519\uff1a" + errorText(methodError));
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
