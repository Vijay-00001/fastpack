/**
 * FastPack v0 — browser/WASM loader.
 *
 * A dependency-free loader that instantiates the Rust core compiled to
 * wasm32-unknown-unknown (see `rs/wasm/`) and wraps it in the same public SDK
 * surface as the TypeScript reference (`compress`, `compressOrRaw`,
 * `decompress`, `metadata`). It runs fully offline: no server, no fetch, no
 * CDN. In the browser you provide the `.wasm` bytes via
 * `createFastPackWasm(bytes)`; a pre-built single-file bundle embeds them.
 *
 * The stable error codes and option semantics match the TS API exactly.
 */

// Option defaults mirror ts/src/types.ts (DEFAULT_OPTIONS).
const DEFAULT_OPTIONS = {
  windowSize: 1 << 20,
  matchChain: "normal",
  transforms: [],
  blockAlignment: 4096,
  rawHysteresis: 2,
  strict: true,
};

function resolveOptions(opts) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  if (o.matchChain !== "fast" && o.matchChain !== "normal") {
    throw new Error("matchChain must be 'fast' or 'normal'");
  }
  return o;
}

/** Map TS transform IDs to the wasm transform mask (bit1=delta, bit2=rle). */
function transformMask(transforms) {
  let mask = 0;
  for (const t of transforms) {
    if (t === 1) mask |= 0b10;
    else if (t === 2) mask |= 0b100;
  }
  return mask;
}

/** A FastPack error carrying the stable string code (mirrors errors.ts). */
export class FastPackWasmError extends Error {
  constructor(code, message, position) {
    super(`[${code}] ${message}${position !== undefined ? ` @ offset ${position}` : ""}`);
    this.name = "FastPackWasmError";
    this.code = code;
    this.position = position;
  }
}

function errorFromWasm(exports) {
  const mem = new Uint8Array(exports.memory.buffer);
  const codeLen = exports.fp_error_code_len();
  const codeBuf = exports.fp_alloc(codeLen);
  if (codeBuf) exports.fp_error_code_ptr(codeBuf, codeLen);
  const code = codeBuf ? new TextDecoder().decode(mem.subarray(codeBuf, codeBuf + codeLen)) : "";
  if (codeBuf) exports.fp_free(codeBuf, codeLen);

  const msgLen = exports.fp_error_len();
  const msgBuf = exports.fp_alloc(msgLen);
  if (msgBuf) exports.fp_error_ptr(msgBuf, msgLen);
  const message = msgBuf ? new TextDecoder().decode(mem.subarray(msgBuf, msgBuf + msgLen)) : "";
  if (msgBuf) exports.fp_free(msgBuf, msgLen);

  const m = /^\[([^\]]+)\] (.*?)(?: @ offset (\d+))?$/.exec(message);
  if (m) {
    return new FastPackWasmError(m[1], m[2], m[3] !== undefined ? Number(m[3]) : undefined);
  }
  return new FastPackWasmError(code || "fastpack.unknown", message || "unknown error");
}

function allocInput(exports, data) {
  const len = data.length;
  const ptr = exports.fp_alloc(len);
  if (!ptr && len > 0) throw new Error("wasm fp_alloc failed");
  if (len > 0) {
    new Uint8Array(exports.memory.buffer, ptr, len).set(data);
  }
  return { ptr, len };
}

/** Allocate a scratch u32 out-param in wasm linear memory and read it back. */
function allocOut(exports) {
  const ptr = exports.fp_alloc(4);
  return {
    ptr,
    read() {
      return new Uint32Array(exports.memory.buffer, ptr, 1)[0];
    },
    free() {
      if (ptr) exports.fp_free(ptr, 4);
    },
  };
}

function takeBytes(exports, ptr, len) {
  if (!ptr || len === 0) return new Uint8Array(0);
  const out = new Uint8Array(exports.memory.buffer, ptr, len).slice();
  exports.fp_free(ptr, len);
  return out;
}
function decodeString(exports, ptr, len) {
  const bytes = takeBytes(exports, ptr, len);
  return new TextDecoder().decode(bytes);
}

/**
 * Create the SDK from wasm bytes. `bytes` may be an ArrayBuffer, a
 * Uint8Array, or a WebAssembly.Module. Returns a Promise of the SDK.
 */
export async function createFastPackWasm(bytes) {
  const module =
    bytes instanceof WebAssembly.Module
      ? bytes
      : await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports;

  function compress(data, opts) {
    const o = resolveOptions(opts);
    const { ptr, len } = allocInput(exports, data);
    const outLen = allocOut(exports);
    const outPtr = exports.fp_compress(
      ptr, len,
      o.windowSize,
      o.matchChain === "fast" ? 0 : 1,
      transformMask(o.transforms),
      o.blockAlignment,
      o.rawHysteresis,
      o.strict ? 1 : 0,
      outLen.ptr,
    );
    const resLen = outLen.read();
    outLen.free();
    if (ptr) exports.fp_free(ptr, len);
    if (!outPtr) throw errorFromWasm(exports);
    return takeBytes(exports, outPtr, resLen);
  }

  function compressOrRaw(data, opts) {
    const o = resolveOptions(opts);
    const { ptr, len } = allocInput(exports, data);
    const outLen = allocOut(exports);
    const outSize = allocOut(exports);
    const outPtr = exports.fp_compress_or_raw(
      ptr, len,
      o.windowSize,
      o.matchChain === "fast" ? 0 : 1,
      transformMask(o.transforms),
      o.blockAlignment,
      o.rawHysteresis,
      o.strict ? 1 : 0,
      outLen.ptr,
      outSize.ptr,
    );
    const resLen = outLen.read();
    const resSize = outSize.read();
    outLen.free();
    outSize.free();
    if (ptr) exports.fp_free(ptr, len);
    if (!outPtr) throw errorFromWasm(exports);
    return { data: takeBytes(exports, outPtr, resLen), size: resSize };
  }

  function decompress(data, opts) {
    const o = resolveOptions(opts);
    const { ptr, len } = allocInput(exports, data);
    const outLen = allocOut(exports);
    const outRecovered = allocOut(exports);
    const outPtr = exports.fp_decompress(
      ptr, len,
      o.windowSize,
      o.matchChain === "fast" ? 0 : 1,
      transformMask(o.transforms),
      o.blockAlignment,
      o.rawHysteresis,
      o.strict ? 1 : 0,
      outLen.ptr,
      outRecovered.ptr,
    );
    const resLen = outLen.read();
    const resRecovered = outRecovered.read();
    outLen.free();
    outRecovered.free();
    if (ptr) exports.fp_free(ptr, len);
    if (!outPtr) throw errorFromWasm(exports);
    return {
      data: takeBytes(exports, outPtr, resLen),
      recovered: resRecovered === 1,
      events: [],
    };
  }

  function metadata(data) {
    const { ptr, len } = allocInput(exports, data);
    const outLen = allocOut(exports);
    const outPtr = exports.fp_metadata(ptr, len, outLen.ptr);
    const resLen = outLen.read();
    outLen.free();
    if (ptr) exports.fp_free(ptr, len);
    if (!outPtr) throw errorFromWasm(exports);
    const m = JSON.parse(decodeString(exports, outPtr, resLen));
    // u64 hashes are serialized as decimal strings to preserve precision.
    m.totalHash = BigInt(m.totalHash);
    for (const f of m.frames) {
      f.headerHash = BigInt(f.headerHash);
      f.payloadHash = BigInt(f.payloadHash);
    }
    return m;
  }

  return {
    compress,
    compressOrRaw,
    decompress,
    metadata,
    FastPackWasmError,
    constants: { VERSION: 1 },
    version: "0.1.0",
  };
}

/** Detect available wasm bytes from a single-file bundle (embedded base64). */
export function embeddedWasmBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
