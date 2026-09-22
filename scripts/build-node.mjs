/**
 * Build the FastPack v0 native Node addon (napi-rs) from the Rust core.
 *
 * Steps:
 *   1. `cargo build --release` in rs/node (compiles the napi-rs cdylib that
 *      binds the same Rust core as the CLI and WASM builds).
 *   2. Copy the shared library to `rs/node/build/fastpack_node.node`, the
 *      path the loader (`ts/node/index.mjs`) resolves by default.
 *
 * The `.node` file is a gitignored build artifact; rebuild whenever the Rust
 * core or the binding changes. Output is a plain napi-rs module with zero
 * runtime dependencies — fully offline once built.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const nodeCrate = resolve(repoRoot, "rs/node");

// 1. Compile the addon.
execFileSync("cargo", ["build", "--release"], {
  cwd: nodeCrate,
  stdio: "inherit",
  env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
});

// 2. Locate the produced shared library (platform-specific name).
const targetDir = resolve(nodeCrate, "target/release");
const candidates = ["fastpack_node.node", "libfastpack_node.so", "libfastpack_node.dylib", "fastpack_node.dll"];
const lib = candidates
  .map((c) => resolve(targetDir, c))
  .find((p) => existsSync(p));

if (!lib) {
  console.error(`addon artifact not found under ${targetDir}`);
  process.exit(1);
}

const outDir = resolve(nodeCrate, "build");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, "fastpack_node.node");
copyFileSync(lib, out);
console.log(`wrote ${out} (${readFileSync(lib).length} bytes)`);
