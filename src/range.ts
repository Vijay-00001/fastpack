/**
 * FastPack binary range coder (spec §6) — original, deterministic, 32-bit.
 *
 * Encoder: 64-bit `low` (bits 0..32 live + carry bit 32), 32-bit `range`,
 * byte renormalization with underflow buffering. Decoder: unmasked 64-bit
 * `low` accumulated from consumed bytes. Both implementations (TS reference
 * and Rust core) MUST produce byte-identical streams.
 */

import { FORMAT } from "./ids.js";
import { ByteWriter } from "./writer.js";
import { ByteReader } from "./reader.js";
import { CorruptionError, FormatError, CODES } from "./errors.js";

const PROB_MAX = FORMAT.PROB_MAX; // 4096
const DIV = 1 << FORMAT.PROB_BITS; // 4096

export class RangeEncoder {
  private low = 0; // Number, exact: 0..2^33
  private range = FORMAT.RC_TOP - 1;
  private cache = 0;
  private underflow = 0;
  private readonly out: ByteWriter;

  constructor(out: ByteWriter) {
    this.out = out;
  }

  /** Encode one bit given the 12-bit probability of bit=0. */
  encodeBit(prob0: number, bit: number): void {
    if (!(prob0 >= 1 && prob0 <= PROB_MAX - 1)) {
      throw new CorruptionError(CODES.CORRUPT_MODEL, `prob0 out of range: ${prob0}`);
    }
    const bound = Math.floor((this.range * prob0) / DIV);
    if (bit === 0) {
      this.range = bound;
    } else {
      this.low += bound;
      this.range -= bound;
    }
    while (this.range < FORMAT.RC_RENORM) {
      this.shiftLow();
      this.range *= 256;
    }
  }

  /**
   * Normative shiftLow (spec §6.2). Emits one byte with carry/underflow
   * handling, then `low = (low << 8) & MASK`.
   */
  private shiftLow(): void {
    const low32 = this.low % FORMAT.RC_TOP;
    const carry = Math.floor(this.low / FORMAT.RC_TOP); // 0 or 1
    if (low32 < 0xff000000 || carry !== 0) {
      this.out.push((this.cache + carry) & 0xff);
      for (let i = 0; i < this.underflow; i++) {
        this.out.push((0xff + carry) & 0xff);
      }
      this.cache = Math.floor(low32 / 0x1000000); // (low >> 24) & 0xFF
      this.underflow = 0;
    } else {
      this.underflow += 1;
    }
    this.low = (low32 * 256) % FORMAT.RC_TOP;
  }

  /** Flush pending state (spec §6.3). */
  flush(): void {
    for (let i = 0; i < 5; i++) {
      this.shiftLow();
    }
    this.out.push(this.cache);
    for (let i = 0; i < this.underflow; i++) {
      this.out.push(0xff);
    }
  }

  /** Number of encoded bytes produced so far. */
  get byteLength(): number {
    return this.out.length;
  }

  /** The encoded bytes written so far (a copy). */
  toUint8Array(): Uint8Array {
    return this.out.toUint8Array();
  }
}

export class RangeDecoder {
  private low = 0; // Number, exact; accumulated code value
  private range = FORMAT.RC_TOP - 1;
  private readonly reader: ByteReader;

  constructor(reader: ByteReader) {
    if (reader.remaining < 5) {
      throw new FormatError(CODES.FORMAT_LENGTH, "range-coded block too short", reader.position);
    }
    this.reader = reader;
    // The encoder's first emitted byte is a phantom placeholder (initial
    // cache = 0), so the decoder consumes it and reads the next 4 bytes
    // (MSB-first) as the code value.
    reader.next(); // placeholder
    this.low =
      reader.next()! * 0x1000000 +
      reader.next()! * 0x10000 +
      reader.next()! * 0x100 +
      reader.next()!;
  }

  /** Decode one bit given the 12-bit probability of bit=0. */
  decodeBit(prob0: number): number {
    if (!(prob0 >= 1 && prob0 <= PROB_MAX - 1)) {
      throw new CorruptionError(CODES.CORRUPT_MODEL, `prob0 out of range: ${prob0}`);
    }
    const bound = Math.floor((this.range * prob0) / DIV);
    let bit: number;
    if (this.low < bound) {
      bit = 0;
      this.range = bound;
    } else {
      bit = 1;
      this.low -= bound;
      this.range -= bound;
    }
    while (this.range < FORMAT.RC_RENORM) {
      this.range *= 256;
      this.low = this.low * 256 + this.reader.next()!;
    }
    return bit;
  }
}
