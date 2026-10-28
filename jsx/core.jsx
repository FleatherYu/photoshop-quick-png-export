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
 *   toJson(value)                             -> ASCII-only JSON string (safe for evalScript)
 */

var QPECore = (function () {
    var ILLEGAL_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];
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
