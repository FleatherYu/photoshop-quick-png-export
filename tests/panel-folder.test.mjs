/*
 * Behaviour test for the "default output folder" state machine in js/panel.js.
 *
 * The panel is run in a small hand-made DOM with a scripted CEPBridge so the
 * test can decide exactly which document is open when the status poll runs.
 * It guards the rules from the 1.2.0 spec:
 *   - follow the saved document's folder (default),
 *   - a manual folder choice wins for the current document,
 *   - switching documents re-applies the rule,
 *   - an unsaved document falls back to the last used folder,
 *   - "remember the last folder" (1.1.0 behaviour) never follows documents.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function classListOf(element) {
  const names = new Set();
  return {
    add(...list) {
      list.forEach((name) => names.add(name));
    },
    remove(...list) {
      list.forEach((name) => names.delete(name));
    },
    contains(name) {
      return names.has(name);
    },
    toggle(name, force) {
      const on = force === undefined ? !names.has(name) : Boolean(force);
      if (on) {
        names.add(name);
      } else {
        names.delete(name);
      }
      return on;
    }
  };
}

function makeElement(id) {
  const element = {
    id,
    value: "",
    textContent: "",
    className: "",
    title: "",
    disabled: false,
    parentNode: null,
    handlers: {},
    classList: classListOf(),
    addEventListener(type, handler) {
      (element.handlers[type] = element.handlers[type] || []).push(handler);
    },
    setAttribute(name, value) {
      element[name] = String(value);
    },
    getAttribute(name) {
      return element[name];
    },
    querySelectorAll() {
      return [];
    },
    appendChild() {},
    removeChild() {},
    fire(type, event) {
      (element.handlers[type] || []).forEach((handler) =>
        handler(event || { target: element, key: "", preventDefault() {} }));
    }
  };
  return element;
}

function makeButton(container, attributes) {
  const button = makeElement("button");
  Object.keys(attributes).forEach((name) => {
    button[name] = attributes[name];
  });
  button.parentNode = container;
  return button;
}

function docStatus(name, path) {
  return {
    ok: true,
    hasDocument: true,
    name,
    width: 800,
    height: 600,
    mode: "RGB",
    bitDepth: 8,
    layerCount: 3,
    saved: Boolean(path),
    path: path || "",
    suggestedPrefix: name.replace(/\.[A-Za-z0-9]+$/, ""),
    suggestedAdjusted: false
  };
}

function bootPanel(options) {
  const settings = options || {};
  const ids = [
    "prefix", "prefix-note", "digits", "folder-path", "pick-folder", "export",
    "status", "next-file", "next-hint", "doc-info", "mock-note", "last-export",
    "last-path", "copy-path", "open-folder", "mode", "selection-box",
    "selection-summary", "selection-list", "refresh-selection", "batch-details",
    "batch-details-body", "format", "quality-row", "quality", "quality-value",
    "folder-source", "estimate-row", "estimate-value", "settings", "numbering",
    "folder-mode"
  ];
  const elements = new Map(ids.map((id) => [id, makeElement(id)]));
  const storage = new Map(Object.entries(settings.initialStorage || {}));
  const pollCallbacks = [];
  const requests = [];

  const formatContainer = elements.get("format");
  const pngButton = makeButton(formatContainer, { "data-format": "png" });
  const jpgButton = makeButton(formatContainer, { "data-format": "jpg" });
  formatContainer.querySelectorAll = () => [pngButton, jpgButton];

  const folderModeContainer = elements.get("folder-mode");
  const followButton = makeButton(folderModeContainer, { "data-folder-mode": "document" });
  const lastButton = makeButton(folderModeContainer, { "data-folder-mode": "last" });
  folderModeContainer.querySelectorAll = () => [followButton, lastButton];

  let currentStatus = settings.initialStatus || docStatus("A.psd", "D:\\work\\A");
  const setStatusResult = (result) => {
    currentStatus = result;
  };

  const bridge = {
    isMock() {
      return true;
    },
    applyTheme() {},
    call(method, args, callback) {
      requests.push({ method, args });
      if (method === "status") {
        callback(currentStatus);
        return;
      }
      if (method === "preview") {
        callback({
          ok: true,
          fileName: "preview-01.png",
          nextNumber: 1,
          maxNumber: 0,
          existingCount: 0,
          folderAvailable: true
        });
        return;
      }
      if (method === "estimateSize") {
        callback({ ok: true, bytes: 1048576 });
        return;
      }
      if (method === "pickFolder") {
        callback({ ok: true, path: settings.pickPath || "D:\\manual" });
        return;
      }
      callback({ ok: true });
    }
  };

  const document = {
    readyState: "complete",
    hidden: false,
    body: makeElement("body"),
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener() {},
    createElement() {
      return makeElement("tmp");
    },
    execCommand() {
      return false;
    }
  };

  const window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      }
    },
    // Run timers immediately: preview and bridge calls become synchronous.
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    setInterval(callback) {
      pollCallbacks.push(callback);
      return pollCallbacks.length;
    }
  };

  const sandbox = { window, document, CEPBridge: bridge };
  const context = createContext(sandbox);
  context.window = window;
  context.document = document;

  runInContext(readFileSync(join(repoRoot, "js", "panel.js"), "utf8"), context, {
    filename: "js/panel.js"
  });

  return {
    elements,
    storage,
    pollCallbacks,
    requests,
    setStatusResult,
    poll() {
      pollCallbacks[0]();
    },
    folderText() {
      return elements.get("folder-path").textContent;
    },
    sourceText() {
      return elements.get("folder-source").textContent;
    }
  };
}

test("follows the saved document folder and re-applies it on document switch", () => {
  const panel = bootPanel({
    initialStorage: { "qpe.folder": "D:\\old" },
    initialStatus: docStatus("A.psd", "D:\\work\\A")
  });

  assert.equal(panel.folderText(), "D:\\work\\A");
  assert.equal(panel.sourceText(), "来源：文档所在文件夹");
  assert.equal(panel.storage.get("qpe.folder"), "D:\\work\\A");

  panel.setStatusResult(docStatus("B.psd", "D:\\work\\B"));
  panel.poll();
  assert.equal(panel.folderText(), "D:\\work\\B");
  assert.equal(panel.sourceText(), "来源：文档所在文件夹");
});

test("a manual folder choice is preserved within the same document", () => {
  const panel = bootPanel({ initialStatus: docStatus("A.psd", "D:\\work\\A") });

  panel.elements.get("pick-folder").fire("click");
  assert.equal(panel.folderText(), "D:\\manual");
  assert.equal(panel.sourceText(), "来源：手动选择");
  assert.equal(panel.storage.get("qpe.folder"), "D:\\manual");
  assert.equal(panel.storage.get("qpe.lastFolder"), "D:\\manual");
  assert.equal(
    panel.requests.find((request) => request.method === "pickFolder").args.current,
    "D:\\work\\A"
  );

  panel.poll(); // same document: the manual choice must not be overridden
  assert.equal(panel.folderText(), "D:\\manual");
  assert.equal(panel.sourceText(), "来源：手动选择");
});

test("switching documents after a manual choice follows the new document", () => {
  const panel = bootPanel({ initialStatus: docStatus("A.psd", "D:\\work\\A") });

  panel.elements.get("pick-folder").fire("click");
  assert.equal(panel.folderText(), "D:\\manual");

  panel.setStatusResult(docStatus("B.psd", "D:\\work\\B"));
  panel.poll();
  assert.equal(panel.folderText(), "D:\\work\\B");
  assert.equal(panel.sourceText(), "来源：文档所在文件夹");
});

test("an unsaved document falls back to the last used folder", () => {
  const panel = bootPanel({
    initialStorage: { "qpe.folder": "D:\\remembered" },
    initialStatus: docStatus("未命名-1", "")
  });

  assert.equal(panel.folderText(), "D:\\remembered");
  assert.equal(panel.sourceText(), "来源：上次使用的位置");

  panel.setStatusResult(docStatus("C.psd", "D:\\work\\C"));
  panel.poll();
  assert.equal(panel.folderText(), "D:\\work\\C");
});

test("a manual choice becomes the remembered folder for unsaved documents", () => {
  const panel = bootPanel({ initialStatus: docStatus("A.psd", "D:\\work\\A") });

  panel.elements.get("pick-folder").fire("click");
  panel.setStatusResult(docStatus("未命名-2", ""));
  panel.poll();

  assert.equal(panel.folderText(), "D:\\manual");
  assert.equal(panel.sourceText(), "来源：上次使用的位置");
});

test("remember-last mode never follows the document", () => {
  const panel = bootPanel({
    initialStorage: { "qpe.folder": "D:\\old", "qpe.folderMode": "last" },
    initialStatus: docStatus("A.psd", "D:\\work\\A")
  });

  assert.equal(panel.folderText(), "D:\\old");

  panel.setStatusResult(docStatus("B.psd", "D:\\work\\B"));
  panel.poll();
  assert.equal(panel.folderText(), "D:\\old");
});

test("switching to follow mode re-applies the current document folder", () => {
  const panel = bootPanel({
    initialStorage: { "qpe.folder": "D:\\old", "qpe.folderMode": "last" },
    initialStatus: docStatus("A.psd", "D:\\work\\A")
  });
  assert.equal(panel.folderText(), "D:\\old");

  panel.elements.get("folder-mode").fire("click", {
    target: makeButton(panel.elements.get("folder-mode"), { "data-folder-mode": "document" }),
    preventDefault() {}
  });
  assert.equal(panel.storage.get("qpe.folderMode"), "document");
  assert.equal(panel.folderText(), "D:\\work\\A");
  assert.equal(panel.sourceText(), "来源：文档所在文件夹");
});

test("switching to remember-last mode restores the remembered folder", () => {
  const panel = bootPanel({
    initialStorage: {
      "qpe.folder": "D:\\work\\A",
      "qpe.lastFolder": "D:\\lastpick",
      "qpe.folderMode": "document"
    },
    initialStatus: docStatus("A.psd", "D:\\work\\A")
  });
  assert.equal(panel.folderText(), "D:\\work\\A");

  panel.elements.get("folder-mode").fire("click", {
    target: makeButton(panel.elements.get("folder-mode"), { "data-folder-mode": "last" }),
    preventDefault() {}
  });
  assert.equal(panel.storage.get("qpe.folderMode"), "last");
  assert.equal(panel.folderText(), "D:\\lastpick");
  assert.equal(panel.sourceText(), "来源：上次使用的位置");
});

test("format, quality and numbering choices are persisted", () => {
  const panel = bootPanel({ initialStatus: docStatus("A.psd", "D:\\work\\A") });

  panel.elements.get("format").fire("click", {
    target: makeButton(panel.elements.get("format"), { "data-format": "jpg" }),
    preventDefault() {}
  });
  assert.equal(panel.storage.get("qpe.format"), "jpg");
  assert.equal(panel.elements.get("export").textContent, "快速导出 JPG");
  assert.equal(panel.elements.get("quality-row").classList.contains("hidden"), false);

  const quality = panel.elements.get("quality");
  quality.value = "4";
  quality.fire("input");
  assert.equal(panel.elements.get("quality-value").textContent, "4（中）");
  quality.fire("change");
  assert.equal(panel.storage.get("qpe.quality"), "4");

  const numbering = panel.elements.get("numbering");
  numbering.fire("click", {
    target: makeButton(numbering, { "data-numbering": "separate" }),
    preventDefault() {}
  });
  assert.equal(panel.storage.get("qpe.numbering"), "separate");

  // A newer estimate invalidates the old one; the last one wins.
  const estimates = panel.requests.filter((request) => request.method === "estimateSize");
  assert.ok(estimates.length >= 2);
  assert.equal(estimates[estimates.length - 1].args.format, "jpg");
  assert.equal(estimates[estimates.length - 1].args.quality, 4);
});
