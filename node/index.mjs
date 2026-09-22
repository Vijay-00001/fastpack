/**
 * FastPack v0 — native Node binding loader.
 *
 * Loads the napi-rs addon built from the Rust core (`rs/node/`) and wraps it
 * so the stable string error code is surfaced as `err.code`, matching the TS
 * error taxonomy. Fully offline; the addon has zero runtime dependencies.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** A FastPack error carrying the stable string code (mirrors errors.ts). */
export class FastPackNodeError extends Error {
  constructor(code, message, position) {
    super(`[${code}] ${message}${position !== undefined ? ` @ offset ${position}` : ""}`);
    this.name = "FastPackNodeError";
    this.code = code;
    this.position = position;
  }
}

/** Parse "[<code>] <message> @ offset N" (see rs/node to_napi_err). */
function wrapErr(err) {
  const m = /^\[([^\]]+)\] (.*?)(?: @ offset (\d+))?$/.exec(err.message ?? "");
  if (m) return new FastPackNodeError(m[1], m[2], m[3] !== undefined ? Number(m[3]) : undefined);
  return new FastPackNodeError("fastpack.unknown", err.message ?? String(err));
}

/** Resolve the addon path; allows overriding via FASTPACK_NODE_ADDON. */
function addonPath() {
  if (process.env.FASTPACK_NODE_ADDON) return process.env.FASTPACK_NODE_ADDON;
  return resolve(here, "../../rs/node/build/fastpack_node.node");
}

/** Return a plain Uint8Array view (not a Buffer) for TS-surface parity. */
function u8(buf) {
  if (Buffer.isBuffer(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return buf;
}

let native = null;

/**
 * Initialize (once) and return the native SDK. `compress`/`compressOrRaw`/
 * `decompress` take `(data: Uint8Array, opts?)` and return Uint8Array /
 * { data, size } / { data, recovered, events }. `metadata` returns the
 * structural stream metadata.
 */
export async function init() {
  if (!native) {
    native = require(addonPath());
  }
  const mod = native;
  return {
    compress(data, opts) {
      try {
        return u8(mod.compress(data, opts));
      } catch (e) {
        throw wrapErr(e);
      }
    },
    compressOrRaw(data, opts) {
      try {
        const r = mod.compressOrRaw(data, opts);
        return { data: u8(r.data), size: r.size };
      } catch (e) {
        throw wrapErr(e);
      }
    },
    decompress(data, opts) {
      try {
        const r = mod.decompress(data, opts);
        return {
          data: u8(r.data),
          recovered: r.recovered,
          events: (r.events ?? []).map((e) => ({
            frameSeq: Number(e.frameSeq),
            streamOffset: Number(e.streamOffset),
            cause: e.cause,
          })),        };
      } catch (e) {
        throw wrapErr(e);
      }
    },
    metadata(data) {
      try {
        const m = mod.metadata(data);
        // u64 hash values are serialized as decimal strings; convert for
        // parity with the TS surface (hashes are bigint, lengths are number).
        m.totalHash = BigInt(m.totalHash);
        m.totalLen = Number(m.totalLen);
        m.endSeq = Number(m.endSeq);
        for (const f of m.frames) {
          f.seq = Number(f.seq);
          f.headerHash = BigInt(f.headerHash);
          f.payloadHash = BigInt(f.payloadHash);
        }
        return m;
      } catch (e) {
        throw wrapErr(e);
      }
    },
    FastPackNodeError,
    version: "0.1.0",
  };
}
