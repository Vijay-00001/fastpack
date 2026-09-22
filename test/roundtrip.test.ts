/**
 * Round-trip correctness tests (spec §18): decode(encode(x)) == x for all
 * byte classes including empty, all-256, and structured content.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, decompress, compressOrRaw, createEncoder, createDecoder } from "../src/api.js";

const enc = new TextEncoder();

function randomBytes(n: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

test("empty input round-trips", () => {
  const c = compress(new Uint8Array(0));
  const d = decompress(c);
  assert.equal(d.data.length, 0);
  assert.equal(d.recovered, false);
  assert.deepEqual(d.events, []);
});

test("all 256 byte values round-trip", () => {
  const a = new Uint8Array(256);
  for (let i = 0; i < 256; i++) a[i] = i;
  const d = decompress(compress(a));
  assert.deepEqual(d.data, a);
});

test("repeated single byte round-trips", () => {
  const a = new Uint8Array(1000).fill(0x41);
  const d = decompress(compress(a));
  assert.deepEqual(d.data, a);
});

test("structured text round-trips", () => {
  const samples = [
    enc.encode(""),
    enc.encode("hello world hello world hello world"),
    enc.encode("a".repeat(4096)),
    enc.encode(JSON.stringify({ a: 1, b: "x".repeat(5000), c: [1, 2, 3] }).repeat(4)),
    enc.encode("The quick brown fox jumps over the lazy dog. ".repeat(100)),
  ];
  for (const s of samples) {
    const d = decompress(compress(s));
    assert.deepEqual(d.data, s);
  }
});

test("random data round-trips at various sizes", () => {
  for (const [n, seed] of [[1, 1], [7, 2], [100, 3], [4096, 4], [1 << 20, 5]] as const) {
    const a = randomBytes(n, seed);
    const d = decompress(compress(a));
    assert.deepEqual(d.data, a);
  }
});

test("incompressible data round-trips via compressOrRaw", () => {
  for (const n of [0, 1, 100, 4096, 1 << 18]) {
    const a = randomBytes(n, 99);
    const { data } = compressOrRaw(a);
    const d = decompress(data);
    assert.deepEqual(d.data, a);
  }
});

test("compress is deterministic for identical input+options", () => {
  const a = enc.encode("determinism check ".repeat(200));
  const opts = { windowSize: 1 << 16, blockAlignment: 256, matchChain: "fast" as const };
  const c1 = compress(a, opts);
  const c2 = compress(a, opts);
  assert.deepEqual(c1, c2);
});

test("streaming encode/decode round-trips with chunked writes", () => {
  const input = enc.encode("streaming ".repeat(500));
  const encs = createEncoder();
  const parts: Uint8Array[] = [];
  // feed in odd-sized chunks
  for (let i = 0; i < input.length; i += 123) {
    const end = Math.min(input.length, i + 123);
    encs.write(input.subarray(i, end));
  }
  parts.push(encs.flush());
  const stream = concat(parts);
  const dec = createDecoder();
  dec.write(stream);
  const out = dec.end();
  assert.deepEqual(out, input);
});

test("streaming decoder accepts byte-split frames", () => {
  const input = enc.encode("fragmented ".repeat(300));
  const encs = createEncoder();
  encs.write(input);
  const stream = encs.flush();

  const dec = createDecoder();
  // feed one byte at a time
  for (let i = 0; i < stream.length; i++) {
    dec.write(stream.subarray(i, i + 1));
  }
  const out = dec.end();
  assert.deepEqual(out, input);
});

test("one-shot vs streaming decode agree", () => {
  const input = enc.encode("cross-consistency ".repeat(200));
  const one = compress(input);
  const encs = createEncoder();
  encs.write(input);
  const strm = encs.flush();
  assert.deepEqual(decompress(one).data, decompress(strm).data);
});

test("empty streaming stream round-trips", () => {
  const encs = createEncoder();
  const stream = encs.flush();
  const dec = createDecoder();
  dec.write(stream);
  const out = dec.end();
  assert.equal(out.length, 0);
});

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
