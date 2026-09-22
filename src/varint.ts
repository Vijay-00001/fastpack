/**
 * Bounded canonical varint (spec §10).
 *
 * Little-endian base-128, 7 bits per byte, continuation bit 0x80 on every byte
 * except the last. Overlong encodings are REJECTED (canonical form only).
 * Maximum 5 bytes for 32-bit values, 10 for 64-bit.
 *
 * Values in JS are `number` (exact to 2^53) — large enough for every format
 * field (all bounded by 2^24 except sequence numbers, which grow linearly with
 * stream size and never approach 2^53 in practice).
 */

import { FormatError, CODES } from "./errors.js";

export const VARINT_MAX_32 = 5;
export const VARINT_MAX_64 = 10;
/** largest value we accept (JS-safe integer space for practical streams) */
export const VARINT_LIMIT = Number.MAX_SAFE_INTEGER;

function assertVarintLimit(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > VARINT_LIMIT) {
    throw new FormatError(CODES.FORMAT_VARINT, `varint value out of range: ${value}`);
  }
}

/** Byte length of the canonical encoding of `value`. */
export function varintLen(value: number): number {
  assertVarintLimit(value);
  let len = 1;
  while (value >= 0x80) {
    value = Math.floor(value / 128);
    len++;
  }
  return len;
}

export interface ByteSink {
  push(b: number): void;
}

/** Append the canonical encoding of `value` to `out`. */
export function writeVarint(out: number[], value: number): void {
  assertVarintLimit(value);
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

/** Append the canonical encoding of `value` to a ByteSink. */
export function writeVarintTo(sink: ByteSink, value: number): void {
  assertVarintLimit(value);
  while (value >= 0x80) {
    sink.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  sink.push(value);
}

export interface ByteSource {
  /** read the next byte or return -1 at end */
  next(): number;
}

/**
 * Read one canonical varint from `src`. Returns { value, bytesRead }.
 * Rejects: overlong encodings, 64-bit overflow, truncation.
 */
export function readVarint(src: ByteSource): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let finalPayload = 0;
  for (let i = 0; i < VARINT_MAX_64; i++) {
    const b = src.next();
    if (b < 0) {
      throw new FormatError(CODES.FORMAT_VARINT, "truncated varint");
    }
    const payload = b & 0x7f;
    if (i === VARINT_MAX_64 - 1 && payload > 0x01) {
      throw new FormatError(CODES.FORMAT_VARINT, "varint overflow (64-bit limit)");
    }
    result += payload * Math.pow(2, shift);
    shift += 7;
    if ((b & 0x80) === 0) {
      finalPayload = payload;
      if (i > 0 && finalPayload === 0) {
        throw new FormatError(CODES.FORMAT_VARINT, "overlong varint encoding");
      }
      if (result > VARINT_LIMIT) {
        throw new FormatError(CODES.FORMAT_VARINT, "varint exceeds supported range");
      }
      return { value: result, bytesRead: i + 1 };
    }
  }
  throw new FormatError(CODES.FORMAT_VARINT, "varint too long");
}
