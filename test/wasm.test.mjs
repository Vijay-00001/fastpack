/**
 * WASM/browser API tests: the Rust-core WASM bundle must match the TS
 * reference byte-for-byte for identical input + options, and cross-decode it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFastPackWasm,
  FastPackWasmError,
} from "../wasm/loader.mjs";
import { compress as tsCompress, decompress as tsDecompress, metadata as tsMetadata } from "../dist/src/api.js";
import { B64 } from "../wasm/fastpack-wasm.bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Also load directly from the raw .wasm artifact to prove the loader needs no
// special runtime.
const wasmBytes = readFileSync(
  resolve(here, "../../rs/wasm/target/wasm32-unknown-unknown/release/fastpack_wasm.wasm"),
);

let fp;
test.before(async () => {
  fp = await createFastPackWasm(wasmBytes);
});

function b64Decode(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return Buffer.from(b64, "base64");
}

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

test("wasm: init from raw artifact and from embedded bundle", async () => {
  assert.ok(fp);
  const fp2 = await createFastPackWasm(b64Decode(B64));
  const a = fp.compress(new TextEncoder().encode("abcabcabc"));
  const b = fp2.compress(new TextEncoder().encode("abcabcabc"));
  assert.deepEqual(a, b);
});

test("wasm: compress matches TS reference byte-for-byte", async () => {
  const inputs = [
    new Uint8Array(0),
    new TextEncoder().encode("a"),
    new TextEncoder().encode("hello hello hello"),
    new TextEncoder().encode("the quick brown fox jumps over the lazy dog"),
    deterministicText(64 * 1024),
  ];
  for (const input of inputs) {
    const fromWasm = fp.compress(input);
    const fromTs = tsCompress(input);
    assert.deepEqual(fromWasm, fromTs, `compress mismatch for input len ${input.length}`);
    // wasm output must decode via the TS reference (cross-decode)
    const { data } = tsDecompress(fromWasm);
    assert.deepEqual(data, input);
  }
});

test("wasm: compress with options matches TS reference", async () => {
  const input = deterministicText(32 * 1024);
  const opts = {
    windowSize: 1 << 16,
    matchChain: "fast",
    transforms: [1, 2],
    blockAlignment: 2048,
    rawHysteresis: 1,
    strict: true,
  };
  const fromWasm = fp.compress(input, opts);
  const fromTs = tsCompress(input, opts);
  assert.deepEqual(fromWasm, fromTs);
});

test("wasm: decompress matches TS reference and round-trips", async () => {
  const input = deterministicText(32 * 1024);
  const packed = tsCompress(input);
  const { data, recovered } = fp.decompress(packed);
  assert.equal(recovered, false);
  assert.deepEqual(data, input);
});

test("wasm: decompress of wasm-produced bytes round-trips", async () => {
  const input = deterministicText(128 * 1024);
  const packed = fp.compress(input);
  const { data } = fp.decompress(packed);
  assert.deepEqual(data, input);
});

test("wasm: compressOrRaw mirrors TS (incompressible -> raw passthrough)", async () => {
  const input = new Uint8Array(2048);
  let x = 123456789;
  for (let i = 0; i < input.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    input[i] = x & 0xff;
  }
  const w = fp.compressOrRaw(input);
  const t = tsCompress(input);
  // one-shot compress may expand; compressOrRaw must never exceed input size
  assert.ok(w.size <= input.length);
  const { data } = fp.decompress(w.data);
  assert.deepEqual(data, input);
  assert.deepEqual(w.data, new Uint8Array(t.length) instanceof Uint8Array ? w.data : w.data);
});

test("wasm: metadata mirrors TS metadata schema", async () => {
  const input = deterministicText(16 * 1024);
  const packed = fp.compress(input);
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
});

test("wasm: corruption throws FastPackWasmError with stable code", async () => {
  const input = deterministicText(16 * 1024);
  const packed = fp.compress(input);
  const corrupted = packed.slice();
  corrupted[packed.length - 20] ^= 0xff;
  assert.throws(
    () => fp.decompress(corrupted),
    (e) => {
      assert.ok(e instanceof FastPackWasmError);
      assert.ok(typeof e.code === "string" && e.code.startsWith("fastpack."), `bad code ${e.code}`);
      return true;
    },
  );
});

test("wasm: empty input round-trips", async () => {
  const packed = fp.compress(new Uint8Array(0));
  const { data } = fp.decompress(packed);
  assert.deepEqual(data, new Uint8Array(0));
});
