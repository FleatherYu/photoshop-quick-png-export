/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built from jsx/core.jsx + jsx/host-body.jsx by scripts/build-host.mjs.
 * Regenerate with: node scripts/build-host.mjs
 */

/*
 * Photoshop Quick PNG Export - core naming / sequencing logic.
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
 *   compareLayerPaths(left, right)            -> number (panel order, top to bottom)
 *   orderSelectedLayers(items, selectedIds)   -> panel-order records, selected ancestors win
 *   buildBatchNames(fileNames, prefix, digits, count, caseInsensitive) -> {startNumber, names, ...}
 *   summarizeBatch(successes, skipped, failed, unprocessedCount) -> counts
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

    /* ---------- batch layer planning ---------- */

    // Compares two layer paths ([index at each level], 0 = topmost sibling) and
    // yields panel order: parents before their children, siblings top to bottom.
    function compareLayerPaths(left, right) {
        var length = left.length < right.length ? left.length : right.length;
        for (var i = 0; i < length; i++) {
            if (left[i] !== right[i]) {
                return left[i] < right[i] ? -1 : 1;
            }
        }
        return left.length - right.length;
    }

    function isPathPrefix(prefix, path) {
        if (prefix.length >= path.length) {
            return false;
        }
        for (var i = 0; i < prefix.length; i++) {
            if (prefix[i] !== path[i]) {
                return false;
            }
        }
        return true;
    }

    // items = [{id, name, path:[...]}]; selectedIds = layer ids in any order.
    // Returns panel-ordered records, dropping a selected descendant when one of
    // its selected ancestors is already in the batch (the group contains it).
    function orderSelectedLayers(items, selectedIds) {
        var byId = {};
        var i;
        for (i = 0; i < items.length; i++) {
            byId[items[i].id] = items[i];
        }
        var selected = [];
        var seen = {};
        for (i = 0; i < selectedIds.length; i++) {
            var id = selectedIds[i];
            if (seen[id]) {
                continue;
            }
            if (byId[id]) {
                seen[id] = true;
                selected[selected.length] = byId[id];
            }
        }
        selected.sort(function (left, right) {
            return compareLayerPaths(left.path, right.path);
        });
        var kept = [];
        for (i = 0; i < selected.length; i++) {
            var covered = false;
            for (var j = 0; j < kept.length; j++) {
                if (isPathPrefix(kept[j].path, selected[i].path)) {
                    covered = true;
                    break;
                }
            }
            if (!covered) {
                kept[kept.length] = selected[i];
            }
        }
        return kept;
    }

    // Expected names for the next `count` exports. This is only a plan: the
    // host re-scans the folder before every save, so skipped objects do not
    // consume a number.
    function buildBatchNames(fileNames, prefix, digits, count, caseInsensitive) {
        var next = computeNext(fileNames, prefix, caseInsensitive);
        var total = 0;
        if (typeof count === "number" && isFinite(count) && count > 0) {
            total = Math.floor(count);
        }
        var names = [];
        for (var i = 0; i < total; i++) {
            names[i] = buildFileName(prefix, digits, next.nextNumber + i);
        }
        return {
            startNumber: next.nextNumber,
            maxNumber: next.maxNumber,
            existingCount: next.existingCount,
            names: names
        };
    }

    // Shared counts for the panel summary and the host result payload.
    function summarizeBatch(successes, skipped, failed, unprocessedCount) {
        var exported = successes ? successes.length : 0;
        var skippedCount = skipped ? skipped.length : 0;
        var failedCount = failed ? 1 : 0;
        var unprocessed = (
            typeof unprocessedCount === "number" && isFinite(unprocessedCount) && unprocessedCount > 0
        ) ? Math.floor(unprocessedCount) : 0;
        return {
            exported: exported,
            skipped: skippedCount,
            failed: failedCount,
            unprocessed: unprocessed,
            total: exported + skippedCount + failedCount + unprocessed,
            allSkipped: exported === 0 && skippedCount > 0 && failedCount === 0 && unprocessed === 0
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
        compareLayerPaths: compareLayerPaths,
        orderSelectedLayers: orderSelectedLayers,
        buildBatchNames: buildBatchNames,
        summarizeBatch: summarizeBatch,
        escapeRegExp: escapeRegExp,
        toJson: toJson
    };
}());

if (typeof module !== "undefined" && module.exports) {
    // Node test harness convenience; ExtendScript ignores this branch.
    module.exports = QPECore;
}

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
 * Methods: status / preview / exportPng / previewSelectedLayers /
 *          exportSelectedLayers / pickFolder / openFolder
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

    /* ---------- batch: selected layers ---------- */

    var BATCH_TEMP_NAME = "QPE-batch-temp";

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
                "\u65e0\u6cd5\u8bfb\u53d6\u90e8\u5206\u9009\u4e2d\u5bf9\u8c61\u7684\u56fe\u5c42\u5f15\u7528\uff08\u7b2c " + (failedPositions[0] + 1) + " \u9879\uff09\uff0c\u5df2\u505c\u6b62\u5bfc\u51fa");
        }
        return {
            ok: true,
            ids: ids
        };
    }

    function readTargetLayerIdsByIndex(documentDesc) {
        if (!documentDesc.hasKey(stringIDToTypeID("targetLayers"))) {
            return fail("SELECTION_READ_FAILED", "\u65e0\u6cd5\u8bfb\u53d6\u5f53\u524d\u9009\u4e2d\u7684\u56fe\u5c42\uff1aPhotoshop \u6ca1\u6709\u8fd4\u56de targetLayers");
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
                "\u65e0\u6cd5\u8bfb\u53d6\u90e8\u5206\u9009\u4e2d\u5bf9\u8c61\u7684\u56fe\u5c42\u5f15\u7528\uff08\u7b2c " + (failedIndexes[0] + 1) + " \u9879\uff09\uff0c\u5df2\u505c\u6b62\u5bfc\u51fa");
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
            return fail("SELECTION_READ_FAILED", "\u65e0\u6cd5\u8bfb\u53d6\u5f53\u524d\u9009\u4e2d\u7684\u56fe\u5c42\uff1a" + errorText(selectionError));
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
                return fail("SELECTION_READ_FAILED", "\u65e0\u6cd5\u8bfb\u53d6\u5f53\u524d\u9009\u4e2d\u7684\u56fe\u5c42\uff1a" + errorText(indexReadError));
            }
        }
        if (!selection.ok) {
            return selection;
        }
        if (selection.ids.length === 0) {
            return fail("NO_SELECTION", "\u8bf7\u5148\u5728 Photoshop \u4e2d\u9009\u4e2d\u8981\u5bfc\u51fa\u7684\u56fe\u5c42\u6216\u56fe\u5c42\u7ec4");
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
                "\u6709\u9009\u4e2d\u7684\u56fe\u5c42\u65e0\u6cd5\u5728\u56fe\u5c42\u6811\u4e2d\u5b9a\u4f4d\uff08ID " + missing.join(",") + "\uff09\uff0c\u5df2\u505c\u6b62\u5bfc\u51fa");
        }
        var ordered = QPECore.orderSelectedLayers(found, ids);
        if (ordered.length === 0) {
            return fail("NO_SELECTION", "\u8bf7\u5148\u5728 Photoshop \u4e2d\u9009\u4e2d\u8981\u5bfc\u51fa\u7684\u56fe\u5c42\u6216\u56fe\u5c42\u7ec4");
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
                        message: "\u4e0a\u65b9\u6709\u8c03\u6574\u56fe\u5c42\u300c" + container[i].name + "\u300d\uff0c\u5355\u72ec\u5bfc\u51fa\u4f1a\u4e22\u5931\u5b83\u7684\u6548\u679c\uff0c\u5df2\u8df3\u8fc7"
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
                    message: "\u300c" + record.name + "\u300d\u4e0a\u65b9\u6709\u4f9d\u8d56\u5b83\u7684\u526a\u8d34\u8499\u7248\u5185\u5bb9\u300c" + container[i].name + "\u300d\uff0c\u5355\u72ec\u5bfc\u51fa\u4f1a\u4e22\u5931\uff0c\u5df2\u8df3\u8fc7"
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
                        message: "\u56fe\u5c42\u300c" + record.name + "\u300d\u662f\u526a\u8d34\u8499\u7248\u5185\u5bb9\uff0c\u4f9d\u8d56\u5b83\u4e0b\u9762\u7684\u56fe\u5c42\uff0c\u5df2\u8df3\u8fc7"
                    };
                }
            } catch (groupedError) {
                // Old hosts may not expose .grouped; treat as not clipped.
            }
            if (blendMode !== BlendMode.NORMAL) {
                return {
                    code: "BLEND",
                    message: "\u56fe\u5c42\u300c" + record.name + "\u300d\u7684\u6df7\u5408\u6a21\u5f0f\u4e0d\u662f\u300c\u6b63\u5e38\u300d\uff0c\u5355\u72ec\u5bfc\u51fa\u4f1a\u5931\u771f\uff0c\u5df2\u8df3\u8fc7"
                };
            }
        } else if (blendMode === BlendMode.PASSTHROUGH) {
            if (subtreeHasExternalBlend(layer)) {
                return {
                    code: "BLEND",
                    message: "\u56fe\u5c42\u7ec4\u300c" + record.name + "\u300d\u662f\u7a7f\u900f\u7ec4\u4e14\u5185\u90e8\u6709\u975e\u6b63\u5e38\u6df7\u5408\u6a21\u5f0f\uff0c\u5df2\u8df3\u8fc7"
                };
            }
        } else if (blendMode !== BlendMode.NORMAL) {
            return {
                code: "BLEND",
                message: "\u56fe\u5c42\u7ec4\u300c" + record.name + "\u300d\u7684\u6df7\u5408\u6a21\u5f0f\u4e0d\u662f\u300c\u6b63\u5e38\u300d\uff0c\u5355\u72ec\u5bfc\u51fa\u4f1a\u5931\u771f\uff0c\u5df2\u8df3\u8fc7"
            };
        }
        for (var i = 0; i < record.parents.length; i++) {
            var ancestor = record.parents[i];
            try {
                if (ancestor.layer.grouped) {
                    return {
                        code: "CLIPPED",
                        message: "\u4e0a\u7ea7\u56fe\u5c42\u7ec4\u300c" + ancestor.name + "\u300d\u662f\u526a\u8d34\u8499\u7248\u5185\u5bb9\uff0c\u5df2\u8df3\u8fc7"
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
                    message: "\u4e0a\u7ea7\u56fe\u5c42\u7ec4\u300c" + ancestor.name + "\u300d\u7684\u6df7\u5408\u6a21\u5f0f\u4e0d\u662f\u300c\u6b63\u5e38\u300d\uff0c\u5df2\u8df3\u8fc7"
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

    // Saves the isolated temporary copy as a PNG with the next free number.
    function saveBatchPng(workDoc, folder, prefix, digits) {
        var fileName = "";
        var fullPath = "";
        var number = 0;
        for (var attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
            var files = listPngNames(folder);
            var computed = QPECore.computeExport(files, prefix, digits, true);
            number = computed.nextNumber;
            fileName = computed.fileName;
            fullPath = joinPath(folder.fsName, fileName);
            if (!new File(fullPath).exists) {
                break;
            }
        }
        var file = new File(fullPath);
        if (file.exists) {
            return {
                ok: false,
                code: "COLLISION",
                message: "\u76ee\u6807\u6587\u4ef6\u5df2\u5b58\u5728\u4e14\u65e0\u6cd5\u81ea\u52a8\u5206\u914d\u5e8f\u53f7\uff1a" + fileName
            };
        }
        var options = new PNGSaveOptions();
        options.interlaced = false;
        workDoc.saveAs(file, options, true, Extension.LOWERCASE);
        file = new File(fullPath);
        if (!file.exists) {
            return {
                ok: false,
                code: "VERIFY_FAILED",
                message: "\u5bfc\u51fa\u540e\u627e\u4e0d\u5230\u8f93\u51fa\u6587\u4ef6\uff1a" + fullPath
            };
        }
        if (file.length <= 0) {
            return {
                ok: false,
                code: "VERIFY_FAILED",
                message: "\u5bfc\u51fa\u7684\u6587\u4ef6\u4e3a\u7a7a\uff080 \u5b57\u8282\uff09\uff1a" + fullPath
            };
        }
        return {
            ok: true,
            number: number,
            fileName: fileName,
            file: file
        };
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
            "\u539f\u6587\u6863\u4e3a " + originalMode + " / " + originalDepth +
            " \u4f4d\uff0c\u5df2\u5728\u4e34\u65f6\u526f\u672c\u4e2d\u8f6c\u6362\u4e3a RGB / 8 \u4f4d\u540e\u5bfc\u51fa\uff08\u989c\u8272\u53ef\u80fd\u6709\u504f\u79fb\uff0c\u6e90\u6587\u6863\u672a\u88ab\u4fee\u6539\uff09";
        if (originalMode !== "RGB") {
            warnings[warnings.length] =
                "\u539f\u6587\u6863\u6ca1\u6709\u900f\u660e\u901a\u9053\uff1b\u8f6c\u6362\u4e3a RGB \u540e\u900f\u660e\u533a\u57df\u4f1a\u53d8\u4e3a\u767d\u8272/\u80cc\u666f\u8272";
        }
        return warnings;
    }

    function previewSelectedLayers(args) {
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

        var files = [];
        var folderAvailable = false;
        if (args.folder) {
            var folder = folderFromPath(args.folder);
            if (!folder) {
                return fail("FOLDER_MISSING", "\u8f93\u51fa\u6587\u4ef6\u5939\u4e0d\u5b58\u5728\u6216\u65e0\u6cd5\u8bbf\u95ee\uff1a" + args.folder);
            }
            files = listPngNames(folder);
            folderAvailable = true;
        }
        var plan = QPECore.buildBatchNames(files, prefixCheck.prefix, args.digits, exportable.length, true);
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
                "\u539f\u6587\u6863\u4e3a " + modeName(doc.mode) + " / " + bitDepthName(doc.bitsPerChannel) +
                " \u4f4d\uff0c\u5bfc\u51fa\u65f6\u4f1a\u5728\u4e34\u65f6\u526f\u672c\u4e2d\u8f6c\u6362\u4e3a RGB / 8 \u4f4d\uff08\u9884\u8ba1\u6587\u4ef6\u540d\u57fa\u4e8e\u5f53\u524d\u72b6\u6001\uff09";
        }

        return {
            ok: true,
            document: doc.name,
            selectionKey: selectionKeyOf(doc, selection.ids),
            selectedCount: resolved.targets.length,
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

        var selection = readTargetLayerIds();
        if (!selection.ok) {
            return selection;
        }
        var sourceIndex = buildLayerIndex(doc);
        var resolved = resolveTargets(sourceIndex, selection.ids);
        if (!resolved.ok) {
            return resolved;
        }
        var targets = resolved.targets;

        if (args.selectionKey && args.selectionKey !== selectionKeyOf(doc, selection.ids)) {
            return fail("SELECTION_CHANGED", "\u5f53\u524d\u6587\u6863\u6216\u9009\u4e2d\u7684\u56fe\u5c42\u5df2\u53d1\u751f\u53d8\u5316\uff0c\u8bf7\u5237\u65b0\u9009\u62e9\u540e\u91cd\u8bd5");
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
                workDoc.mode = DocumentMode.RGB;
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
                        message: "\u4e34\u65f6\u526f\u672c\u4e2d\u627e\u4e0d\u5230\u8be5\u56fe\u5c42\uff0c\u65e0\u6cd5\u5bfc\u51fa"
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
                    var saved = saveBatchPng(workDoc, folder, prefixCheck.prefix, args.digits);
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

                    phase = "detect";
                    var probe = probePngHasPixels(saved.file);
                    if (!probe.ok) {
                        failed = {
                            id: target.id,
                            name: target.name,
                            phase: phase,
                            code: "ALPHA_CHECK_FAILED",
                            message: "\u65e0\u6cd5\u68c0\u6d4b\u5bfc\u51fa\u7ed3\u679c\u7684\u900f\u660e\u5ea6\uff1a" + probe.message
                        };
                        unprocessed = totalTargets - t - 1;
                        break;
                    }
                    if (!probe.hasPixels) {
                        var removed = false;
                        try {
                            removed = saved.file.remove();
                        } catch (removeError) {
                            removed = false;
                        }
                        if (!removed) {
                            cleanupErrors[cleanupErrors.length] =
                                "\u65e0\u6cd5\u5220\u9664\u5168\u900f\u660e\u63a2\u6d4b\u6587\u4ef6\uff0c\u8be5\u7f16\u53f7\u5df2\u88ab\u5360\u7528\uff1a" + saved.file.fsName;
                        }
                        skipped[skipped.length] = {
                            id: target.id,
                            name: target.name,
                            isGroup: target.isGroup,
                            code: "EMPTY",
                            message: "\u5b8c\u5168\u900f\u660e\uff0c\u5df2\u8df3\u8fc7\uff08\u4e0d\u5360\u7f16\u53f7\uff09"
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
                    cleanupErrors[cleanupErrors.length] = "\u5173\u95ed\u4e34\u65f6\u526f\u672c\u5931\u8d25\uff1a" + errorText(closeError);
                }
                workDoc = null;
            }
            try {
                app.activeDocument = doc;
            } catch (activateError) {
                cleanupErrors[cleanupErrors.length] = "\u6062\u590d\u6e90\u6587\u6863\u4e3a\u6d3b\u52a8\u6587\u6863\u5931\u8d25\uff1a" + errorText(activateError);
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
                "\u6279\u91cf\u5bfc\u51fa\u5728\u300c" + (failed.name || "\u672a\u77e5\u5bf9\u8c61") + "\u300d\u5904\u505c\u6b62\uff1a" + failed.message, {
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

        var message = "\u6279\u91cf\u5bfc\u51fa\u5b8c\u6210";
        if (counts.exported === 0 && counts.skipped > 0) {
            message = "\u672a\u5bfc\u51fa\uff0c\u5df2\u8df3\u8fc7 " + counts.skipped + " \u9879";
        } else if (counts.skipped > 0) {
            message = "\u6279\u91cf\u5bfc\u51fa\u5b8c\u6210\uff1a\u6210\u529f " + counts.exported + " \u5f20\uff0c\u8df3\u8fc7 " + counts.skipped + " \u9879";
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
        previewSelectedLayers: previewSelectedLayers,
        exportPng: exportPng,
        exportSelectedLayers: exportSelectedLayers,
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
        previewSelectedLayers: previewSelectedLayers,
        exportPng: exportPng,
        exportSelectedLayers: exportSelectedLayers,
        pickFolder: pickFolder,
        openFolder: openFolder,
        call: call
    };
}());

function QPE_call(method, argsJson) {
    return QPE.call(method, argsJson);
}
