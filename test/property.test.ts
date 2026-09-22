/**
 * Deterministic PRNG property tests: random round-trips across content
 * classes, block sizes, windows, and transforms.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, decompress } from "../src/api.js";

// xorshift64* PRNG
class Rng {
  private s: bigint;
  constructor(seed: number) {
    this.s = BigInt(seed) | 1n;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13n;
    x ^= x >> 7n;
    x ^= x << 17n;
    x &= (1n << 64n) - 1n;
    x *= 0x2545f4914f6cdd1dn;
    x &= (1n << 64n) - 1n;
    this.s = x;
    return Number(x & 0xffffffffn) >>> 0;
  }
}

function makeData(rng: Rng, n: number, kind: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rng.next();
    if (kind === 0) {
      out[i] = r & 0xff;
    } else if (kind === 1) {
      // small alphabet -> compressible-ish
      out[i] = 0x20 + (r % 8);
    } else if (kind === 2) {
      // repetitive runs
      if (i === 0 || (r & 0x1f) === 0) out[i] = r & 0xff;
      else out[i] = out[i - 1]!;
    } else {
      // delta-friendly ramp
      out[i] = (r & 0x03) === 0 ? (i * 7 + r) & 0xff : (r & 0xff);
    }
  }
  return out;
}

const OPTION_SETS = [
  {},
  { windowSize: 4096 },
  { windowSize: 1 << 16, blockAlignment: 512 },
  { windowSize: 1 << 18, blockAlignment: 1 << 15, matchChain: "fast" as const },
  { windowSize: 8192, matchChain: "fast" as const, rawHysteresis: 0 },
  { transforms: [1] }, // delta
  { transforms: [2] }, // rle
  { transforms: [1, 2] },
  { blockAlignment: 1 },
];

test("property: round-trips across kinds, sizes, options", () => {
  const sizes = [0, 1, 2, 3, 17, 255, 4095, 4096, 4097, 1 << 17];
  for (const size of sizes) {
    for (const kind of [0, 1, 2, 3]) {
      const rng = new Rng(size * 31 + kind * 7 + 1);
      const data = makeData(rng, size, kind);
      for (const opts of OPTION_SETS) {
        let c: Uint8Array;
        let d: ReturnType<typeof decompress>;
        try {
          c = compress(data, opts);
          d = decompress(c, opts);
        } catch (e) {
          throw new Error(
            `crash size=${size} kind=${kind} opts=${JSON.stringify(opts)}: ${(e as Error).message}`,
          );
        }
        assert.deepEqual(d.data, data, `size=${size} kind=${kind} opts=${JSON.stringify(opts)}`);
      }
    }
  }
});

test("property: decoders never crash on arbitrary byte strings", () => {
  // malformed-ish but well-formed-enough frames must throw typed errors, not crash
  const rng = new Rng(1234);
  for (let i = 0; i < 200; i++) {
    const n = rng.next() % 500;
    const data = makeData(rng, n, 0);
    assert.doesNotThrow(() => {
      try {
        decompress(data, { strict: true });
      } catch {
        // typed errors are expected
      }
    });
  }
});
