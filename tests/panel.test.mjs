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
  for (const label of ["前缀", "位数", "输出目录", "下一个文件", "快速导出 PNG"]) {
    assert.ok(html.includes(label), `missing UI text: ${label}`);
  }
  // No overwrite is enforced by the host: the panel must never send a name.
  assert.equal(/exportPng[\s\S]{0,200}?fileName/.test(panel), false);
});
