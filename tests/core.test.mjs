import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildHostSource } from "../scripts/build-host.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCore() {
  const source = readFileSync(join(repoRoot, "jsx", "core.jsx"), "utf8");
  const context = createContext({});
  runInContext(source, context, { filename: "jsx/core.jsx" });
  return context.QPECore;
}

const core = loadCore();

test("validatePrefix accepts the documented examples", () => {
  for (const prefix of ["261028-123", "character-final", "product_A", "中文-前缀"]) {
    const result = core.validatePrefix(prefix);
    assert.equal(result.ok, true, prefix);
    assert.equal(result.prefix, prefix);
  }
});

test("validatePrefix trims leading/trailing whitespace", () => {
  assert.equal(core.validatePrefix("  261028-123\u3000").prefix, "261028-123");
});

test("validatePrefix rejects empty and whitespace-only input", () => {
  assert.equal(core.validatePrefix("").code, "EMPTY");
  assert.equal(core.validatePrefix("   ").code, "EMPTY");
  assert.equal(core.validatePrefix(null).code, "EMPTY");
  assert.equal(core.validatePrefix(undefined).code, "EMPTY");
});

test("validatePrefix rejects every illegal Windows filename character", () => {
  for (const ch of ["\\", "/", ":", "*", "?", '"', "<", ">", "|"]) {
    const result = core.validatePrefix(`a${ch}b`);
    assert.equal(result.ok, false, ch);
    assert.equal(result.code, "ILLEGAL_CHARS", ch);
    assert.deepEqual([...result.chars], [ch]);
  }
});

test("validatePrefix reports each distinct illegal character once", () => {
  const result = core.validatePrefix("a/b:c?d?");
  assert.equal(result.ok, false);
  assert.deepEqual([...result.chars], ["/", ":", "?"]);
});

test("validatePrefix rejects a trailing dot but allows inner dots", () => {
  assert.equal(core.validatePrefix("abc.").code, "TRAILING_DOT");
  assert.equal(core.validatePrefix("a.b.c").ok, true);
});

test("validatePrefix rejects control characters", () => {
  assert.equal(core.validatePrefix("a\u0007b").code, "ILLEGAL_CHARS");
});

test("validatePrefix enforces the maximum length", () => {
  assert.equal(core.validatePrefix("x".repeat(120)).ok, true);
  assert.equal(core.validatePrefix("x".repeat(121)).code, "TOO_LONG");
});

test("isValidDigits only allows 1, 2 and 3", () => {
  assert.equal(core.isValidDigits(1), true);
  assert.equal(core.isValidDigits(2), true);
  assert.equal(core.isValidDigits(3), true);
  for (const bad of [0, 4, 10, -1, "a", null, undefined]) {
    assert.equal(core.isValidDigits(bad), false, String(bad));
  }
});

test("padNumber pads to a minimum width and never truncates", () => {
  assert.equal(core.padNumber(1, 1), "1");
  assert.equal(core.padNumber(1, 2), "01");
  assert.equal(core.padNumber(1, 3), "001");
  assert.equal(core.padNumber(9, 2), "09");
  assert.equal(core.padNumber(99, 2), "99");
  assert.equal(core.padNumber(100, 2), "100");
  assert.equal(core.padNumber(101, 3), "101");
});

test("buildFileName matches the documented table", () => {
  assert.equal(core.buildFileName("261028-123", 1, 1), "261028-123-1.png");
  assert.equal(core.buildFileName("261028-123", 2, 1), "261028-123-01.png");
  assert.equal(core.buildFileName("261028-123", 3, 1), "261028-123-001.png");
  assert.equal(core.buildFileName("character-final", 2, 7), "character-final-07.png");
});

test("matchSequence recognises only prefix-<digits>.png", () => {
  const prefix = "261028-123";
  assert.equal(core.matchSequence("261028-123-01.png", prefix), 1);
  assert.equal(core.matchSequence("261028-123-01.PNG", prefix), 1);
  assert.equal(core.matchSequence("261028-123-12.png", prefix), 12);
  assert.equal(core.matchSequence("261028-123-007.png", prefix), 7);
  assert.equal(core.matchSequence("261028-123-0.png", prefix), 0);
});

test("matchSequence rejects near-miss names", () => {
  const prefix = "261028-123";
  for (const name of [
    "261028-123-old.png",
    "261028-123-01-copy.png",
    "261028-1234-01.png",
    "other-01.png",
    "261028-123-01.png.bak",
    "261028-123-.png",
    "261028-123.png",
    "261028-123-01 .png",
  ]) {
    assert.equal(core.matchSequence(name, prefix), null, name);
  }
});

test("matchSequence escapes regexp metacharacters in the prefix", () => {
  assert.equal(core.matchSequence("a.b-01.png", "a.b"), 1);
  assert.equal(core.matchSequence("axb-01.png", "a.b"), null);
  assert.equal(core.matchSequence("a+b-02.png", "a+b"), 2);
  assert.equal(core.matchSequence("a(1)-03.png", "a(1)"), 3);
});

test("matchSequence is case-insensitive by default (Windows filesystem)", () => {
  assert.equal(core.matchSequence("ABC-01.png", "abc"), 1);
  assert.equal(core.matchSequence("abc-01.png", "abc", false), 1);
  assert.equal(core.matchSequence("ABC-01.png", "abc", false), null);
});

test("computeNext starts at 1 in an empty folder", () => {
  assert.equal(core.computeNext([], "261028-123").nextNumber, 1);
  assert.equal(core.computeNext([], "261028-123").maxNumber, 0);
});

test("computeNext takes max + 1 and never reuses gaps", () => {
  const prefix = "261028-123";
  assert.equal(core.computeNext(["261028-123-01.png", "261028-123-02.png"], prefix).nextNumber, 3);
  assert.equal(core.computeNext(["261028-123-01.png", "261028-123-03.png"], prefix).nextNumber, 4);
  assert.equal(core.computeNext(["261028-123-09.png", "261028-123-02.png"], prefix).nextNumber, 10);
});

test("computeNext ignores non-matching files and other prefixes", () => {
  const prefix = "261028-123";
  const files = [
    "261028-123-old.png",
    "261028-1234-01.png",
    "readme.txt",
    "261028-123-05.png",
    "261028-124-01.png",
  ];
  const result = core.computeNext(files, prefix);
  assert.equal(result.nextNumber, 6);
  assert.equal(result.maxNumber, 5);
  assert.equal(result.existingCount, 1);
});

/* ---------- export format, numbering strategies and JPEG quality ---------- */

test("normalizeFormat maps jpg/jpeg to jpg and everything else to png", () => {
  assert.equal(core.normalizeFormat("png"), "png");
  assert.equal(core.normalizeFormat("PNG"), "png");
  assert.equal(core.normalizeFormat("jpg"), "jpg");
  assert.equal(core.normalizeFormat("JPG"), "jpg");
  assert.equal(core.normalizeFormat("jpeg"), "jpg");
  assert.equal(core.normalizeFormat("webp"), "png");
  assert.equal(core.normalizeFormat(null), "png");
  assert.equal(core.normalizeFormat(undefined), "png");
});

test("formatExtension returns the lowercase export extension", () => {
  assert.equal(core.formatExtension("png"), ".png");
  assert.equal(core.formatExtension("jpg"), ".jpg");
  assert.equal(core.formatExtension("JPEG"), ".jpg");
});

test("normalizeNumbering defaults to shared and accepts separate", () => {
  assert.equal(core.normalizeNumbering("shared"), "shared");
  assert.equal(core.normalizeNumbering("separate"), "separate");
  assert.equal(core.normalizeNumbering("SEPARATE"), "separate");
  assert.equal(core.normalizeNumbering("nonsense"), "shared");
  assert.equal(core.normalizeNumbering(undefined), "shared");
});

test("isValidJpegQuality accepts only integer numbers from 0 to 12", () => {
  for (const good of [0, 1, 6, 10, 12]) {
    assert.equal(core.isValidJpegQuality(good), true, String(good));
  }
  for (const bad of [-1, 13, 3.5, NaN, Infinity, "10", null, undefined, true]) {
    assert.equal(core.isValidJpegQuality(bad), false, String(bad));
  }
});

test("normalizeJpegQuality falls back to the default 10", () => {
  assert.equal(core.normalizeJpegQuality(2), 2);
  assert.equal(core.normalizeJpegQuality(12), 12);
  assert.equal(core.normalizeJpegQuality(undefined), 10);
  assert.equal(core.normalizeJpegQuality(99), 10);
});

test("buildFileName appends the requested format extension", () => {
  assert.equal(core.buildFileName("p", 2, 1, "png"), "p-01.png");
  assert.equal(core.buildFileName("p", 2, 1, "jpg"), "p-01.jpg");
  assert.equal(core.buildFileName("p", 2, 1), "p-01.png");
});

test("shared numbering counts PNG, JPG and JPEG files together", () => {
  const options = { format: "png", numbering: "shared" };
  const files = ["a-03.png", "a-01.jpg", "a-02.JPEG"];
  const next = core.computeNext(files, "a", true, options);
  assert.equal(next.maxNumber, 3);
  assert.equal(next.existingCount, 3);
  assert.equal(next.nextNumber, 4);
  assert.equal(core.computeExport(files, "a", 2, true, options).fileName, "a-04.png");

  const jpgExport = core.computeExport(files, "a", 2, true, {
    format: "jpg",
    numbering: "shared",
  });
  assert.equal(jpgExport.fileName, "a-04.jpg");
});

test("separate numbering only counts the current export format", () => {
  const files = ["a-03.png", "a-01.jpg", "a-02.jpeg"];
  const pngOptions = { format: "png", numbering: "separate" };
  assert.equal(core.computeNext(files, "a", true, pngOptions).nextNumber, 4);
  assert.equal(core.computeNext(["a-03.png", "a-09.jpg"], "a", true, pngOptions).nextNumber, 4);

  const jpgOptions = { format: "jpg", numbering: "separate" };
  const jpgNext = core.computeNext(files, "a", true, jpgOptions);
  assert.equal(jpgNext.maxNumber, 2);
  assert.equal(jpgNext.existingCount, 2);
  assert.equal(jpgNext.nextNumber, 3);
  assert.equal(core.computeExport(files, "a", 2, true, jpgOptions).fileName, "a-03.jpg");

  // A directory with only PNGs still yields 1 for the separate JPG strategy.
  assert.equal(core.computeNext(["a-05.png"], "a", true, jpgOptions).nextNumber, 1);
});

test("shared numbering decodes percent-encoded Chinese prefixes for JPG", () => {
  const files = ["QPE-%E6%B5%8B%E8%AF%95-03.jpg", "QPE-%E6%B5%8B%E8%AF%95-04.png"];
  const next = core.computeNext(files, "QPE-测试", true, { format: "jpg", numbering: "shared" });
  assert.equal(next.maxNumber, 4);
  assert.equal(next.nextNumber, 5);
});

test("buildBatchNames follows the requested format and numbering strategy", () => {
  const files = ["a-03.png", "a-07.jpg"];
  const sharedJpg = core.buildBatchNames(files, "a", 2, 2, true, {
    format: "jpg",
    numbering: "shared",
  });
  assert.equal(sharedJpg.startNumber, 8);
  assert.deepEqual([...sharedJpg.names], ["a-08.jpg", "a-09.jpg"]);

  const separateJpg = core.buildBatchNames(files, "a", 2, 2, true, {
    format: "jpg",
    numbering: "separate",
  });
  assert.equal(separateJpg.startNumber, 8);

  const separatePng = core.buildBatchNames(files, "a", 2, 1, true, {
    format: "png",
    numbering: "separate",
  });
  assert.equal(separatePng.startNumber, 4);
  assert.deepEqual([...separatePng.names], ["a-04.png"]);
});

test("digits do not reset the numbering across 1/01/001", () => {
  const prefix = "p";
  const files = ["p-1.png", "p-01.png", "p-001.png", "p-2.png"];
  assert.equal(core.computeNext(files, prefix).nextNumber, 3);
  assert.equal(core.buildFileName(prefix, 3, 3), "p-003.png");
});

test("different prefixes are independent", () => {
  const files = ["a-05.png", "b-09.png"];
  assert.equal(core.computeNext(files, "a").nextNumber, 6);
  assert.equal(core.computeNext(files, "b").nextNumber, 10);
  assert.equal(core.computeNext(files, "c").nextNumber, 1);
});

test("computeExport returns the complete next name", () => {
  const result = core.computeExport(["261028-123-03.png"], "261028-123", 2, true);
  assert.equal(result.fileName, "261028-123-04.png");
  assert.equal(result.nextNumber, 4);
});

test("escapeRegExp escapes every special character", () => {
  const special = "\\^$.*+?()[]{}|";
  const escaped = core.escapeRegExp(special);
  for (const ch of special) {
    assert.ok(escaped.includes(`\\${ch}`), ch);
  }
});

test("toJson escapes quotes, backslashes and control characters", () => {
  const json = core.toJson({ text: 'a"b\\c\nd\te' });
  assert.equal(JSON.parse(json).text, 'a"b\\c\nd\te');
});

test("toJson keeps the payload ASCII-only and round-trips Chinese text", () => {
  const value = {
    ok: true,
    message: "已导出：261028-123-01.png（中文）",
    names: ["角色-前缀-01.png"],
    count: 3,
    nothing: null,
  };
  const json = core.toJson(value);
  assert.equal(/[^\x20-\x7E]/.test(json), false, "payload must be ASCII only");
  assert.deepEqual(JSON.parse(json), value);
});

test("toJson omits undefined members and renders arrays", () => {
  const json = core.toJson({ a: 1, b: undefined, c: [true, false, null] });
  assert.equal(json, '{"a":1,"c":[true,false,null]}');
});

test("decodePercentName restores UTF-8 percent-encoded File.name values", () => {
  // Real value reported by ExtendScript in Photoshop CC 2019 for QPE-测试-05.png.
  assert.equal(
    core.decodePercentName("QPE-%E6%B5%8B%E8%AF%95-05.png"),
    "QPE-测试-05.png",
  );
  assert.equal(
    core.decodePercentName("qpe-%E6%B5%8B%E8%AF%95-09.PNG"),
    "qpe-测试-09.PNG",
  );
  // Plain ASCII names pass through untouched.
  assert.equal(core.decodePercentName("QPE-05.png"), "QPE-05.png");
  // A literal "%" that is not an escape sequence must not throw.
  assert.equal(core.decodePercentName("100%-05.png"), "100%-05.png");
  // The matcher decodes raw names itself, so scanning stays true to the filesystem.
  const next = core.computeNext(["QPE-%E6%B5%8B%E8%AF%95-05.png"], "QPE-测试");
  assert.equal(next.nextNumber, 6);
  assert.equal(next.maxNumber, 5);
  assert.equal(next.existingCount, 1);
  assert.equal(core.matchSequence("QPE-%E6%B5%8B%E8%AF%95-05.png", "QPE-测试"), 5);
});

test("jsx/host.jsx is generated exactly from core.jsx + host-body.jsx", () => {
  const shipped = readFileSync(join(repoRoot, "jsx", "host.jsx"), "utf8");
  assert.equal(shipped, buildHostSource(), "run: node scripts/build-host.mjs");
});

test("host.jsx loads in a bare context and dispatches safely", () => {
  const source = readFileSync(join(repoRoot, "jsx", "host.jsx"), "utf8");
  const context = createContext({});
  runInContext(source, context, { filename: "jsx/host.jsx" });

  assert.equal(typeof context.QPE_call, "function");
  const unknown = JSON.parse(context.QPE_call("nope", "{}"));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "UNKNOWN_METHOD");

  // Without a Photoshop host the call must fail soft (JSON), never throw.
  const status = JSON.parse(context.QPE_call("status", "{}"));
  assert.equal(status.ok, false);
  assert.equal(status.code, "EXCEPTION");

  const badArgs = JSON.parse(context.QPE_call("status", "{oops"));
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.code, "BAD_ARGS");
});

/* ---------- default prefix from the document name ---------- */

test("derivePrefixFromDocument strips a document extension", () => {
  const result = core.derivePrefixFromDocument("2610-10-狼场景.psd");
  assert.equal(result.prefix, "2610-10-狼场景");
  assert.equal(result.changed, false);
  assert.equal(result.documentName, "2610-10-狼场景.psd");
});

test("derivePrefixFromDocument strips typical extensions only", () => {
  assert.equal(core.derivePrefixFromDocument("poster.png").prefix, "poster");
  assert.equal(core.derivePrefixFromDocument("poster.PSD").prefix, "poster");
  assert.equal(core.derivePrefixFromDocument("poster.v2").prefix, "poster.v2");
  assert.equal(core.derivePrefixFromDocument("poster").prefix, "poster");
  assert.equal(core.derivePrefixFromDocument("").prefix, "");
});

test("derivePrefixFromDocument removes characters Windows forbids", () => {
  const result = core.derivePrefixFromDocument("a/b:c*d?e\"f<g>h|i\\j.psd");
  assert.equal(result.prefix, "abcdefghij");
  assert.equal(result.changed, true);
});

test("derivePrefixFromDocument cleans edges and keeps inner dots and spaces", () => {
  const result = core.derivePrefixFromDocument("  a.b c.psd ");
  assert.equal(result.prefix, "a.b c");
  assert.equal(result.changed, false);
});

test("derivePrefixFromDocument never ends with a dot after cleanup", () => {
  assert.equal(core.derivePrefixFromDocument("name...psd").prefix, "name");
  assert.equal(core.derivePrefixFromDocument("a/b.").prefix, "ab");
});

test("derivePrefixFromDocument survives a missing name", () => {
  for (const value of [null, undefined, "", "   "]) {
    const result = core.derivePrefixFromDocument(value);
    assert.equal(typeof result.prefix, "string");
    assert.equal(result.prefix, "");
  }
});

test("derivePrefixFromDocument output always passes validatePrefix", () => {
  const samples = [
    "2610-10-狼场景.psd",
    "a/b:c*d?e\"f<g>h|i\\j.psd",
    "  260-12 海报 终稿.psd  ",
    "name...psd",
    "x".repeat(200) + ".psd"
  ];
  for (const name of samples) {
    const { prefix } = core.derivePrefixFromDocument(name);
    if (prefix === "") {
      continue;
    }
    assert.equal(core.validatePrefix(prefix).ok, true, name);
  }
});

test("compareLayerPaths yields panel order: parents before children, top to bottom", () => {
  const paths = [[1, 2], [0, 1], [1], [0], [0, 0]];
  assert.deepEqual(paths.slice().sort(core.compareLayerPaths), [[0], [0, 0], [0, 1], [1], [1, 2]]);
});

test("orderSelectedLayers keeps panel order, dedupes ids and ignores unknown layers", () => {
  const items = [
    { id: 7, name: "G", path: [2] },
    { id: 8, name: "g-child", path: [2, 0] },
    { id: 9, name: "red", path: [5] },
    { id: 10, name: "top", path: [0] }
  ];
  const ordered = core.orderSelectedLayers(items, [9, 8, 7, 10, 7, 999]);
  assert.deepEqual([...ordered.map((layer) => layer.id)], [10, 7, 9]);
});

test("orderSelectedLayers drops selected descendants when their group is selected", () => {
  const items = [
    { id: 1, name: "G", path: [0] },
    { id: 2, name: "g-a", path: [0, 0] },
    { id: 3, name: "g-b", path: [0, 1] },
    { id: 4, name: "other", path: [1] }
  ];
  const ordered = core.orderSelectedLayers(items, [2, 1, 3, 4]);
  assert.deepEqual([...ordered.map((layer) => layer.id)], [1, 4]);
});

test("buildBatchNames continues after the highest existing number", () => {
  const plan = core.buildBatchNames(["p-01.png", "p-03.png", "P-09.png"], "p", 2, 3, true);
  assert.equal(plan.startNumber, 10);
  assert.equal(plan.maxNumber, 9);
  assert.deepEqual([...plan.names], ["p-10.png", "p-11.png", "p-12.png"]);
});

test("buildBatchNames ignores zero and negative counts", () => {
  for (const count of [0, -3, null, undefined, "2"]) {
    const plan = core.buildBatchNames(["p-01.png"], "p", 2, count, false);
    assert.equal(plan.startNumber, 2, String(count));
    assert.deepEqual([...plan.names], [], String(count));
  }
});

test("summarizeBatch counts exported, skipped, failed and unprocessed", () => {
  const counts = core.summarizeBatch([{}, {}], [{}], { code: "SAVE_FAILED" }, 3);
  assert.equal(counts.exported, 2);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.unprocessed, 3);
  assert.equal(counts.total, 7);
  assert.equal(counts.allSkipped, false);
});

test("summarizeBatch marks a batch where everything was skipped", () => {
  const counts = core.summarizeBatch([], [{}, {}], null, 0);
  assert.equal(counts.allSkipped, true);
  assert.equal(counts.total, 2);
  assert.equal(counts.failed, 0);
});

test("summarizeBatch treats a failed item as stopping the batch", () => {
  const counts = core.summarizeBatch([{ number: 1 }], [], { code: "SAVE_FAILED" }, 0);
  assert.equal(counts.exported, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.total, 2);
  assert.equal(counts.allSkipped, false);
});

