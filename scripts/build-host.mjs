#!/usr/bin/env node
/*
 * Concatenates jsx/core.jsx + jsx/host-body.jsx into the shipped
 * jsx/host.jsx that CEP loads as the panel's ScriptPath.
 *
 * Why a build step instead of ExtendScript's #include: CEP evaluates
 * ScriptPath through its own loader, where relative #include resolution is
 * poorly documented and version dependent. A generated single file removes
 * that failure mode. tests/core.test.mjs verifies the generated file is
 * exactly up to date.
 *
 * Usage: node scripts/build-host.mjs [--check]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const HEADER = `/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built from jsx/core.jsx + jsx/host-body.jsx by scripts/build-host.mjs.
 * Regenerate with: node scripts/build-host.mjs
 */

`;

function readPart(name) {
  return readFileSync(join(repoRoot, "jsx", name), "utf8").replace(/^\uFEFF/, "");
}

// ExtendScript parses the generated file with the host's own file reader, whose
// encoding detection is not guaranteed across Photoshop versions/locales: the
// same Chinese literals that load fine when the panel passes them as a string
// failed with "类型错误: 无法转换" when Photoshop read jsx/host.jsx itself from
// disk (Photoshop CC 2019 20.0.10, zh-CN Windows). Escaping every non-ASCII
// code unit to \uXXXX keeps the file pure ASCII, so it parses identically on
// every host and locale while the runtime strings stay unchanged.
function toAsciiEscapes(source) {
  return source.replace(/[^\x00-\x7F]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function buildHostSource() {
  const core = readPart("core.jsx").replace(/\s+$/, "");
  const body = readPart("host-body.jsx").replace(/\s+$/, "");
  return toAsciiEscapes(`${HEADER}${core}\n\n${body}\n`);
}

export function hostPath() {
  return join(repoRoot, "jsx", "host.jsx");
}

function runCli() {
  const isCheck = process.argv.includes("--check");
  const target = hostPath();
  const expected = buildHostSource();

  if (isCheck) {
    let actual = "";
    try {
      actual = readFileSync(target, "utf8");
    } catch {
      console.error("jsx/host.jsx is missing. Run: node scripts/build-host.mjs");
      process.exit(1);
    }
    if (actual !== expected) {
      console.error("jsx/host.jsx is out of date. Run: node scripts/build-host.mjs");
      process.exit(1);
    }
    console.log("jsx/host.jsx is up to date.");
    return;
  }

  writeFileSync(target, expected, "utf8");
  console.log(`wrote ${target} (${expected.length} chars)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
