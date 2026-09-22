#!/usr/bin/env node
/**
 * fp - FastPack CLI (local wrapper, Windows/macOS/Linux)
 *
 * Use FastPack like 7z or zip from the command line.
 *
 * Usage:
 *   node fp.mjs compress   <input>  [output.fp]
 *   node fp.mjs safe       <input>  [output.fp]
 *   node fp.mjs decompress <input.fp> [output]
 *   node fp.mjs info       <file.fp>
 *   node fp.mjs hash       <file>
 *   node fp.mjs analyze    <file>
 *   node fp.mjs help
 *
 * Requires: npm run build  (compiles dist/ with tsc)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";

// ── load the compiled API ─────────────────────────────────────────────────────
const apiPath = new URL("./dist/src/api.js", import.meta.url);
if (!existsSync(new URL("./dist/src/api.js", import.meta.url).pathname.slice(1))) {
  console.error(
    "Error: dist/ not found. Run  npm run build  first (inside the ts/ directory).",
  );
  process.exit(1);
}

const { createEncoder, createDecoder, compressOrRaw, metadata, analyze, hashFp } =
  await import(apiPath.href);

// ── helpers ───────────────────────────────────────────────────────────────────

function readFile(path) {
  const p = resolve(path);
  if (!existsSync(p)) {
    console.error(`Error: file not found: ${p}`);
    process.exit(1);
  }
  return { bytes: readFileSync(p), path: p };
}

/** Create parent directories of outPath if they don't exist yet (like mkdir -p). */
function ensureDir(outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtRatio(a, b) {
  return b === 0 ? "—" : `${(a / b).toFixed(3)}x`;
}

function bar(fraction, width = 30) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Live progress bar — rewrites the current line in-place.
 *
 *   Compressing  [████████████░░░░░░░░░░░░░░░░░░]  42.3%  200.1 MB / 474.3 MB  22.4 MB/s
 */
function printProgress(label, done, total, elapsed) {
  const pct = total > 0 ? done / total : 0;
  const mbps = elapsed > 0 ? (done / 1024 / 1024) / (elapsed / 1000) : 0;
  const line =
    `  ${label.padEnd(12)} [${bar(pct)}]  ${(pct * 100).toFixed(1).padStart(5)}%` +
    `  ${fmtBytes(done)} / ${fmtBytes(total)}  ${mbps.toFixed(1)} MB/s`;
  process.stderr.write(`\r${line}`);
}

/** Clear the progress line and move to the next line. */
function clearProgress() {
  process.stderr.write("\r" + " ".repeat(90) + "\r");
}

/**
 * Stream-compress `bytes` using createEncoder, feeding data in CHUNK_SIZE
 * blocks so we can report progress on every block.
 *
 * Returns the packed Uint8Array.
 */
function compressWithProgress(bytes, label = "Compressing") {
  const CHUNK = 4 * 1024 * 1024; // 4 MB per chunk
  const encoder = createEncoder();
  const parts = [];
  encoder.onData = (chunk) => parts.push(chunk);

  const t0 = performance.now();
  let offset = 0;

  while (offset < bytes.length) {
    const end = Math.min(offset + CHUNK, bytes.length);
    encoder.write(bytes.subarray(offset, end));
    offset = end;
    printProgress(label, offset, bytes.length, performance.now() - t0);
  }

  // flush emits the final frame + footer
  encoder.flush();
  clearProgress();

  const elapsed = performance.now() - t0;

  // concatenate all output chunks
  const totalLen = parts.reduce((s, c) => s + c.length, 0);
  const packed = new Uint8Array(totalLen);
  let off = 0;
  for (const c of parts) { packed.set(c, off); off += c.length; }

  return { packed, elapsed };
}

/**
 * Stream-decompress `bytes` using createDecoder, feeding data in CHUNK_SIZE
 * blocks so we can report progress on every block.
 *
 * Returns the decoded Uint8Array.
 */
function decompressWithProgress(bytes) {
  const CHUNK = 4 * 1024 * 1024; // 4 MB per chunk
  const decoder = createDecoder();
  const parts = [];
  decoder.onBlock = (chunk) => parts.push(chunk);

  const t0 = performance.now();
  let offset = 0;

  while (offset < bytes.length) {
    const end = Math.min(offset + CHUNK, bytes.length);
    decoder.write(bytes.subarray(offset, end));
    offset = end;
    printProgress("Decompressing", offset, bytes.length, performance.now() - t0);
  }

  decoder.end();
  clearProgress();

  const elapsed = performance.now() - t0;

  // concatenate decoded blocks
  const totalLen = parts.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const c of parts) { out.set(c, off); off += c.length; }

  return { out, elapsed };
}

// ── commands ──────────────────────────────────────────────────────────────────

function cmdCompress(input, output) {
  const { bytes, path: inPath } = readFile(input);
  const outPath = resolve(output ?? inPath + ".fp");

  console.log(`\n  File     : ${basename(inPath)}  (${fmtBytes(bytes.length)})`);
  console.log(`  Output   : ${outPath}\n`);

  const { packed, elapsed } = compressWithProgress(bytes, "Compressing");

  ensureDir(outPath);
  writeFileSync(outPath, packed);

  const ratio = bytes.length / packed.length;
  const mbps = (bytes.length / 1024 / 1024) / (elapsed / 1000);

  console.log(`  ✔  Done!`);
  console.log(`     Original : ${fmtBytes(bytes.length)}`);
  console.log(`     Packed   : ${fmtBytes(packed.length)}`);
  console.log(`     Ratio    : ${ratio.toFixed(3)}x  [${bar(Math.min(ratio / 64, 1), 20)}]`);
  console.log(`     Time     : ${elapsed.toFixed(1)} ms  (${mbps.toFixed(1)} MB/s)\n`);
}

function cmdCompressOrRaw(input, output) {
  const { bytes, path: inPath } = readFile(input);
  const outPath = resolve(output ?? inPath + ".fp");

  console.log(`\n  File     : ${basename(inPath)}  (${fmtBytes(bytes.length)})`);
  console.log(`  Output   : ${outPath}\n`);

  const { packed, elapsed } = compressWithProgress(bytes, "Compressing");

  // decide: use compressed if it's strictly smaller, otherwise raw passthrough
  let final;
  let isRaw = false;
  if (packed.length < bytes.length) {
    final = packed;
  } else {
    // compressOrRaw fallback — build a raw passthrough stream
    process.stderr.write("  Building raw passthrough...");
    final = compressOrRaw(bytes).data;
    process.stderr.write("\r" + " ".repeat(40) + "\r");
    isRaw = true;
  }

  ensureDir(outPath);
  writeFileSync(outPath, final);

  const ratio = bytes.length / final.length;
  const mbps = (bytes.length / 1024 / 1024) / (elapsed / 1000);

  console.log(`  ✔  Done!  ${isRaw ? "(raw passthrough — already compressed)" : ""}`);
  console.log(`     Original : ${fmtBytes(bytes.length)}`);
  console.log(`     Output   : ${fmtBytes(final.length)}`);
  console.log(`     Ratio    : ${ratio.toFixed(3)}x`);
  console.log(`     Time     : ${elapsed.toFixed(1)} ms  (${mbps.toFixed(1)} MB/s)\n`);
}

function cmdDecompress(input, output) {
  const { bytes, path: inPath } = readFile(input);

  const defaultOut = inPath.endsWith(".fp")
    ? inPath.slice(0, -3)
    : inPath + ".out";
  const outPath = resolve(output ?? defaultOut);

  console.log(`\n  File     : ${basename(inPath)}  (${fmtBytes(bytes.length)})`);
  console.log(`  Output   : ${outPath}\n`);

  let out, elapsed;
  try {
    ({ out, elapsed } = decompressWithProgress(bytes));
  } catch (err) {
    clearProgress();
    console.error(`\n  ✖  Decompression failed: ${err.message}\n     code: ${err.code ?? "unknown"}\n`);
    process.exit(1);
  }

  ensureDir(outPath);
  writeFileSync(outPath, out);

  const mbps = (out.length / 1024 / 1024) / (elapsed / 1000);
  console.log(`  ✔  Done!`);
  console.log(`     Restored : ${fmtBytes(out.length)}`);
  console.log(`     Time     : ${elapsed.toFixed(1)} ms  (${mbps.toFixed(1)} MB/s)\n`);
}

function cmdInfo(input) {
  const { bytes, path: inPath } = readFile(input);
  let meta;
  try {
    meta = metadata(bytes);
  } catch (err) {
    console.error(`\n  ✖  Not a valid FastPack stream: ${err.message}\n`);
    process.exit(1);
  }
  console.log(`\n  FastPack stream info: ${basename(inPath)}`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  Format version : v${meta.version}`);
  console.log(`  File size      : ${fmtBytes(bytes.length)}`);
  console.log(`  Frames         : ${meta.frameCount}`);
  console.log(`  Payload bytes  : ${fmtBytes(meta.totalLen)}  (original size)`);
  console.log(`  Encoded bytes  : ${fmtBytes(meta.encodedBytes)}  (in stream)`);
  console.log(`  Ratio          : ${fmtRatio(meta.totalLen, meta.encodedBytes)}`);
  console.log();
}

function cmdHash(input) {
  const { bytes, path: inPath } = readFile(input);
  const h = hashFp(bytes);
  const hex = (BigInt(h.hi) << 32n | BigInt(h.lo)).toString(16).padStart(16, "0");
  console.log(`\n  FPHash64: 0x${hex}  (${basename(inPath)})\n`);
}

function cmdAnalyze(input) {
  const { bytes, path: inPath } = readFile(input);
  const a = analyze(bytes);

  const entropyBar = bar(a.entropy / 8, 24);
  const runBar = bar(a.runFraction, 24);

  const suggests =
    a.suggestedTransforms.length === 0
      ? "none (default options)"
      : a.suggestedTransforms.map((id) => (id === 1 ? "delta" : id === 2 ? "rle" : `transform-${id}`)).join(", ");

  console.log(`\n  Analysis: ${basename(inPath)}`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  File size      : ${fmtBytes(bytes.length)}`);
  console.log(`  Entropy        : ${a.entropy.toFixed(3)} bits/byte  [${entropyBar}]`);
  console.log(`  Run fraction   : ${(a.runFraction * 100).toFixed(1)}%  [${runBar}]`);
  console.log(`  Delta entropy  : ${a.deltaEntropy.toFixed(3)} bits/byte`);
  console.log(`  Suggested      : ${suggests}`);
  console.log();
}

function cmdHelp() {
  console.log(`
  fp — FastPack CLI  (use FastPack like 7z or zip)
  ${"─".repeat(44)}

  COMPRESS
    node fp.mjs compress   <file>  [out.fp]       Compress a file → .fp stream
    node fp.mjs safe       <file>  [out.fp]       Compress; keep raw if smaller (no-expand)

  DECOMPRESS
    node fp.mjs decompress <file.fp>  [out]       Restore original bytes from .fp stream

  INSPECT
    node fp.mjs info       <file.fp>              Stream header: version, frames, size, ratio
    node fp.mjs hash       <file>                 FPHash64 of raw file bytes (hex)
    node fp.mjs analyze    <file>                 Entropy + run stats → suggested transforms

  HELP
    node fp.mjs help                              Show this message

  EXAMPLES  (Windows PowerShell)
    node fp.mjs compress   .\\report.json
    node fp.mjs decompress .\\report.json.fp
    node fp.mjs info       .\\report.json.fp
    node fp.mjs analyze    .\\report.json
    node fp.mjs safe       .\\image.png           (will stay raw — PNG is already compressed)

  NOTE
    Run  npm run build  once first so dist/ exists.
`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "compress":   cmdCompress(args[0], args[1]);      break;
  case "safe":       cmdCompressOrRaw(args[0], args[1]); break;
  case "decompress": cmdDecompress(args[0], args[1]);    break;
  case "info":       cmdInfo(args[0]);                   break;
  case "hash":       cmdHash(args[0]);                   break;
  case "analyze":    cmdAnalyze(args[0]);                break;
  case "help":
  case "--help":
  case "-h":
  case undefined:    cmdHelp();                          break;
  default:
    console.error(`\n  Unknown command: "${cmd}". Run  node fp.mjs help  for usage.\n`);
    process.exit(1);
}
