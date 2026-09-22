/**
 * Options validation and transform tests (spec §5.1, §17).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, decompress, compressOrRaw, analyze, hashFp } from "../src/api.js";
import { OptionError, ResourceError } from "../src/errors.js";
import { resolveOptions, transformName } from "../src/types.js";
import { TRANSFORM_ID } from "../src/ids.js";

const enc = new TextEncoder();

test("resolveOptions applies defaults", () => {
  const o = resolveOptions();
  assert.equal(o.windowSize, 1 << 20);
  assert.equal(o.matchChain, "normal");
  assert.equal(o.strict, true);
  assert.deepEqual(o.transforms, []);
});

test("resolveOptions rejects invalid windowSize", () => {
  assert.throws(() => resolveOptions({ windowSize: 0 }), OptionError);
  assert.throws(() => resolveOptions({ windowSize: (1 << 24) + 1 }), OptionError);
  assert.throws(() => resolveOptions({ windowSize: 1.5 }), OptionError);
});

test("resolveOptions rejects invalid blockAlignment", () => {
  assert.throws(() => resolveOptions({ blockAlignment: 0 }), OptionError);
  assert.throws(() => resolveOptions({ blockAlignment: 3 }), OptionError); // not power of two
  assert.throws(() => resolveOptions({ blockAlignment: 1 << 17 }), OptionError);
});

test("resolveOptions rejects invalid transforms", () => {
  assert.throws(() => resolveOptions({ transforms: [3] }), OptionError); // unknown id
  assert.throws(() => resolveOptions({ transforms: [1, 1] }), OptionError); // duplicate
  assert.throws(() => resolveOptions({ transforms: [-1] }), OptionError);
});

test("resolveOptions rejects invalid matchChain", () => {
  assert.throws(() => resolveOptions({ matchChain: "medium" as never }), OptionError);
});

test("delta transform round-trips", () => {
  const data = enc.encode("delta transform test ".repeat(100));
  const opts = { transforms: [TRANSFORM_ID.DELTA] as number[] };
  const d = decompress(compress(data, opts), opts);
  assert.deepEqual(d.data, data);
});

test("rle transform round-trips", () => {
  const data = new Uint8Array(4096).fill(0x5a);
  const opts = { transforms: [TRANSFORM_ID.RLE] as number[] };
  const d = decompress(compress(data, opts), opts);
  assert.deepEqual(d.data, data);
});

test("both transforms round-trip", () => {
  const data = enc.encode("both ".repeat(500) + "\x00".repeat(2048));
  const opts = { transforms: [TRANSFORM_ID.DELTA, TRANSFORM_ID.RLE] as number[] };
  const d = decompress(compress(data, opts), opts);
  assert.deepEqual(d.data, data);
});

test("compression is actually effective on repetitive data", () => {
  const data = enc.encode("compressible content ".repeat(1000));
  const c = compress(data);
  assert.ok(c.length < data.length / 2, `expected strong compression, got ${c.length}/${data.length}`);
});

test("compressOrRaw returns smallest of compressed vs raw", () => {
  // compressible: compressed wins
  const rep = enc.encode("aaaaaaaabbbbbbbb".repeat(1000));
  const c1 = compressOrRaw(rep);
  assert.equal(c1.data.length < rep.length, true);

  // incompressible: raw wins
  let seed = 7;
  const rnd = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    rnd[i] = seed >>> 24;
  }
  const c2 = compressOrRaw(rnd);
  assert.ok(c2.data.length >= rnd.length);
  assert.deepEqual(decompress(c2.data).data, rnd);
});

test("analyze returns well-formed stats", () => {
  const data = enc.encode("a".repeat(1000));
  const a = analyze(data);
  assert.equal(a.size, 1000);
  assert.ok(a.entropy >= 0 && a.entropy <= 8);
  assert.ok(a.runFraction >= 0 && a.runFraction <= 1);
  assert.ok(a.suggestedTransforms.includes(TRANSFORM_ID.RLE));
});

test("hashFp is deterministic and different for different data", () => {
  const a = hashFp(enc.encode("same"));
  const b = hashFp(enc.encode("same"));
  const c = hashFp(enc.encode("diff"));
  assert.deepEqual(a, b);
  assert.ok(a.hi !== c.hi || a.lo !== c.lo);
});

test("transformName maps ids", () => {
  assert.equal(transformName(0), "none");
  assert.equal(transformName(1), "delta");
  assert.equal(transformName(2), "rle");
});

test("compressing data larger than window in one-shot works", () => {
  const data = enc.encode("window-spanning ".repeat(1 << 16));
  const opts = { windowSize: 4096 };
  const c = compress(data, opts);
  const d = decompress(c, opts);
  assert.deepEqual(d.data, data);
});

test("excessive resource claims produce typed errors", () => {
  // a crafted header claiming a huge window must not allocate
  const magic = [0x46, 0x50, 0x41, 0x4b];
  // windowSize varint = 1 << 28 (5 bytes) which exceeds WINDOW_MAX (2^24)
  const b = new Uint8Array([...magic, 1, 0, 1, 0x80, 0x80, 0x80, 0x80, 0x01, 1]);
  assert.throws(() => decompress(b), ResourceError);
});
