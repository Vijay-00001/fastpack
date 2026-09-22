/**
 * Node native addon tests: the napi-rs binding from the Rust core must match
 * the TS reference byte-for-byte and cross-decode it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { init, FastPackNodeError } from "../node/index.mjs";
import {
  compress as tsCompress,
  decompress as tsDecompress,
  metadata as tsMetadata,
} from "../dist/src/api.js";

let fp;
test.before(async () => {
  fp = await init();
});

function deterministicText(n = 1_000_000) {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const chunks = [];
  let remaining = n;
  while (remaining > 0) {
    const w = words[remaining % words.length];
    const s = `${w} ${(remaining * 2654435761) % 10000} `;
    chunks.push(s);
    remaining -= s.length;
  }
  return new TextEncoder().encode(chunks.join(""));
}

test("native: compress matches TS reference byte-for-byte", async () => {
  const inputs = [
    new Uint8Array(0),
    new TextEncoder().encode("a"),
    new TextEncoder().encode("hello hello hello"),
    new TextEncoder().encode("the quick brown fox jumps over the lazy dog"),
    deterministicText(64 * 1024),
  ];
  for (const input of inputs) {
    const fromNative = fp.compress(input);
    const fromTs = tsCompress(input);
    assert.deepEqual(new Uint8Array(fromNative), fromTs, `compress mismatch for input len ${input.length}`);
    const { data } = tsDecompress(fromNative);
    assert.deepEqual(data, input);
  }
});

test("native: compress with options matches TS reference", () => {
  const input = deterministicText(32 * 1024);
  const opts = {
    windowSize: 1 << 16,
    matchChain: "fast",
    transforms: [1, 2],
    blockAlignment: 2048,
    rawHysteresis: 1,
    strict: true,
  };
  assert.deepEqual(new Uint8Array(fp.compress(input, opts)), tsCompress(input, opts));
});

test("native: decompress matches TS reference and round-trips", () => {
  const input = deterministicText(32 * 1024);
  const packed = tsCompress(input);
  const { data, recovered } = fp.decompress(packed);
  assert.equal(recovered, false);
  assert.deepEqual(data, input);
});

test("native: decompress of native-produced bytes round-trips", () => {
  const input = deterministicText(128 * 1024);
  const packed = new Uint8Array(fp.compress(input));
  const { data } = fp.decompress(packed);
  assert.deepEqual(data, input);
});

test("native: compressOrRaw never expands and round-trips", () => {
  const input = new Uint8Array(2048);
  let x = 123456789;
  for (let i = 0; i < input.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    input[i] = x & 0xff;
  }
  const { data, size } = fp.compressOrRaw(input);
  assert.ok(size <= input.length);
  const { data: decoded } = fp.decompress(data);
  assert.deepEqual(decoded, input);
});

test("native: metadata mirrors TS metadata schema", () => {
  const input = deterministicText(16 * 1024);
  const packed = new Uint8Array(fp.compress(input));
  const m = fp.metadata(packed);
  const tm = tsMetadata(packed);
  assert.equal(m.version, tm.version);
  assert.equal(m.frameCount, tm.frameCount);
  assert.equal(m.totalLen, tm.totalLen);
  assert.equal(m.totalHash, tm.totalHash);
  assert.equal(m.endSeq, tm.endSeq);
  assert.equal(m.frames.length, tm.frames.length);
  assert.equal(m.frames[0].payloadType, tm.frames[0].payloadType);
  assert.equal(m.frames[0].windowSize, tm.frames[0].windowSize);
  assert.equal(m.frames[0].headerHash, tm.frames[0].headerHash);
  assert.equal(m.frames[0].payloadHash, tm.frames[0].payloadHash);
});

test("native: corruption throws FastPackNodeError with stable code", () => {
  const input = deterministicText(16 * 1024);
  const packed = new Uint8Array(fp.compress(input));
  const corrupted = packed.slice();
  corrupted[packed.length - 20] ^= 0xff;
  assert.throws(
    () => fp.decompress(corrupted),
    (e) => {
      assert.ok(e instanceof FastPackNodeError);
      assert.ok(typeof e.code === "string" && e.code.startsWith("fastpack."), `bad code ${e.code}`);
      return true;
    },
  );
});

test("native: empty input round-trips", () => {
  const packed = fp.compress(new Uint8Array(0));
  const { data } = fp.decompress(packed);
  assert.deepEqual(data, new Uint8Array(0));
});

test("native: invalid options throw a typed error", () => {
  assert.throws(
    () => fp.compress(new TextEncoder().encode("x"), { windowSize: 0 }),
    (e) => e.code === "fastpack.option.invalid",
  );
});

test("native: non-strict recovery events mirror TS shape", () => {
  const input = deterministicText(64 * 1024);
  const packed = new Uint8Array(fp.compress(input));
  const corrupted = packed.slice();
  corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;

  const native = fp.decompress(corrupted, { strict: false });
  const ts = tsDecompress(corrupted, { strict: false });

  assert.equal(typeof native.recovered, "boolean");
  assert.deepEqual(native.events, ts.events);
  assert.deepEqual(native.data, ts.data);
});

test("native: valid stream in non-strict mode has no events", () => {
  const input = deterministicText(16 * 1024);
  const packed = new Uint8Array(fp.compress(input));
  const { data, recovered, events } = fp.decompress(packed, { strict: false });
  assert.equal(recovered, false);
  assert.deepEqual(events, []);
  assert.deepEqual(data, input);
});
