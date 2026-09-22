/**
 * Bounded byte reader with strict, position-tracking reads. Every read past
 * the end of the input throws a typed error — the decoder never reads outside
 * the provided buffer and never hangs on truncated input.
 */

import { FormatError, CODES, FastPackError } from "./errors.js";
import { readVarint } from "./varint.js";
import { U64, u64 } from "./fp64.js";

export class ByteReader {
  readonly data: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array, private readonly end: number = data.length) {
    if (end < 0 || end > data.length) {
      throw new RangeError("invalid ByteReader end");
    }
    this.data = data;
  }

  /** The read limit (exclusive); reads never pass this. */
  get limit(): number {
    return this.end;
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  /** Absolute position of the next read. */
  get absPos(): number {
    return this.pos;
  }

  /** Seek to an absolute byte offset within [0, end]. */
  seek(pos: number): void {
    if (pos < 0 || pos > this.end) {
      throw new FormatError(CODES.FORMAT_LENGTH, "seek out of bounds", pos);
    }
    this.pos = pos;
  }

  /** Read one byte; throws on end of input. */
  next(): number {
    if (this.pos >= this.end) {
      throw new FormatError(CODES.FORMAT_LENGTH, "unexpected end of input", this.pos);
    }
    return this.data[this.pos++]!;
  }

  /** Peek one byte without consuming; returns -1 at end (non-throwing). */
  peek(): number {
    if (this.pos >= this.end) return -1;
    return this.data[this.pos]!;
  }

  readBytes(n: number): Uint8Array {
    if (n < 0) {
      throw new FormatError(CODES.FORMAT_LENGTH, "negative length", this.pos);
    }
    if (this.remaining < n) {
      throw new FormatError(CODES.FORMAT_LENGTH, "unexpected end of input", this.pos);
    }
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    if (n < 0 || this.remaining < n) {
      throw new FormatError(CODES.FORMAT_LENGTH, "skip beyond end of input", this.pos);
    }
    this.pos += n;
  }

  readVarint(): { value: number; bytesRead: number } {
    const r = readVarint(this);
    return r;
  }

  readU32LE(): number {
    if (this.remaining < 4) {
      throw new FormatError(CODES.FORMAT_LENGTH, "unexpected end of input", this.pos);
    }
    const v =
      this.data[this.pos]! |
      (this.data[this.pos + 1]! << 8) |
      (this.data[this.pos + 2]! << 16) |
      (this.data[this.pos + 3]! << 24);
    this.pos += 4;
    return v >>> 0;
  }

  readU64LE(): U64 {
    if (this.remaining < 8) {
      throw new FormatError(CODES.FORMAT_LENGTH, "unexpected end of input", this.pos);
    }
    const lo =
      this.data[this.pos]! |
      (this.data[this.pos + 1]! << 8) |
      (this.data[this.pos + 2]! << 16) |
      (this.data[this.pos + 3]! << 24);
    const hi =
      this.data[this.pos + 4]! |
      (this.data[this.pos + 5]! << 8) |
      (this.data[this.pos + 6]! << 16) |
      (this.data[this.pos + 7]! << 24);
    this.pos += 8;
    return u64(hi >>> 0, lo >>> 0);
  }
}

/** Re-export the error types the container layer commonly throws. */
export type { FastPackError };
