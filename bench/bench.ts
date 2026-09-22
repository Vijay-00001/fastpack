/**
 * FastPack v0 TS benchmark runner.
 *
 * Measures one-shot compress + decompress throughput and ratio on a fixed
 * corpus. Uses process.hrtime for wall time; results are printed as a table.
 * This is a smoke benchmark, not a substitute for the Rust Criterion harness
 * (see rs/benches).
 */
import { compress, decompress, compressOrRaw, analyze } from "../src/api.js";

const enc = new TextEncoder();

function randomBytes(n: number, seed: number): Uint8Array {
  let s = BigInt(seed) | 1n;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let x = s;
    x ^= x << 13n;
    x ^= x >> 7n;
    x ^= x << 17n;
    x &= (1n << 64n) - 1n;
    x = (x * 0x2545f4914f6cdd1dn) & ((1n << 64n) - 1n);
    s = x;
    out[i] = Number(x & 0xffn);
  }
  return out;
}

const corpus: Array<{ name: string; data: Uint8Array }> = [
  { name: "text-1MB", data: enc.encode("The quick brown fox jumps over the lazy dog. ".repeat(1 << 14)) },
  { name: "json-1MB", data: enc.encode(JSON.stringify({ a: 1, b: "x".repeat(10000), c: [1, 2, 3] }).repeat(40)) },
  { name: "zeros-1MB", data: new Uint8Array(1 << 20).fill(0x00) },
  { name: "runs-1MB", data: Uint8Array.from({ length: 1 << 20 }, (_, i) => (i % 40 < 20 ? 0x41 + (i % 3) : i & 0xff)) },
  { name: "random-1MB", data: randomBytes(1 << 20, 7) },
  { name: "ramp-1MB", data: Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 7 + 3) & 0xff) },
];

function bench(fn: () => unknown, reps: number): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0);
  return ns / reps / 1e6; // ms per op
}

const rows: Array<Record<string, string>> = [];
for (const { name, data } of corpus) {
  const n = data.length;
  const reps = n >= 1 << 20 ? 5 : 20;
  const compressMs = bench(() => compress(data), reps);
  const c = compressOrRaw(data).data;
  const ratio = n / c.length;
  const decompressMs = bench(() => decompress(c), reps);
  const a = analyze(data);
  rows.push({
    name,
    size: String(n),
    ratio: ratio.toFixed(3),
    cMBs: ((n / 1e6) / (compressMs / 1e3)).toFixed(1),
    dMBs: ((n / 1e6) / (decompressMs / 1e3)).toFixed(1),
    entropy: a.entropy.toFixed(2),
    transforms: a.suggestedTransforms.join(","),
  });
}

console.table(rows);
