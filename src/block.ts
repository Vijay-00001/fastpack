/**
 * Block entropy coding: symbol stream <-> range-coded bitstream (spec §7, §8.4).
 *
 * Per block, the model set is fresh (all prob0 = 2048). Bit order for all
 * multi-bit values is MSB-first and full-width:
 *   - literal byte: 8 bits, context (prevByte, bitIndex)
 *   - match length: value = len - MIN_MATCH, 8 bits, value 255 reserved
 *   - match offset: value = off - 1, ceil(log2(windowSize)) bits,
 *     context (bitIndex, posState), posState = blockPos & 7
 *   - matchFlag: 1 = MATCH, 0 = LITERAL
 *   - endFlag after each symbol: 1 = block complete
 *
 * prevByte is block-local and resets to 0 at the start of each compressed block.
 * Offsets are frame-relative (they may reference earlier blocks in the frame).
 */

import { FORMAT } from "./ids.js";
import { BlockModelSet } from "./model.js";
import { RangeEncoder, RangeDecoder } from "./range.js";
import { SymbolList } from "./match.js";
import { CorruptionError, CODES } from "./errors.js";

/** Number of bits used to encode a match offset for a given window size. */
export function offsetWidth(windowSize: number): number {
  return 32 - Math.clz32(windowSize - 1);
}

/** Encode a symbol list into `enc` using `models`. */
export function encodeSymbols(
  enc: RangeEncoder,
  models: BlockModelSet,
  symbols: SymbolList,
  offWidth: number,
  tdata: Uint8Array,
): void {
  const last = symbols.length - 1;
  let blockPos = 0;
  let prevByte = 0;
  for (let idx = 0; idx < symbols.length; idx++) {
    if (symbols.types[idx] === 1) {
      const len = symbols.lens[idx]!;
      const off = symbols.offs[idx]!;
      models.matchFlag.encodeBit(enc, 1);
      const lenVal = len - FORMAT.MIN_MATCH;
      for (let i = 0; i < FORMAT.LENGTH_BITS; i++) {
        models.lengthBits[i]!.encodeBit(enc, (lenVal >> (FORMAT.LENGTH_BITS - 1 - i)) & 1);
      }
      const offVal = off - 1;
      const posState = blockPos & 7;
      for (let i = 0; i < offWidth; i++) {
        models.offsetBits[i * 8 + posState]!.encodeBit(
          enc,
          (offVal >> (offWidth - 1 - i)) & 1,
        );
      }
      prevByte = tdata[blockPos + len - 1]!;
      blockPos += len;
    } else {
      const b = symbols.bs[idx]!;
      models.matchFlag.encodeBit(enc, 0);
      for (let i = 0; i < 8; i++) {
        models.literal[prevByte * 8 + i]!.encodeBit(enc, (b >> (7 - i)) & 1);
      }
      prevByte = b;
      blockPos += 1;
    }
    models.endFlag.encodeBit(enc, idx === last ? 1 : 0);
  }
}

/**
 * Decode a symbol stream into `frameBuf` starting at `blockStart`. Returns the
 * number of transformed bytes decoded for this block (blockTLen).
 * `maxTLen` bounds the block's transformed length (RLE bound for rle blocks).
 */
export function decodeSymbols(
  dec: RangeDecoder,
  models: BlockModelSet,
  offWidth: number,
  frameBuf: Uint8Array,
  blockStart: number,
  maxTLen: number,
): number {
  let blockPos = 0;
  let prevByte = 0;
  for (;;) {
    const isMatch = models.matchFlag.decodeBit(dec);
    let symLen: number;
    if (isMatch) {
      let lenVal = 0;
      for (let i = 0; i < FORMAT.LENGTH_BITS; i++) {
        lenVal = (lenVal << 1) | models.lengthBits[i]!.decodeBit(dec);
      }
      if (lenVal > FORMAT.LENGTH_VALUE_MAX) {
        throw new CorruptionError(CODES.CORRUPT_SYMBOL, "reserved match length value 255");
      }
      const len = lenVal + FORMAT.MIN_MATCH;
      const posState = blockPos & 7;
      let offVal = 0;
      for (let i = 0; i < offWidth; i++) {
        offVal = (offVal << 1) | models.offsetBits[i * 8 + posState]!.decodeBit(dec);
      }
      const off = offVal + 1;
      if (off > blockStart + blockPos) {
        throw new CorruptionError(CODES.CORRUPT_OFFSET, `offset ${off} beyond available history`);
      }
      if (blockPos + len > maxTLen) {
        throw new CorruptionError(CODES.CORRUPT_LENGTH, "match overruns block");
      }
      const src = blockStart + blockPos - off;
      for (let k = 0; k < len; k++) {
        frameBuf[blockStart + blockPos + k] = frameBuf[src + k]!;
      }
      symLen = len;
    } else {
      if (blockPos >= maxTLen) {
        throw new CorruptionError(CODES.CORRUPT_LENGTH, "literal overruns block");
      }
      let b = 0;
      for (let i = 0; i < 8; i++) {
        b = (b << 1) | models.literal[prevByte * 8 + i]!.decodeBit(dec);
      }
      frameBuf[blockStart + blockPos] = b;
      symLen = 1;
    }
    prevByte = frameBuf[blockStart + blockPos + symLen - 1]!;
    blockPos += symLen;
    const end = models.endFlag.decodeBit(dec);
    if (blockPos === maxTLen) {
      if (end === 0) {
        throw new CorruptionError(CODES.CORRUPT_LENGTH, "block overruns decoded length");
      }
      break;
    }
    if (end === 1) {
      break; // valid early end for RLE blocks
    }
  }
  return blockPos;
}
