import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");
const panel = readFileSync(join(repoRoot, "js", "panel.js"), "utf8");
const bridge = readFileSync(join(repoRoot, "js", "cep-bridge.js"), "utf8");
const css = readFileSync(join(repoRoot, "css", "style.css"), "utf8");

test("index.html references only shipped local assets", () => {
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(references.length >= 3, references.join(","));
  for (const reference of references) {
    assert.equal(/^(https?:)?\/\//.test(reference), false, `remote asset: ${reference}`);
    assert.ok(existsSync(join(repoRoot, reference)), `missing asset: ${reference}`);
  }
});

test("every element the panel looks up exists in index.html", () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const looked = [...panel.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(looked.length >= 10, looked.join(","));
  for (const id of looked) {
    assert.ok(ids.has(id), `panel.js wants #${id} but index.html has no such id`);
  }
  for (const id of ids) {
    assert.ok(looked.includes(id), `index.html id #${id} is never used by panel.js`);
  }
});

test("panel scripts compile as classic browser scripts", () => {
  for (const [name, source] of [["js/cep-bridge.js", bridge], ["js/panel.js", panel]]) {
    assert.doesNotThrow(() => new Function(source), `${name} has a syntax error`);
  }
  assert.equal(/<\/script>/i.test(bridge + panel), false, "scripts must not contain a closing script tag");
});

test("panel only uses bridge methods that the bridge exposes", () => {
  const exposed = new Set([...bridge.matchAll(/^\s{8}(\w+):\s/gm)].map((match) => match[1]));
  const used = new Set([...panel.matchAll(/CEPBridge\.(\w+)\(/g)].map((match) => match[1]));
  assert.ok(used.size >= 3, [...used].join(","));
  for (const method of used) {
    assert.ok(exposed.has(method), `CEPBridge.${method} is not exposed by cep-bridge.js`);
  }
});

test("styles define the theme variables the panel toggles", () => {
  assert.match(css, /body\.theme-dark\s*\{/);
  assert.match(css, /body\.theme-light\s*\{/);
  for (const token of ["--bg", "--fg", "--accent", "--line", "--error", "--warn"]) {
    assert.ok(css.includes(`${token}:`), `missing ${token}`);
  }
});

test("panel UI carries the required labels and behaviours", () => {
  for (const label of [
    "前缀", "位数", "输出目录", "导出名称", "快速导出 PNG",
    "格式", "质量", "预计大小", "编号策略", "跟随文档", "记住上次"
  ]) {
    assert.ok(html.includes(label), `missing UI text: ${label}`);
  }
  // No overwrite is enforced by the host: the panel must never send a name.
  assert.equal(/exportPng[\s\S]{0,200}?fileName/.test(panel), false);
});

test("format, quality and settings controls match the host contract", () => {
  assert.match(html, /data-format="png"/);
  assert.match(html, /data-format="jpg"/);
  const quality = /<input id="quality"[^>]*>/.exec(html);
  assert.ok(quality, "quality slider not found");
  assert.match(quality[0], /type="range"/);
  assert.match(quality[0], /min="0"/);
  assert.match(quality[0], /max="12"/);
  assert.match(quality[0], /step="1"/);
  // The settings section starts collapsed.
  assert.match(html, /<details id="settings" class="settings">/);
  assert.match(panel, /CEPBridge\.call\("estimateSize"/);
  assert.ok(panel.includes("正在估算…"));
  assert.ok(panel.includes("无法估算"));
});

test("typing a prefix stops the document-name default from being re-applied", () => {
  // Regression: the 5 s status poll re-applied the document name and reverted
  // whatever the user typed, unless the input handler claims the field first.
  const inputHandler = /els\.prefix\.addEventListener\("input",\s*function\s*\(\)\s*\{([\s\S]*?)\n\s*\}\);/.exec(panel);
  assert.ok(inputHandler, "prefix input handler not found");
  assert.match(inputHandler[1], /state\.prefixEdited\s*=\s*true/);

  const apply = /function applyDocumentPrefix\(result\)\s*\{([\s\S]*?)\n    \}/.exec(panel);
  assert.ok(apply, "applyDocumentPrefix not found");
  assert.match(apply[1], /state\.prefixEdited/);

  const refresh = /function refreshDocument\(\)\s*\{([\s\S]*?)\n    \}/.exec(panel);
  assert.ok(refresh, "refreshDocument not found");
  assert.match(refresh[1], /result\.name !== state\.lastDocName/);
});

test("collage mode exposes the grid UI and reuses the shared core rules", () => {
  assert.match(html, /data-mode="collage"/);
  // The pure helpers live in jsx/core.jsx and must load before the panel code.
  const coreScript = html.indexOf('src="jsx/core.jsx"');
  const bridgeScript = html.indexOf('src="js/cep-bridge.js"');
  assert.ok(coreScript >= 0, "index.html does not load jsx/core.jsx");
  assert.ok(bridgeScript >= 0, "index.html does not load js/cep-bridge.js");
  assert.ok(coreScript < bridgeScript, "jsx/core.jsx must load before js/cep-bridge.js");

  for (const id of [
    "collage-box", "collage-columns", "collage-grid", "collage-original",
    "collage-width", "collage-height", "collage-size-hint", "collage-list"
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing collage element: ${id}`);
  }
  for (const label of ["拼图", "列数", "原始尺寸", "目标尺寸"]) {
    assert.ok(html.includes(label), `missing collage UI text: ${label}`);
  }

  const columns = /<input id="collage-columns"[^>]*>/.exec(html);
  assert.ok(columns, "collage columns input not found");
  assert.match(columns[0], /type="number"/);
  assert.match(columns[0], /min="1"/);
  assert.match(columns[0], /step="1"/);
  for (const id of ["collage-width", "collage-height"]) {
    const input = new RegExp(`<input id="${id}"[^>]*>`).exec(html);
    assert.ok(input, `${id} input not found`);
    assert.match(input[0], /type="number"/);
    assert.match(input[0], /min="1"/);
  }

  // Grid math and target clamping come from QPECore, never re-implemented here.
  // The automatic column count is reached through normalizeCollageColumns.
  for (const rule of [
    "QPECore.collageRows",
    "QPECore.normalizeCollageColumns",
    "QPECore.collageOriginalSize",
    "QPECore.resolveCollageTarget"
  ]) {
    assert.ok(panel.includes(rule), `panel does not reuse ${rule}`);
  }
  assert.match(panel, /CEPBridge\.call\("previewCollage"/);
  assert.match(panel, /CEPBridge\.call\("exportCollage"/);
  assert.ok(panel.includes("导出拼图 "), "missing collage export label");
  assert.ok(panel.includes("正在导出拼图…"), "missing collage busy label");
  assert.ok(panel.includes("SELECTION_CHANGED"), "panel ignores SELECTION_CHANGED");

  // Target size is in-memory only: the panel must not persist it.
  assert.equal(/qpe\.collageTarget/.test(panel), false, "collage target must not use localStorage");
});

test("collage inputs are disabled while an export is running", () => {
  const setBusy = /function setBusy\(busy\)\s*\{([\s\S]*?)\n    \}/.exec(panel);
  assert.ok(setBusy, "setBusy not found");
  for (const input of ["collageColumns", "collageWidth", "collageHeight"]) {
    assert.match(setBusy[1], new RegExp(`els\\.${input}\\.disabled\\s*=\\s*busy`));
  }
});
