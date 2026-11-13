/*
 * Behaviour test for the panel's "default prefix vs. typed prefix" state
 * machine. js/panel.js cannot be imported as a module, so the panel is run in a
 * small hand-made DOM inside a vm context, with the real CEPBridge mock backend.
 *
 * Regression it guards: the 5 s status poll used to re-apply the document name
 * and revert whatever the user had just typed into the prefix field.
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
    focus() {},
    fire(type, event) {
      (element.handlers[type] || []).forEach((handler) =>
        handler(event || { target: element, key: "", preventDefault() {} }));
    }
  };
  return element;
}

function bootPanel(options = {}) {
  const ids = [
    "prefix", "prefix-note", "digits", "folder-path", "pick-folder", "export",
    "status", "next-file", "next-hint", "doc-info", "mock-note", "last-export",
    "last-path", "copy-path", "open-folder", "mode", "selection-box",
    "selection-summary", "selection-list", "refresh-selection", "batch-details",
    "batch-details-body", "format", "quality-row", "quality", "quality-value",
    "folder-source", "estimate-row", "estimate-value", "settings", "numbering",
    "folder-mode", "collage-box", "collage-columns", "collage-grid",
    "collage-original", "collage-width", "collage-height", "collage-size-hint",
    "collage-list"
  ];
  const elements = new Map(ids.map((id) => [id, makeElement(id)]));
  const storage = new Map(Object.entries(options.initialStorage || {}));
  const pollCallbacks = [];

  const body = makeElement("body");
  const document = {
    readyState: "complete",
    hidden: false,
    body,
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
    // Run timers immediately: the preview/mock calls become synchronous.
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

  const sandbox = { window, document, __storage: storage };
  sandbox.window.CEPBridge = undefined;
  const context = createContext(sandbox);
  context.window = window;
  context.document = document;

  runInContext(readFileSync(join(repoRoot, "jsx", "core.jsx"), "utf8"), context, {
    filename: "jsx/core.jsx"
  });
  runInContext(readFileSync(join(repoRoot, "js", "cep-bridge.js"), "utf8"), context, {
    filename: "js/cep-bridge.js"
  });
  runInContext(readFileSync(join(repoRoot, "js", "panel.js"), "utf8"), context, {
    filename: "js/panel.js"
  });

  return { elements, storage, pollCallbacks, context };
}

test("panel fills the prefix from the document name, then keeps what is typed", () => {
  const { elements, storage, pollCallbacks } = bootPanel();
  const prefix = elements.get("prefix");

  // 1. Initial status (mock document "示例海报.psd") fills the default prefix.
  assert.equal(prefix.value, "示例海报");
  assert.equal(pollCallbacks.length, 1, "the status poll should be scheduled once");

  // 2. The user types a custom prefix.
  prefix.value = "2610-10-自定义";
  prefix.fire("input");
  assert.equal(storage.get("qpe.prefix"), "2610-10-自定义");

  // 3. The 5 s status poll must NOT revert the field to the document name.
  pollCallbacks[0]();
  assert.equal(prefix.value, "2610-10-自定义");
  assert.equal(storage.get("qpe.prefix"), "2610-10-自定义");

  // 4. Clearing the field is a deliberate edit too; the default must not return.
  prefix.value = "";
  prefix.fire("input");
  pollCallbacks[0]();
  assert.equal(prefix.value, "");
});

test("panel preview follows the typed prefix instead of the default", () => {
  const { elements } = bootPanel();
  const prefix = elements.get("prefix");

  prefix.value = "custom-name";
  prefix.fire("input");
  assert.equal(elements.get("next-file").textContent, "custom-name-01.png");
});

function bootCollage(extraStorage = {}) {
  return bootPanel({
    initialStorage: Object.assign({ "qpe.mode": "collage" }, extraStorage)
  });
}

test("collage mode shows the grid derived from the effective object count", () => {
  const { elements } = bootCollage();

  assert.equal(elements.get("collage-box").classList.contains("hidden"), false);
  assert.equal(elements.get("selection-box").classList.contains("hidden"), true);
  // Collage never estimates a file size: one image, many cells.
  assert.equal(elements.get("estimate-row").classList.contains("hidden"), true);

  assert.equal(elements.get("collage-grid").textContent, "3 张 → 2 列 × 2 行");
  assert.equal(elements.get("collage-columns").value, "2");
  assert.equal(elements.get("collage-original").textContent, "2160 × 3840 px");
  assert.equal(elements.get("collage-size-hint").textContent,
    "原始 2160 × 3840 → 导出 2160 × 3840");

  // Valid and skipped objects are both listed, with the skip reason.
  assert.match(elements.get("collage-list").textContent, /· 标题文字/);
  assert.match(elements.get("collage-list").textContent, /· 组 装饰组/);
  assert.match(elements.get("collage-list").textContent,
    /× 剪贴高光：依赖下方图层（剪贴蒙版），已跳过/);
  assert.equal(elements.get("next-file").textContent, "示例海报-04.png");
});

test("collage column count is clamped to the object count and remembered", () => {
  const { elements, storage } = bootCollage();
  const columns = elements.get("collage-columns");

  columns.value = "9";
  columns.fire("input");
  // Typing gives immediate feedback but does not rewrite the field yet.
  assert.equal(columns.value, "9");
  assert.match(elements.get("collage-size-hint").textContent, /列数已按 3 张限制为 3 列/);

  columns.fire("change");
  assert.equal(columns.value, "3");
  assert.equal(storage.get("qpe.collageColumns"), "3");
  assert.equal(elements.get("collage-grid").textContent, "3 张 → 3 列 × 1 行");
  assert.equal(elements.get("collage-original").textContent, "3240 × 1920 px");
});

test("collage target size keeps the aspect ratio and refuses to upscale", () => {
  const { elements, storage } = bootCollage();
  const width = elements.get("collage-width");
  const height = elements.get("collage-height");

  // Typing the width fills the height (1000 * 3840 / 2160 = 1778).
  width.value = "1000";
  width.fire("input");
  assert.equal(height.value, "1778");
  assert.equal(elements.get("collage-size-hint").textContent,
    "原始 2160 × 3840 → 导出 1000 × 1778");

  // Typing the height drives the width instead (1000 * 2160 / 3840 = 563).
  height.value = "1000";
  height.fire("input");
  assert.equal(width.value, "563");
  assert.equal(elements.get("collage-size-hint").textContent,
    "原始 2160 × 3840 → 导出 563 × 1000");

  // Upscaling is refused with a red hint.
  width.value = "3000";
  width.fire("input");
  assert.match(elements.get("collage-size-hint").textContent, /不能大于原始拼图尺寸/);
  assert.match(elements.get("collage-size-hint").className, /error/);

  // Clearing both fields restores the original collage size.
  width.value = "";
  height.value = "";
  height.fire("input");
  assert.equal(elements.get("collage-size-hint").textContent,
    "原始 2160 × 3840 → 导出 2160 × 3840");
  assert.equal(height.value, "");

  // The target size is memory-only.
  assert.equal(Array.from(storage.keys()).some((key) => /target/i.test(key)), false);
});

test("collage export is blocked while the target size is invalid", () => {
  const { elements } = bootCollage({
    "qpe.folder": "C:\\Users\\Public\\Pictures\\PNG 输出"
  });
  const width = elements.get("collage-width");
  width.value = "3000";
  width.fire("input");

  elements.get("export").fire("click");
  assert.match(elements.get("status").textContent, /请调整目标尺寸后再导出/);
  // No export happened: neither the details nor the last-export block was filled.
  assert.equal(elements.get("batch-details-body").textContent, "");
  assert.equal(elements.get("last-path").textContent, "");
});
