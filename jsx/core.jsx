/*
 * PNG Smart Export - core naming / sequencing logic.
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
    //   "2610-10-狼场景.psd" -> "2610-10-狼场景"
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
                message: "请输入文件名前缀"
            };
        }

        var foundIllegal = [];
        for (var i = 0; i < prefix.length; i++) {
            var ch = prefix.charAt(i);
            var code = prefix.charCodeAt(i);
            if (code < 32) {
                if (indexOfValue(foundIllegal, "控制字符") === -1) {
                    foundIllegal.push("控制字符");
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
                message: "前缀包含文件名不允许的字符：" + foundIllegal.join(" ") +
                    "（Windows 文件名不能使用 \\ / : * ? \" < > |）"
            };
        }

        if (prefix.charAt(prefix.length - 1) === ".") {
            return {
                ok: false,
                code: "TRAILING_DOT",
                message: "前缀不能以句点结尾（句点结尾在 Windows 上会被系统去掉）"
            };
        }

        if (prefix.length > MAX_PREFIX_LENGTH) {
            return {
                ok: false,
                code: "TOO_LONG",
                message: "前缀过长（最多 " + MAX_PREFIX_LENGTH + " 个字符）"
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
    // (verified in Photoshop CC 2019: a file named "QPE-测试-05.png" reports
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
