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
    fire(type, event) {
      (element.handlers[type] || []).forEach((handler) =>
        handler(event || { target: element, key: "", preventDefault() {} }));
    }
  };
  return element;
}

function bootPanel() {
  const ids = [
    "prefix", "prefix-note", "digits", "folder-path", "pick-folder", "export",
    "status", "next-file", "next-hint", "doc-info", "mock-note", "last-export",
    "last-path", "copy-path", "open-folder", "mode", "selection-box",
    "selection-summary", "selection-list", "refresh-selection", "batch-details",
    "batch-details-body"
  ];
  const elements = new Map(ids.map((id) => [id, makeElement(id)]));
  const storage = new Map();
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

  runInContext(readFileSync(join(repoRoot, "js", "cep-bridge.js"), "utf8"), context, {
    filename: "js/cep-bridge.js"
  });
  runInContext(readFileSync(join(repoRoot, "js", "panel.js"), "utf8"), context, {
    filename: "js/panel.js"
  });

  return { elements, storage, pollCallbacks };
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
