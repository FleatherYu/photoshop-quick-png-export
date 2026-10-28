import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "CSXS", "manifest.xml");

/* ---------- tiny XML reader (no dependencies) ---------- */

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  throw new Error("unterminated tag");
}

function parseAttributes(raw) {
  const attrs = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    attrs[match[1]] = decodeEntities(match[3] ?? match[4]);
  }
  return attrs;
}

export function parseXml(xml) {
  const document = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [document];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const text = lt === -1 ? xml.slice(i) : xml.slice(i, lt);
    if (text.length > 0) {
      stack.at(-1).text += decodeEntities(text);
    }
    if (lt === -1) break;

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new Error("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new Error("unterminated CDATA");
      stack.at(-1).text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }

    const gt = findTagEnd(xml, lt + 1);
    const raw = xml.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (raw.startsWith("!")) continue; // doctype

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) {
        throw new Error(`mismatched closing tag </${name}> (open: ${open?.name})`);
      }
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    const attrs = space === -1 ? {} : parseAttributes(body.slice(space));
    const node = { name, attrs, children: [], text: "" };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) {
    throw new Error(`unclosed tags: ${stack.slice(1).map((node) => node.name).join(", ")}`);
  }
  return document.children[0];
}

function findAll(node, name, found = []) {
  if (node.name === name) found.push(node);
  for (const child of node.children) findAll(child, name, found);
  return found;
}

function find(node, name) {
  return findAll(node, name)[0];
}

/* ---------- tests ---------- */

const xml = readFileSync(manifestPath, "utf8");
const root = parseXml(xml);

test("manifest.xml is well-formed XML with a single root", () => {
  assert.equal(root.name, "ExtensionManifest");
});

test("manifest schema version suits CEP 9 (Photoshop CC 2019)", () => {
  assert.equal(root.attrs.Version, "7.0");
});

test("bundle ids are consistent", () => {
  const bundleId = root.attrs.ExtensionBundleId;
  assert.match(bundleId, /^[A-Za-z0-9._-]+$/);
  assert.equal(bundleId, "com.fleatheryu.quickpngexport");

  const panelId = `${bundleId}.panel`;
  const declared = findAll(find(root, "ExtensionList"), "Extension").map((node) => node.attrs.Id);
  const dispatched = findAll(find(root, "DispatchInfoList"), "Extension").map((node) => node.attrs.Id);
  assert.deepEqual(declared, [panelId]);
  assert.deepEqual(dispatched, [panelId]);
});

test("host list targets Photoshop and covers CC 2019 (20.0)", () => {
  const host = find(root, "Host");
  assert.equal(host.attrs.Name, "PHXS");
  const range = host.attrs.Version.match(/^\[(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)\]$/);
  assert.ok(range, host.attrs.Version);
  const minimum = Number(range[1]);
  const maximum = Number(range[2]);
  assert.ok(minimum <= 20.0, "CC 2019 must be inside the range");
  assert.ok(maximum >= 20.0);
});

test("panel MainPath and ScriptPath point at shipped files", () => {
  const mainPath = find(root, "MainPath").text.trim();
  const scriptPath = find(root, "ScriptPath").text.trim();
  assert.equal(mainPath, "./index.html");
  assert.equal(scriptPath, "./jsx/host.jsx");
  assert.ok(existsSync(join(repoRoot, mainPath.replace(/^\.\//, ""))), mainPath);
  assert.ok(existsSync(join(repoRoot, scriptPath.replace(/^\.\//, ""))), scriptPath);
});

test("panel UI is a dockable Panel with Chinese menu label", () => {
  const ui = find(root, "UI");
  assert.equal(find(ui, "Type").text.trim(), "Panel");
  assert.equal(find(ui, "Menu").text.trim(), "快速 PNG 导出");
  assert.ok(Number(find(ui, "Height").text) > 0);
  assert.ok(Number(find(ui, "Width").text) > 0);
});

test(".debug file matches the panel extension id", () => {
  const debugRoot = parseXml(readFileSync(join(repoRoot, ".debug"), "utf8"));
  const id = find(debugRoot, "Extension").attrs.Id;
  assert.equal(id, "com.fleatheryu.quickpngexport.panel");
});

test("install.ps1 references the same extension id", () => {
  const script = readFileSync(join(repoRoot, "scripts", "install.ps1"), "utf8");
  assert.ok(script.includes("com.fleatheryu.quickpngexport"), "install.ps1 must use the panel id");
});
