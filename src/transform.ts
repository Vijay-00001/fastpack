/**
 * Reversible block transforms (spec §4, §9.4). Applied before LZ matching.
 * Each transform is independently testable and exactly reversible.
 *
 * transformId 0 = none (identity)
 * transformId 1 = delta   (byte-wise difference mod 256; length preserved)
 * transformId 2 = rle     (run-length token stream; reversible)
 *
 * RLE token format (deterministic, prefix-free):
 *   kind bit 0 = literal run: 7-bit (count-1), count in [1,128], then `count` literal bytes
 *   kind bit 1 = byte run:    7-bit (run-4),   run in [4,131],   then value byte, emit `run` copies
 * Worst-case expansion of RLE is rawLen + ceil(rawLen/128) bytes.
 */

import { FormatError, CorruptionError, CODES } from "./errors.js";
import { TRANSFORM_ID, FORMAT } from "./ids.js";

/** Upper bound on RLE output length for a given input length. */
export function rleMaxLen(rawLen: number): number {
  return rawLen + Math.floor(rawLen / 128) + 1;
}

/** RLE transform: encodes runs of >= 4 identical bytes as 2-byte tokens. */
export function rleEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = input.length;
  let litStart = 0;
  let i = 0;

  const flushLiterals = (end: number): void => {
    let s = litStart;
    while (end - s >= 128) {
      out.push(127); // kind=0, count=128 -> head = count-1 = 127
      for (let k = 0; k < 128; k++) out.push(input[s + k]!);
      s += 128;
    }
    const rem = end - s;
    if (rem > 0) {
      out.push(rem - 1); // kind=0, count=rem (1..128)
      for (let k = 0; k < rem; k++) out.push(input[s + k]!);
    }
  };

  while (i < n) {
    let j = i;
    while (j < n && input[j] === input[i]) j++;
    const run = j - i;
    if (run >= 4) {
      flushLiterals(i);
      let remaining = run;
      let pos = i;
      while (remaining > 0) {
        if (remaining < 4) {
          out.push(remaining - 1); // kind=0, count=remaining (1..3)
          for (let k = 0; k < remaining; k++) out.push(input[pos + k]!);
          break;
        }
        const chunk = Math.min(remaining, 131);
        out.push(0x80 | (chunk - 4)); // kind=1, n=chunk-4
        out.push(input[pos]!);
        pos += chunk;
        remaining -= chunk;
      }
      litStart = j;
      i = j;
    } else {
      i++;
    }
  }
  flushLiterals(n);
  return new Uint8Array(out);
}

/** RLE inverse transform. `outLen` is the expected original length. */
export function rleDecode(input: Uint8Array, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  let ip = 0;
  let op = 0;
  while (ip < input.length) {
    const head = input[ip++]!;
    if ((head & 0x80) === 0) {
      const count = (head & 0x7f) + 1;
      if (ip + count > input.length) {
        throw new CorruptionError(CODES.CORRUPT_BLOCK, "rle literal run truncated");
      }
      if (op + count > outLen) {
        throw new CorruptionError(CODES.CORRUPT_BLOCK, "rle literal run overruns output");
      }
      out.set(input.subarray(ip, ip + count), op);
      ip += count;
      op += count;
    } else {
      const run = (head & 0x7f) + 4;
      if (ip >= input.length) {
        throw new CorruptionError(CODES.CORRUPT_BLOCK, "rle run value missing");
      }
      const value = input[ip++]!;
      if (op + run > outLen) {
        throw new CorruptionError(CODES.CORRUPT_BLOCK, "rle run overruns output");
      }
      out.fill(value, op, op + run);
      op += run;
    }
  }
  if (op !== outLen) {
    throw new CorruptionError(CODES.CORRUPT_BLOCK, `rle output length mismatch: ${op} != ${outLen}`);
  }
  return out;
}

/** Delta transform: out[i] = in[i] - in[i-1] mod 256, out[0] = in[0]. */
export function deltaEncode(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  let prev = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i]!;
    out[i] = (b - prev) & 0xff;
    prev = b;
  }
  return out;
}

/** Delta inverse transform. */
export function deltaDecode(input: Uint8Array, outLen: number): Uint8Array {
  if (input.length !== outLen) {
    throw new CorruptionError(CODES.CORRUPT_BLOCK, "delta length mismatch");
  }
  const out = new Uint8Array(outLen);
  let acc = 0;
  for (let i = 0; i < outLen; i++) {
    acc = (acc + input[i]!) & 0xff;
    out[i] = acc;
  }
  return out;
}

/** Apply a transform to block bytes (transformId 0..2). */
export function applyTransform(id: number, data: Uint8Array): Uint8Array {
  switch (id) {
    case TRANSFORM_ID.NONE:
      return data;
    case TRANSFORM_ID.DELTA:
      return deltaEncode(data);
    case TRANSFORM_ID.RLE:
      return rleEncode(data);
    default:
      throw new FormatError(CODES.FORMAT_TRANSFORM_ID, `unknown transform id ${id}`);
  }
}

/**
 * Inverse-transform transformed bytes back to original block bytes.
 * Verifies the original length equals `rawLen`.
 */
export function inverseTransform(id: number, tdata: Uint8Array, rawLen: number): Uint8Array {
  switch (id) {
    case TRANSFORM_ID.NONE:
      if (tdata.length !== rawLen) {
        throw new CorruptionError(CODES.CORRUPT_BLOCK, "none-transform length mismatch");
      }
      return tdata;
    case TRANSFORM_ID.DELTA:
      return deltaDecode(tdata, rawLen);
    case TRANSFORM_ID.RLE:
      return rleDecode(tdata, rawLen);
    default:
      throw new FormatError(CODES.FORMAT_TRANSFORM_ID, `unknown transform id ${id}`);
  }
}

/** Maximum allowed decoded transformed length for a block (RLE bound). */
export function maxTLength(transformId: number, rawLen: number): number {
  if (transformId === TRANSFORM_ID.RLE) return rleMaxLen(rawLen);
  return rawLen;
}

export { FORMAT };
