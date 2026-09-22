/**
 * Block codec: compresses one block (original bytes O) into a raw or
 * compressed block record, and decompresses it back. Combines the transform
 * stage, LZ matcher, and entropy coder per the spec pipeline (§4, §5.3).
 *
 * The matcher operates on one frame; `matcher.len` is the frame's committed
 * LZ-domain byte count. Blocks are processed strictly in frame order so
 * matches may reference earlier blocks in the same frame.
 *
 * When transforms are enabled, every enabled candidate (including `none`) is
 * fully evaluated and the winner chosen by encoded size; rejected candidates
 * are rolled back so a RAW fallback can contribute its ORIGINAL bytes to the
 * frame history without pollution.
 */

import { FORMAT, BLOCK_TYPE, TRANSFORM_ID } from "./ids.js";
import { ByteWriter } from "./writer.js";
import { ByteReader } from "./reader.js";
import { RangeEncoder, RangeDecoder } from "./range.js";
import { BlockModelSet } from "./model.js";
import { SymbolList, LZMatcher } from "./match.js";
import { encodeSymbols, decodeSymbols, offsetWidth } from "./block.js";
import {
  applyTransform,
  inverseTransform,
  maxTLength,
  rleMaxLen,
} from "./transform.js";
import { varintLen } from "./varint.js";
import { FormatError, CorruptionError, CODES } from "./errors.js";

export interface EncodedBlock {
  blockType: number; // BLOCK_TYPE
  transformId: number;
  rawLen: number;
  encLen: number; // 0 for RAW
  data: Uint8Array;
  /** bytes this block contributed to the frame LZ-domain history */
  lzLen: number;
}

export interface DecodedBlock {
  output: Uint8Array;
  /** bytes this block contributed to the frame LZ-domain history */
  lzLen: number;
}

/**
 * Encode one block. `transformIds` is the sorted list of enabled transform
 * IDs (excluding none). `hysteresisLeft > 0` forces a RAW block without
 * evaluation (spec §5.3 hysteresis).
 */
export function encodeBlock(
  matcher: LZMatcher,
  data: Uint8Array,
  transformIds: number[],
  offWidth: number,
  hysteresisLeft: number,
): EncodedBlock {
  const rawLen = data.length;

  if (hysteresisLeft > 0) {
    const start = matcher.stage(data);
    matcher.insertRange(start, start + rawLen);
    matcher.commit(start + rawLen);
    return { blockType: BLOCK_TYPE.RAW, transformId: TRANSFORM_ID.NONE, rawLen, encLen: 0, data, lzLen: rawLen };
  }

  if (transformIds.length === 0) {
    // fast path: single candidate, no rollback needed
    const stageStart = matcher.stage(data);
    const segEnd = stageStart + rawLen;
    const symbols = new SymbolList();
    matcher.matchSegment(stageStart, segEnd, symbols);
    const enc = new RangeEncoder(new ByteWriter());
    encodeSymbols(enc, new BlockModelSet(offWidth), symbols, offWidth, data);
    enc.flush();
    const bitLen = enc.byteLength;
    matcher.commit(segEnd); // original bytes stay as history either way
    if (varintLen(bitLen) + bitLen < rawLen) {
      return { blockType: BLOCK_TYPE.COMPRESSED, transformId: TRANSFORM_ID.NONE, rawLen, encLen: bitLen, data: enc.toUint8Array(), lzLen: rawLen };
    }
    return { blockType: BLOCK_TYPE.RAW, transformId: TRANSFORM_ID.NONE, rawLen, encLen: 0, data, lzLen: rawLen };
  }

  // transforms enabled: evaluate all candidates with rollback
  const candidates = [TRANSFORM_ID.NONE, ...transformIds];
  let best: { t: number; cost: number; enc: RangeEncoder } | null = null;
  for (const t of candidates) {
    const T = applyTransform(t, data);
    const stageStart = matcher.stage(T);
    const segEnd = stageStart + T.length;
    const symbols = new SymbolList();
    matcher.matchSegment(stageStart, segEnd, symbols);
    const enc = new RangeEncoder(new ByteWriter());
    encodeSymbols(enc, new BlockModelSet(offWidth), symbols, offWidth, T);
    enc.flush();
    const bitLen = enc.byteLength;
    const cost = varintLen(bitLen) + bitLen;
    matcher.rollback();
    if (best === null || cost < best.cost) {
      best = { t, cost, enc };
    }
  }

  if (best !== null && best.cost < rawLen) {
    const winnerT = applyTransform(best.t, data);
    const start = matcher.stage(winnerT);
    matcher.insertRange(start, start + winnerT.length);
    matcher.commit(start + winnerT.length);
    return {
      blockType: BLOCK_TYPE.COMPRESSED,
      transformId: best.t,
      rawLen,
      encLen: best.enc.byteLength,
      data: best.enc.toUint8Array(),
      lzLen: winnerT.length,
    };
  }

  const start = matcher.stage(data);
  matcher.insertRange(start, start + rawLen);
  matcher.commit(start + rawLen);
  return { blockType: BLOCK_TYPE.RAW, transformId: TRANSFORM_ID.NONE, rawLen, encLen: 0, data, lzLen: rawLen };
}

/**
 * Decode one block into `frameBuf` at `blockStart`, appending its LZ-domain
 * bytes. Returns the decoded output and the LZ length contributed.
 */
export function decodeBlock(
  reader: ByteReader,
  frameBuf: Uint8Array,
  blockStart: number,
  windowSize: number,
  offWidth: number,
): DecodedBlock {
  const blockType = reader.next()!;
  if (blockType !== BLOCK_TYPE.RAW && blockType !== BLOCK_TYPE.COMPRESSED) {
    throw new FormatError(CODES.FORMAT_BLOCK_TYPE, `unknown block type ${blockType}`, reader.position);
  }
  const transformId = reader.next()!;
  if (transformId !== TRANSFORM_ID.NONE &&
      transformId !== TRANSFORM_ID.DELTA &&
      transformId !== TRANSFORM_ID.RLE) {
    throw new FormatError(CODES.FORMAT_TRANSFORM_ID, `unknown transform id ${transformId}`, reader.position);
  }
  const rawLen = reader.readVarint().value;
  if (rawLen > windowSize) {
    throw new FormatError(CODES.FORMAT_LENGTH, `block rawLen ${rawLen} exceeds window ${windowSize}`, reader.position);
  }
  if (blockStart + maxTLength(transformId, rawLen) > windowSize) {
    throw new FormatError(CODES.FORMAT_LENGTH, "block exceeds frame LZ capacity", reader.position);
  }
  if (reader.remaining < rawLen && blockType === BLOCK_TYPE.RAW) {
    throw new FormatError(CODES.FORMAT_LENGTH, "raw block data truncated", reader.position);
  }

  if (blockType === BLOCK_TYPE.RAW) {
    if (transformId !== TRANSFORM_ID.NONE) {
      throw new FormatError(CODES.FORMAT_TRANSFORM_ID, "RAW block must have transformId 0", reader.position);
    }
    const data = reader.readBytes(rawLen);
    frameBuf.set(data, blockStart);
    return { output: data, lzLen: rawLen };
  }

  // COMPRESSED
  const encLen = reader.readVarint().value;
  if (encLen >= rawLen) {
    throw new FormatError(CODES.FORMAT_LENGTH, `compressed encLen ${encLen} not < rawLen ${rawLen}`, reader.position);
  }
  if (reader.remaining < encLen) {
    throw new FormatError(CODES.FORMAT_LENGTH, "compressed bitstream truncated", reader.position);
  }
  const sub = reader.readBytes(encLen);
  const dec = new RangeDecoder(new ByteReader(sub));
  const models = new BlockModelSet(offWidth);
  const maxTL = maxTLength(transformId, rawLen);
  const blockTLen = decodeSymbols(dec, models, offWidth, frameBuf, blockStart, maxTL);
  const tdata = frameBuf.subarray(blockStart, blockStart + blockTLen);
  const output = inverseTransform(transformId, tdata, rawLen);
  return { output, lzLen: blockTLen };
}

/** Worst-case LZ-domain length for a block of `rawLen` bytes. */
export function worstTLen(transformIds: number[], rawLen: number): number {
  if (transformIds.includes(TRANSFORM_ID.RLE)) return rleMaxLen(rawLen);
  return rawLen;
}

export { offsetWidth };
