/*
 * Quick PNG Export - panel logic.
 *
 * The panel is deliberately thin: validation and sequence numbering live in the
 * ExtendScript host (jsx/host.jsx) so the preview and the real export always use
 * the same rules. The panel only collects input, remembers the last used values,
 * and renders whatever the host answers.
 */
(function () {
    "use strict";

    var STORAGE_KEYS = {
        prefix: "qpe.prefix",
        digits: "qpe.digits",
        folder: "qpe.folder"
    };
    var PREVIEW_DEBOUNCE_MS = 180;
    var DOC_POLL_MS = 5000;

    var els = {};
    var state = {
        prefix: "",
        digits: 2,
        folder: "",
        busy: false,
        previewToken: 0,
        previewTimer: 0,
        lastPath: ""
    };

    function byId(id) {
        return document.getElementById(id);
    }

    /* ---------- persistence ---------- */

    function storeGet(key, fallback) {
        try {
            var value = window.localStorage.getItem(key);
            return (value === null || value === undefined) ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function storeSet(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (error) {
            // storage can be unavailable inside CEP; remembering values is a
            // convenience, never a requirement.
        }
    }

    function restoreState() {
        state.prefix = storeGet(STORAGE_KEYS.prefix, "");
        state.folder = storeGet(STORAGE_KEYS.folder, "");
        var digits = parseInt(storeGet(STORAGE_KEYS.digits, "2"), 10);
        state.digits = (digits === 1 || digits === 2 || digits === 3) ? digits : 2;
    }

    /* ---------- rendering ---------- */

    function setStatus(kind, text) {
        els.status.className = "status" + (kind ? " " + kind : "");
        els.status.textContent = text;
    }

    function setHint(text, kind) {
        els.nextHint.textContent = text || "";
        els.nextHint.className = "hint" + (kind ? " " + kind : "");
    }

    function renderDigits() {
        var buttons = els.digits.querySelectorAll("button");
        for (var i = 0; i < buttons.length; i++) {
            var value = parseInt(buttons[i].getAttribute("data-digits"), 10);
            buttons[i].setAttribute("aria-pressed", value === state.digits ? "true" : "false");
        }
    }

    function renderFolder() {
        els.folderPath.textContent = state.folder || "未选择输出文件夹";
        els.folderPath.title = state.folder || "";
        els.folderPath.classList.toggle("placeholder", !state.folder);
    }

    /* ---------- document status ---------- */

    function refreshDocument() {
        CEPBridge.call("status", {}, function (result) {
            if (!result.ok) {
                els.docInfo.textContent = "无法读取文档状态：" + (result.message || "未知错误");
                els.docInfo.className = "doc-info warn";
                return;
            }
            if (!result.hasDocument) {
                els.docInfo.textContent = "当前没有打开的文档";
                els.docInfo.className = "doc-info warn";
                return;
            }
            els.docInfo.textContent =
                result.name + " · " + result.width + "×" + result.height + " px · " +
                result.mode + " · " + result.bitDepth + " 位";
            els.docInfo.className = "doc-info";
            els.docInfo.title = result.saved ? "文档已保存" : "文档有未保存的修改";
        });
    }

    /* ---------- preview ---------- */

    function schedulePreview() {
        window.clearTimeout(state.previewTimer);
        state.previewTimer = window.setTimeout(updatePreview, PREVIEW_DEBOUNCE_MS);
    }

    function updatePreview() {
        var token = state.previewToken + 1;
        state.previewToken = token;

        if (!state.prefix.trim()) {
            els.nextFile.textContent = "—";
            setHint("填写前缀后这里会显示下一个文件名", "placeholder");
            return;
        }

        CEPBridge.call("preview", {
            prefix: state.prefix,
            digits: state.digits,
            folder: state.folder
        }, function (result) {
            if (token !== state.previewToken) {
                return; // a newer keystroke already asked
            }
            if (!result.ok) {
                els.nextFile.textContent = "—";
                if (result.code === "EMPTY" || result.code === "ILLEGAL_CHARS" ||
                    result.code === "TRAILING_DOT" || result.code === "TOO_LONG") {
                    setHint(result.message, "warn");
                } else {
                    setHint(result.message || "无法计算文件名", "warn");
                }
                return;
            }
            els.nextFile.textContent = result.fileName;
            if (result.folderAvailable === false) {
                setHint("尚未选择目录，序号从 1 开始计算", "placeholder");
            } else if (result.existingCount > 0) {
                setHint("目录中已有 " + result.existingCount + " 个同前缀文件，最大序号 " + result.maxNumber);
            } else {
                setHint("目录中没有同前缀文件，从 1 开始");
            }
        });
    }

    /* ---------- folder ---------- */

    function pickFolder() {
        if (state.busy) {
            return;
        }
        els.pick.disabled = true;
        CEPBridge.call("pickFolder", { current: state.folder }, function (result) {
            els.pick.disabled = false;
            if (!result.ok) {
                if (result.canceled || result.code === "CANCELLED") {
                    return; // closing the dialog is not an error
                }
                setStatus("error", result.message || "选择文件夹失败");
                return;
            }
            state.folder = result.path;
            storeSet(STORAGE_KEYS.folder, state.folder);
            renderFolder();
            setStatus("info", "已选择输出文件夹，可开始导出。");
            updatePreview();
        });
    }

    function openFolder() {
        if (!state.folder) {
            return;
        }
        CEPBridge.call("openFolder", { path: state.folder }, function (result) {
            if (!result.ok) {
                setStatus("error", result.message || "无法打开输出文件夹");
            }
        });
    }

    /* ---------- export ---------- */

    function setBusy(busy) {
        state.busy = busy;
        els.exportBtn.disabled = busy;
        els.pick.disabled = busy;
        els.exportBtn.textContent = busy ? "正在导出…" : "快速导出 PNG";
    }

    function doExport() {
        if (state.busy) {
            return;
        }
        if (!state.prefix.trim()) {
            setStatus("error", "请输入文件名前缀");
            els.prefix.focus();
            return;
        }
        if (!state.folder) {
            setStatus("error", "请选择 PNG 输出文件夹");
            return;
        }

        setBusy(true);
        setStatus("busy", "正在导出，请稍候…");

        CEPBridge.call("exportPng", {
            prefix: state.prefix,
            digits: state.digits,
            folder: state.folder
        }, function (result) {
            setBusy(false);

            if (!result.ok) {
                var message = result.message || "导出失败";
                if (result.code === "COLLISION") {
                    message += "。请再次点击导出，序号会重新计算。";
                }
                setStatus("error", message);
                updatePreview();
                return;
            }

            var lines = ["已导出：" + result.fileName];
            var warnings = result.warnings || [];
            for (var i = 0; i < warnings.length; i++) {
                lines[lines.length] = warnings[i];
            }
            setStatus("ok", lines.join("\n"));

            state.lastPath = result.fullPath || "";
            els.lastPath.textContent = state.lastPath;
            els.lastPath.title = state.lastPath;
            els.last.classList.remove("hidden");

            updatePreview();
            refreshDocument();
        });
    }

    /* ---------- clipboard ---------- */

    function copyText(text) {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.left = "-1000px";
        area.style.top = "0";
        document.body.appendChild(area);
        area.select();
        var copied = false;
        try {
            copied = document.execCommand("copy");
        } catch (error) {
            copied = false;
        }
        document.body.removeChild(area);
        return copied;
    }

    function copyLastPath() {
        if (!state.lastPath) {
            return;
        }
        if (copyText(state.lastPath)) {
            els.copy.textContent = "已复制";
            window.setTimeout(function () {
                els.copy.textContent = "复制路径";
            }, 1500);
        } else {
            setStatus("error", "无法写入剪贴板，请手动选中路径复制。");
        }
    }

    /* ---------- wiring ---------- */

    function bindEvents() {
        els.prefix.addEventListener("input", function () {
            state.prefix = els.prefix.value;
            storeSet(STORAGE_KEYS.prefix, state.prefix);
            schedulePreview();
        });
        els.prefix.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                event.preventDefault();
                doExport();
            }
        });

        els.digits.addEventListener("click", function (event) {
            var button = event.target;
            while (button && button !== els.digits && !button.getAttribute("data-digits")) {
                button = button.parentNode;
            }
            if (!button || button === els.digits) {
                return;
            }
            state.digits = parseInt(button.getAttribute("data-digits"), 10);
            storeSet(STORAGE_KEYS.digits, String(state.digits));
            renderDigits();
            updatePreview();
        });

        els.pick.addEventListener("click", pickFolder);
        els.exportBtn.addEventListener("click", doExport);
        els.copy.addEventListener("click", copyLastPath);
        els.open.addEventListener("click", openFolder);

        els.folderPath.addEventListener("click", function () {
            if (state.folder && copyText(state.folder)) {
                setStatus("info", "目录路径已复制。");
            }
        });

        document.addEventListener("keydown", function (event) {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                doExport();
            }
        });
    }

    function init() {
        els.prefix = byId("prefix");
        els.digits = byId("digits");
        els.folderPath = byId("folder-path");
        els.pick = byId("pick-folder");
        els.exportBtn = byId("export");
        els.status = byId("status");
        els.nextFile = byId("next-file");
        els.nextHint = byId("next-hint");
        els.docInfo = byId("doc-info");
        els.mockNote = byId("mock-note");
        els.last = byId("last-export");
        els.lastPath = byId("last-path");
        els.copy = byId("copy-path");
        els.open = byId("open-folder");

        restoreState();
        bindEvents();

        els.prefix.value = state.prefix;
        renderDigits();
        renderFolder();
        CEPBridge.applyTheme();
        if (CEPBridge.isMock()) {
            els.mockNote.classList.remove("hidden");
        }

        setStatus("", "就绪。填写前缀、选好目录，点击“快速导出 PNG”。");
        refreshDocument();
        updatePreview();

        window.setInterval(function () {
            if (!state.busy && !document.hidden) {
                refreshDocument();
            }
        }, DOC_POLL_MS);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
}());
