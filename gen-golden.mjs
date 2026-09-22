import { writeFileSync } from "node:fs";
import { compress, createEncoder } from "./dist/src/api.js";

const enc = new TextEncoder();

function randomBytes(n, seed) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

const corpus = {
  empty: new Uint8Array(0),
  all256: Uint8Array.from({ length: 256 }, (_, i) => i),
  repeated: new Uint8Array(1000).fill(0x41),
  text: enc.encode("The quick brown fox jumps over the lazy dog. ".repeat(50)),
  json: enc.encode(JSON.stringify({ a: 1, b: "x".repeat(2000), c: [1, 2, 3] }).repeat(2)),
  rand4k: randomBytes(4096, 42),
  rand16k: randomBytes(16384, 7),
  runs: new Uint8Array([...enc.encode("abc"), ...new Uint8Array(500).fill(0x00), ...enc.encode("xyz".repeat(50))]),
  ramp: Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) & 0xff),
};

const optionSets = {
  default: {},
  smallWin: { windowSize: 4096 },
  fastChain: { windowSize: 1 << 16, blockAlignment: 512, matchChain: "fast" },
  noHyst: { windowSize: 8192, matchChain: "fast", rawHysteresis: 0 },
  delta: { transforms: [1] },
  rle: { transforms: [2] },
  both: { transforms: [1, 2] },
};

// align1 emits one frame per byte; only affordable on small inputs
const smallOnly = ["empty", "all256", "repeated"];

const vectors = [];
for (const [cname, data] of Object.entries(corpus)) {
  for (const [oname, opts] of Object.entries(optionSets)) {
    const compressed = compress(data, opts);
    const encs = createEncoder(opts);
    encs.write(data);
    const stream = encs.flush();
    vectors.push({
      name: `${cname}__${oname}`,
      data: Array.from(data),
      compressed: Array.from(compressed),
      stream: Array.from(stream),
    });
  }
  if (smallOnly.includes(cname)) {
    const opts = { blockAlignment: 1 };
    const compressed = compress(data, opts);
    const encs = createEncoder(opts);
    encs.write(data);
    const stream = encs.flush();
    vectors.push({
      name: `${cname}__align1`,
      data: Array.from(data),
      compressed: Array.from(compressed),
      stream: Array.from(stream),
    });
  }
}

writeFileSync("/workspace/rs/tests/golden.json", JSON.stringify(vectors));
console.log(`wrote ${vectors.length} vectors`);
