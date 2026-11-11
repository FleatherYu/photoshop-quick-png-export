/*
 * Photoshop Quick PNG Export - panel logic.
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
        folder: "qpe.folder",
        lastFolder: "qpe.lastFolder",
        folderMode: "qpe.folderMode",
        mode: "qpe.mode",
        format: "qpe.format",
        quality: "qpe.quality",
        numbering: "qpe.numbering"
    };
    var PREVIEW_DEBOUNCE_MS = 180;
    var DOC_POLL_MS = 5000;
    var FORMAT_PNG = "png";
    var FORMAT_JPG = "jpg";

    var els = {};
    var state = {
        prefix: "",
        digits: 2,
        folder: "",
        lastFolder: "",
        folderMode: "document",
        folderSource: "",
        // True once the user picked a folder by hand for the current document:
        // following the document must then leave that choice alone.
        folderEdited: false,
        mode: "document",
        format: FORMAT_PNG,
        quality: 10,
        numbering: "shared",
        busy: false,
        previewToken: 0,
        previewTimer: 0,
        estimateToken: 0,
        estimateKey: "",
        estimateText: "",
        lastPath: "",
        lastDocName: null,
        docKey: null,
        docFingerprint: "",
        prefixEdited: false,
        // Snapshot of the selection preview; export refuses to run on a stale one.
        selectionKey: ""
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
        state.lastFolder = storeGet(STORAGE_KEYS.lastFolder, "") || state.folder;
        state.folderMode = storeGet(STORAGE_KEYS.folderMode, "") === "last" ? "last" : "document";
        state.folderSource = state.folder ? "last" : "";
        state.mode = storeGet(STORAGE_KEYS.mode, "document") === "selection" ? "selection" : "document";
        state.format = storeGet(STORAGE_KEYS.format, "") === FORMAT_JPG ? FORMAT_JPG : FORMAT_PNG;
        var quality = parseInt(storeGet(STORAGE_KEYS.quality, "10"), 10);
        state.quality = (quality >= 0 && quality <= 12) ? quality : 10;
        state.numbering = storeGet(STORAGE_KEYS.numbering, "") === "separate" ? "separate" : "shared";
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

    // One-line note under the prefix field: only used when the document name
    // had to be cleaned up, so automatic filling is never silently surprising.
    function setPrefixNote(text, kind) {
        els.prefixNote.textContent = text || "";
        els.prefixNote.className = "hint" + (kind ? " " + kind : "") +
            (text ? "" : " hidden");
    }

    function setSegPressed(container, attribute, value) {
        var buttons = container.querySelectorAll("button");
        for (var i = 0; i < buttons.length; i++) {
            var pressed = buttons[i].getAttribute(attribute) === value;
            buttons[i].setAttribute("aria-pressed", pressed ? "true" : "false");
        }
    }

    function renderDigits() {
        setSegPressed(els.digits, "data-digits", String(state.digits));
    }

    function renderFormat() {
        setSegPressed(els.format, "data-format", state.format);
        els.qualityRow.classList.toggle("hidden", state.format !== FORMAT_JPG);
        // Size estimates only make sense for the whole document; batch mode
        // exports one isolated object per file, so there is no single size.
        els.estimateRow.classList.toggle("hidden", state.mode === "selection");
        els.exportBtn.textContent = exportLabel();
        renderQuality();
    }

    function qualityTier(quality) {
        if (quality <= 3) {
            return "低";
        }
        if (quality <= 7) {
            return "中";
        }
        if (quality <= 10) {
            return "高";
        }
        return "最佳";
    }

    function renderQuality() {
        els.quality.value = String(state.quality);
        els.qualityValue.textContent = state.quality + "（" + qualityTier(state.quality) + "）";
    }

    function renderFolder() {
        els.folderPath.textContent = state.folder || "未选择输出文件夹";
        els.folderPath.title = state.folder || "";
        els.folderPath.classList.toggle("placeholder", !state.folder);

        var source = "";
        if (state.folder) {
            if (state.folderSource === "document") {
                source = "来源：文档所在文件夹";
            } else if (state.folderSource === "manual") {
                source = "来源：手动选择";
            } else if (state.folderSource === "last") {
                source = "来源：上次使用的位置";
            }
        }
        els.folderSource.textContent = source;
        els.folderSource.className = "hint" + (source ? "" : " hidden");
    }

    function renderSettings() {
        setSegPressed(els.numbering, "data-numbering", state.numbering);
        setSegPressed(els.folderMode, "data-folder-mode", state.folderMode);
    }

    function exportLabel() {
        if (state.mode === "selection") {
            return state.busy ? "正在批量导出…" : "批量导出选中图层";
        }
        var formatName = state.format === FORMAT_JPG ? "JPG" : "PNG";
        return state.busy ? "正在导出…" : "快速导出 " + formatName;
    }

    function renderMode() {
        setSegPressed(els.mode, "data-mode", state.mode);
        els.selectionBox.classList.toggle("hidden", state.mode !== "selection");
        renderFormat();
    }

    /* ---------- document status ---------- */

    // Fills the prefix with the active document's name (without extension) so
    // the usual case is: open document -> pick folder -> export. It only fills
    // automatically while the user has not typed a prefix for this document;
    // switching to another document starts that default over again.
    function applyDocumentPrefix(result) {
        if (!result.suggestedPrefix || state.prefixEdited) {
            return;
        }
        if (state.prefix === result.suggestedPrefix) {
            return;
        }
        state.prefix = result.suggestedPrefix;
        els.prefix.value = state.prefix;
        storeSet(STORAGE_KEYS.prefix, state.prefix);
        if (result.suggestedAdjusted) {
            setPrefixNote("已按文档名自动填入，并去掉了文件名不允许的字符。", "warn");
        } else {
            setPrefixNote("");
        }
        updatePreview();
    }

    // "Follow the document folder" mode. A manual folder choice for this
    // document always wins; switching documents re-applies the rule. Unsaved
    // documents (no path) fall back to the last folder that was used.
    function applyDocumentFolder(result, documentChanged) {
        if (state.folderMode === "last") {
            return; // 1.1.0 behaviour: the remembered folder is never replaced
        }
        if (state.folderEdited && !documentChanged) {
            return;
        }
        var target = "";
        var source = "";
        if (result.hasDocument && result.path) {
            target = result.path;
            source = "document";
        } else if (state.lastFolder) {
            target = state.lastFolder;
            source = "last";
        }
        if (!target || (state.folder === target && state.folderSource === source)) {
            return;
        }
        state.folder = target;
        state.folderSource = source;
        storeSet(STORAGE_KEYS.folder, target);
        renderFolder();
        updatePreview();
    }

    function documentFingerprint(result) {
        return [
            result.name,
            result.width,
            result.height,
            result.mode,
            result.bitDepth,
            result.layerCount
        ].join("|");
    }

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
                state.lastDocName = null;
                state.selectionKey = "";
                state.docKey = null;
                state.docFingerprint = "";
                setEstimate("—");
                return;
            }
            els.docInfo.textContent =
                result.name + " · " + result.width + "×" + result.height + " px · " +
                result.mode + " · " + result.bitDepth + " 位";
            els.docInfo.className = "doc-info";
            els.docInfo.title = result.saved ? "文档已保存" : "文档有未保存的修改";

            var fingerprint = documentFingerprint(result);
            var docKey = result.name + "|" + (result.path || "");
            var documentChanged = docKey !== state.docKey;
            if (documentChanged) {
                state.docKey = docKey;
                // A different document starts with its own folder choice.
                state.folderEdited = false;
            }

            if (result.name !== state.lastDocName) {
                // New / different document: the default prefix applies again.
                state.lastDocName = result.name;
                state.prefixEdited = false;
                setPrefixNote("");
            }
            applyDocumentPrefix(result);
            applyDocumentFolder(result, documentChanged);

            if (fingerprint !== state.docFingerprint) {
                state.docFingerprint = fingerprint;
                invalidateEstimate();
            }

            if (state.mode === "selection") {
                // The selection can change in Photoshop at any time; the 5 s
                // poll keeps the batch count and the export key fresh.
                schedulePreview();
            }
        });
    }

    /* ---------- size estimate ---------- */

    function formatBytes(bytes) {
        if (!isFinite(bytes) || bytes <= 0) {
            return "";
        }
        if (bytes >= 1048576) {
            return (bytes / 1048576).toFixed(1) + " MB";
        }
        if (bytes >= 1024) {
            return Math.round(bytes / 1024) + " KB";
        }
        return bytes + " B";
    }

    function setEstimate(text, kind) {
        els.estimateValue.textContent = text;
        els.estimateValue.className = "preview-value" + (kind ? " " + kind : "");
    }

    function estimateKey() {
        return [
            state.format,
            state.format === FORMAT_JPG ? state.quality : "",
            state.docKey || "",
            state.docFingerprint
        ].join("|");
    }

    // The host saves the current document to a temp file with the exact same
    // save options as a real export, so the number is an honest estimate. Only
    // triggers that can change the result call this; dragging the quality
    // slider only updates the label.
    function invalidateEstimate() {
        if (state.mode === "selection") {
            setEstimate("—");
            return;
        }
        if (state.busy) {
            // No new estimates during an export; a stale in-flight one is
            // dropped by the token bump in setBusy.
            return;
        }
        var key = estimateKey();
        if (key === state.estimateKey && state.estimateText) {
            setEstimate(state.estimateText);
            return;
        }
        state.estimateKey = "";
        var token = state.estimateToken + 1;
        state.estimateToken = token;
        setEstimate("正在估算…", "placeholder");
        CEPBridge.call("estimateSize", {
            format: state.format,
            quality: state.quality
        }, function (result) {
            if (token !== state.estimateToken || state.busy) {
                return; // a newer estimate or an export already took over
            }
            if (!result.ok) {
                setEstimate("无法估算", "warn");
                return;
            }
            var text = "约 " + formatBytes(result.bytes);
            state.estimateKey = estimateKey();
            state.estimateText = text;
            setEstimate(text);
        });
    }

    /* ---------- preview ---------- */

    function schedulePreview() {
        window.clearTimeout(state.previewTimer);
        state.previewTimer = window.setTimeout(updatePreview, PREVIEW_DEBOUNCE_MS);
    }

    function updatePreview() {
        if (state.mode === "selection") {
            updateSelectionPreview();
        } else {
            updateDocumentPreview();
        }
    }

    function scanArguments() {
        return {
            prefix: state.prefix,
            digits: state.digits,
            folder: state.folder,
            format: state.format,
            quality: state.quality,
            numbering: state.numbering
        };
    }

    function updateDocumentPreview() {
        var token = state.previewToken + 1;
        state.previewToken = token;

        if (!state.prefix.trim()) {
            els.nextFile.textContent = "—";
            setHint("填写前缀后这里会显示导出名称", "placeholder");
            return;
        }

        CEPBridge.call("preview", scanArguments(), function (result) {
            if (token !== state.previewToken) {
                return; // a newer keystroke already asked
            }
            if (!result.ok) {
                els.nextFile.textContent = "—";
                if (result.code === "EMPTY" || result.code === "ILLEGAL_CHARS" ||
                    result.code === "TRAILING_DOT" || result.code === "TOO_LONG" ||
                    result.code === "BAD_QUALITY") {
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

    // Batch mode never invents numbers: the host scans the folder and returns
    // the expected names; the panel only renders them and keeps the selection
    // key so an export cannot run against a stale selection.
    function updateSelectionPreview() {
        var token = state.previewToken + 1;
        state.previewToken = token;

        if (!state.prefix.trim()) {
            els.nextFile.textContent = "—";
            setHint("填写前缀后这里会显示导出名称", "placeholder");
            return;
        }

        CEPBridge.call("previewSelectedLayers", scanArguments(), function (result) {
            if (token !== state.previewToken) {
                return;
            }
            if (!result.ok) {
                state.selectionKey = "";
                els.nextFile.textContent = "—";
                els.selectionSummary.textContent = "—";
                els.selectionList.textContent = "";
                setHint(result.message || "无法读取当前选择", "warn");
                return;
            }

            state.selectionKey = result.selectionKey || "";
            els.selectionSummary.textContent =
                "选中 " + result.selectedCount + " 个，可导出 " + result.count + " 张" +
                ((result.skipped && result.skipped.length)
                    ? "（" + result.skipped.length + " 个将跳过）"
                    : "");

            var lines = [];
            var items = result.items || [];
            for (var i = 0; i < items.length; i++) {
                lines[lines.length] = "· " + (items[i].isGroup ? "组 " : "") + items[i].name +
                    "  →  " + items[i].expectedFileName;
            }
            var skipped = result.skipped || [];
            for (i = 0; i < skipped.length; i++) {
                lines[lines.length] = "× " + (skipped[i].isGroup ? "组 " : "") + skipped[i].name +
                    "：" + skipped[i].message;
            }
            els.selectionList.textContent = lines.join("\n");

            if (!result.count) {
                els.nextFile.textContent = "—";
                if (result.selectedCount === 0) {
                    setHint("请先在 Photoshop 中选中图层或图层组", "warn");
                } else {
                    setHint("选中的对象都无法单独导出，原因见上方列表", "warn");
                }
                return;
            }

            els.nextFile.textContent = (result.count === 1)
                ? items[0].expectedFileName
                : items[0].expectedFileName + " …（共 " + result.count + " 张）";

            var hint;
            if (result.folderAvailable === false) {
                hint = "尚未选择目录，从 1 开始计算";
            } else if (result.existingCount > 0) {
                hint = "目录中已有 " + result.existingCount + " 个同前缀文件，最大序号 " + result.maxNumber;
            } else {
                hint = "目录中没有同前缀文件，从 1 开始";
            }
            setHint(hint + "；编号为预计值，跳过项不占编号");
        });
    }

    /* ---------- folder ---------- */

    function rememberFolder(folder) {
        state.lastFolder = folder;
        storeSet(STORAGE_KEYS.lastFolder, folder);
    }

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
            // A manual choice is remembered and is not overridden by the
            // document-follow rule for this document.
            state.folderEdited = true;
            state.folderSource = "manual";
            rememberFolder(result.path);
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
        els.prefix.disabled = busy;
        els.refreshSelection.disabled = busy;
        els.quality.disabled = busy;
        var i;
        var modeButtons = els.mode.querySelectorAll("button");
        for (i = 0; i < modeButtons.length; i++) {
            modeButtons[i].disabled = busy;
        }
        var formatButtons = els.format.querySelectorAll("button");
        for (i = 0; i < formatButtons.length; i++) {
            formatButtons[i].disabled = busy;
        }
        var digitButtons = els.digits.querySelectorAll("button");
        for (i = 0; i < digitButtons.length; i++) {
            digitButtons[i].disabled = busy;
        }
        var settingButtons = els.numbering.querySelectorAll("button");
        for (i = 0; i < settingButtons.length; i++) {
            settingButtons[i].disabled = busy;
        }
        var folderModeButtons = els.folderMode.querySelectorAll("button");
        for (i = 0; i < folderModeButtons.length; i++) {
            folderModeButtons[i].disabled = busy;
        }
        els.exportBtn.textContent = exportLabel();

        if (busy) {
            // Drop any in-flight estimate: its token no longer matches.
            state.estimateToken = state.estimateToken + 1;
        } else if (els.estimateValue.textContent === "正在估算…") {
            invalidateEstimate();
        }
    }

    function doExport() {
        if (state.mode === "selection") {
            doExportSelection();
        } else {
            doExportDocument();
        }
    }

    function rememberExportFolder() {
        if (state.folder) {
            rememberFolder(state.folder);
        }
    }

    function doExportDocument() {
        if (state.busy) {
            return;
        }
        if (!state.prefix.trim()) {
            setStatus("error", "请输入文件名前缀");
            els.prefix.focus();
            return;
        }
        if (!state.folder) {
            setStatus("error", "请选择输出文件夹");
            return;
        }

        setBusy(true);
        setStatus("busy", "正在导出，请稍候…");

        CEPBridge.call("exportImage", scanArguments(), function (result) {
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

            rememberExportFolder();
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

    function doExportSelection() {
        if (state.busy) {
            return;
        }
        if (!state.prefix.trim()) {
            setStatus("error", "请输入文件名前缀");
            els.prefix.focus();
            return;
        }
        if (!state.folder) {
            setStatus("error", "请选择输出文件夹");
            return;
        }
        if (!state.selectionKey) {
            setStatus("error", "还没有读取到当前选择，请先选中图层并等待预览更新。");
            updatePreview();
            return;
        }

        setBusy(true);
        setStatus("busy", "正在批量导出，请稍候…");

        var args = scanArguments();
        args.selectionKey = state.selectionKey;

        CEPBridge.call("exportSelectedLayers", args, function (result) {
            setBusy(false);

            if (result.code === "SELECTION_CHANGED") {
                state.selectionKey = "";
                setStatus("error", "选中的图层或文档已发生变化，已重新读取，请确认后再导出。");
                updatePreview();
                return;
            }

            // Partial results must survive ok:false: files that were written
            // stay on disk and are shown to the user.
            renderBatchResult(result);
            if (result.ok) {
                rememberExportFolder();
            }

            if (!result.ok) {
                setStatus("error", result.message || "批量导出失败");
            }
            updatePreview();
            refreshDocument();
        });
    }

    function renderBatchResult(result) {
        var successes = result.successes || [];
        var skipped = result.skipped || [];
        var failed = result.failed || null;
        var counts = result.counts || {
            exported: successes.length,
            skipped: skipped.length,
            failed: failed ? 1 : 0,
            unprocessed: result.unprocessedCount || 0
        };

        var lines = [];
        if (result.ok) {
            if (counts.exported === 0 && counts.skipped > 0) {
                lines[lines.length] = "未导出，已跳过 " + counts.skipped + " 项";
            } else {
                lines[lines.length] = "已导出 " + counts.exported + " 张" +
                    (counts.skipped ? "，跳过 " + counts.skipped + " 项" : "");
            }
        } else {
            lines[lines.length] = "成功 " + counts.exported + " 张后停止" +
                (counts.skipped ? "，跳过 " + counts.skipped + " 项" : "") +
                (counts.unprocessed ? "，未处理 " + counts.unprocessed + " 项" : "");
        }
        var warnings = result.warnings || [];
        for (var i = 0; i < warnings.length; i++) {
            lines[lines.length] = warnings[i];
        }
        var cleanupErrors = result.cleanupErrors || [];
        for (i = 0; i < cleanupErrors.length; i++) {
            lines[lines.length] = "清理问题：" + cleanupErrors[i];
        }
        setStatus(result.ok ? "ok" : "error", lines.join("\n"));

        var details = [];
        for (i = 0; i < successes.length; i++) {
            details[details.length] = "成功  " + successes[i].fileName + "  ←  " + successes[i].name;
        }
        for (i = 0; i < skipped.length; i++) {
            details[details.length] = "跳过  " + skipped[i].name + "  —  " +
                (skipped[i].message || skipped[i].code);
        }
        if (failed) {
            details[details.length] = "失败  " + (failed.name || "未知对象") + "  —  " +
                (failed.message || failed.code) +
                (failed.phase ? "（阶段：" + failed.phase + "）" : "");
        }
        for (i = 0; i < cleanupErrors.length; i++) {
            details[details.length] = "清理  " + cleanupErrors[i];
        }
        els.batchDetailsBody.textContent = details.join("\n");
        els.batchDetails.classList.toggle("hidden", details.length === 0);
        els.batchDetails.open = details.length > 0 && !result.ok;

        var paths = [];
        for (i = 0; i < successes.length; i++) {
            if (successes[i].fullPath) {
                paths[paths.length] = successes[i].fullPath;
            }
        }
        if (paths.length > 0) {
            state.lastPath = paths.join("\n");
            els.lastPath.textContent = state.lastPath;
            els.lastPath.title = state.lastPath;
            els.last.classList.remove("hidden");
        }
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

    function clickedSegButton(container, attribute, event) {
        var button = event.target;
        while (button && button !== container && !button.getAttribute(attribute)) {
            button = button.parentNode;
        }
        if (!button || button === container) {
            return null;
        }
        return button;
    }

    function bindEvents() {
        els.prefix.addEventListener("input", function () {
            // Typing claims the prefix for this document: the 5 s status poll
            // must never overwrite what the user is editing with the default.
            state.prefixEdited = true;
            state.prefix = els.prefix.value;
            setPrefixNote("");
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
            var button = clickedSegButton(els.digits, "data-digits", event);
            if (!button) {
                return;
            }
            state.digits = parseInt(button.getAttribute("data-digits"), 10);
            storeSet(STORAGE_KEYS.digits, String(state.digits));
            renderDigits();
            updatePreview();
        });

        els.format.addEventListener("click", function (event) {
            var button = clickedSegButton(els.format, "data-format", event);
            if (!button || state.busy) {
                return;
            }
            var format = button.getAttribute("data-format") === FORMAT_JPG ? FORMAT_JPG : FORMAT_PNG;
            if (format === state.format) {
                return;
            }
            state.format = format;
            storeSet(STORAGE_KEYS.format, format);
            renderFormat();
            setStatus("info", format === FORMAT_JPG
                ? "JPG 导出：透明区域会填成白色，质量可在上方调整。"
                : "PNG 导出：保留透明通道。");
            updatePreview();
            invalidateEstimate();
        });

        els.quality.addEventListener("input", function () {
            var quality = parseInt(els.quality.value, 10);
            state.quality = (quality >= 0 && quality <= 12) ? quality : 10;
            renderQuality();
        });
        els.quality.addEventListener("change", function () {
            // Only a released slider re-estimates; dragging is just a label.
            storeSet(STORAGE_KEYS.quality, String(state.quality));
            invalidateEstimate();
        });

        els.numbering.addEventListener("click", function (event) {
            var button = clickedSegButton(els.numbering, "data-numbering", event);
            if (!button || state.busy) {
                return;
            }
            state.numbering = button.getAttribute("data-numbering") === "separate"
                ? "separate"
                : "shared";
            storeSet(STORAGE_KEYS.numbering, state.numbering);
            renderSettings();
            setStatus("info", state.numbering === "separate"
                ? "编号策略：PNG 与 JPG 各自计数。"
                : "编号策略：PNG 与 JPG 共用同一个序列。");
            updatePreview();
        });

        els.folderMode.addEventListener("click", function (event) {
            var button = clickedSegButton(els.folderMode, "data-folder-mode", event);
            if (!button || state.busy) {
                return;
            }
            state.folderMode = button.getAttribute("data-folder-mode") === "last"
                ? "last"
                : "document";
            storeSet(STORAGE_KEYS.folderMode, state.folderMode);
            state.folderEdited = false;
            if (state.folderMode === "last" && state.lastFolder) {
                state.folder = state.lastFolder;
                state.folderSource = "last";
                storeSet(STORAGE_KEYS.folder, state.folder);
                renderFolder();
                updatePreview();
            }
            renderSettings();
            setStatus("info", state.folderMode === "document"
                ? "输出目录：打开已保存的文档时自动跟随它所在的文件夹。"
                : "输出目录：沿用上次导出用过的文件夹。");
            refreshDocument();
        });

        els.pick.addEventListener("click", pickFolder);
        els.exportBtn.addEventListener("click", doExport);
        els.copy.addEventListener("click", copyLastPath);
        els.open.addEventListener("click", openFolder);
        els.refreshSelection.addEventListener("click", function () {
            if (!state.busy) {
                updatePreview();
            }
        });

        els.mode.addEventListener("click", function (event) {
            var button = clickedSegButton(els.mode, "data-mode", event);
            if (!button || state.busy) {
                return;
            }
            var mode = button.getAttribute("data-mode");
            if (mode !== "document" && mode !== "selection") {
                return;
            }
            state.mode = mode;
            storeSet(STORAGE_KEYS.mode, mode);
            renderMode();
            setStatus("info", mode === "selection"
                ? "选中图层模式：在 Photoshop 中选中若干图层或组，导出的每张图片只显示一个对象。"
                : "整图模式：导出一张包含全部可见图层的图片。");
            if (mode === "document") {
                invalidateEstimate();
            }
            updatePreview();
        });

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
        els.prefixNote = byId("prefix-note");
        els.digits = byId("digits");
        els.format = byId("format");
        els.qualityRow = byId("quality-row");
        els.quality = byId("quality");
        els.qualityValue = byId("quality-value");
        els.folderPath = byId("folder-path");
        els.folderSource = byId("folder-source");
        els.pick = byId("pick-folder");
        els.exportBtn = byId("export");
        els.status = byId("status");
        els.nextFile = byId("next-file");
        els.nextHint = byId("next-hint");
        els.estimateRow = byId("estimate-row");
        els.estimateValue = byId("estimate-value");
        els.docInfo = byId("doc-info");
        els.mockNote = byId("mock-note");
        els.last = byId("last-export");
        els.lastPath = byId("last-path");
        els.copy = byId("copy-path");
        els.open = byId("open-folder");
        els.mode = byId("mode");
        els.selectionBox = byId("selection-box");
        els.selectionSummary = byId("selection-summary");
        els.selectionList = byId("selection-list");
        els.refreshSelection = byId("refresh-selection");
        els.batchDetails = byId("batch-details");
        els.batchDetailsBody = byId("batch-details-body");
        els.settings = byId("settings");
        els.numbering = byId("numbering");
        els.folderMode = byId("folder-mode");

        restoreState();
        bindEvents();

        els.prefix.value = state.prefix;
        renderDigits();
        renderFormat();
        renderFolder();
        renderSettings();
        renderMode();
        CEPBridge.applyTheme();
        if (CEPBridge.isMock()) {
            els.mockNote.classList.remove("hidden");
        }

        setStatus("", "就绪。填写前缀、选好目录即可导出 PNG 或 JPG。");
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
