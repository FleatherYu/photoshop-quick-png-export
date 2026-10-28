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
    "261028-123-01.jpg",
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
    "261028-123-01.jpg",
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

