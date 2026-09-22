/**
 * Growable byte writer used by the container layer. Exposes the FastPack
 * little-endian integer encodings (FPHash64 is written as 8 little-endian bytes).
 */

import { writeVarintTo } from "./varint.js";
import { U64 } from "./fp64.js";

const INITIAL_CAPACITY = 1024;

export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity = INITIAL_CAPACITY) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < needed) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
  }

  push(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  pushBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  writeVarint(value: number): void {
    writeVarintTo(this, value);
  }

  writeU8(value: number): void {
    this.push(value);
  }

  writeU32LE(value: number): void {
    this.ensure(4);
    this.buf[this.len++] = value & 0xff;
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = (value >>> 16) & 0xff;
    this.buf[this.len++] = (value >>> 24) & 0xff;
  }

  writeU64LE(v: U64): void {
    this.ensure(8);
    this.buf[this.len++] = v.lo & 0xff;
    this.buf[this.len++] = (v.lo >>> 8) & 0xff;
    this.buf[this.len++] = (v.lo >>> 16) & 0xff;
    this.buf[this.len++] = (v.lo >>> 24) & 0xff;
    this.buf[this.len++] = v.hi & 0xff;
    this.buf[this.len++] = (v.hi >>> 8) & 0xff;
    this.buf[this.len++] = (v.hi >>> 16) & 0xff;
    this.buf[this.len++] = (v.hi >>> 24) & 0xff;
  }

  /** All bytes written so far (a copy). */
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** Bytes written since `mark` (a copy). */
  subarray(mark: number): Uint8Array {
    return this.buf.slice(mark, this.len);
  }
}
