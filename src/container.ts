/**
 * Container layer (spec §9): frame/footer codec, FPHash64 integrity
 * verification, and the packing policies.
 *
 * One-shot `compress` emits window-sized frames (up to windowSize decoded
 * LZ bytes and windowSize payload bytes per frame); the streaming encoder
 * emits one frame per block. Frames are independently decodable; match
 * history never crosses a frame boundary.
 *
 * Layout (normative, §9.1/9.2):
 *   Frame:  magic u8[4]="FPAK", version u8, flags u8,
 *           [seq varint], payloadType u8, windowSize varint,
 *           payloadLen varint, headerHash u64 (over all prior bytes),
 *           payload u8[payloadLen], payloadHash u64
 *   Footer: endMagic u8[4]="FPK0", totalLen varint, totalHash u64, endSeq varint
 */

import { FORMAT, PAYLOAD_TYPE, BLOCK_TYPE, TRANSFORM_ID } from "./ids.js";
import { ByteWriter } from "./writer.js";
import { ByteReader } from "./reader.js";
import { hashFp, FpHashState } from "./hash.js";
import { U64 } from "./fp64.js";
import {
  FormatError,
  IntegrityError,
  ResourceError,
  FastPackError,
  CODES,
} from "./errors.js";
import { encodeBlock, decodeBlock, EncodedBlock, worstTLen } from "./blockcodec.js";
import { LZMatcher } from "./match.js";
import { offsetWidth } from "./block.js";
import { rleMaxLen } from "./transform.js";
import { varintLen } from "./varint.js";
import { FastPackOptions, DecodeResult, RecoveryEvent } from "./types.js";

const MAGIC = FORMAT.MAGIC;
const END_MAGIC = FORMAT.END_MAGIC;

function u64eq(a: U64, b: U64): boolean {
  return a.hi === b.hi && a.lo === b.lo;
}

export interface ParsedFrame {
  hasSeq: boolean;
  seq: number;
  streamEnd: boolean;
  payloadType: number;
  windowSize: number;
  payload: Uint8Array;
  /** stream offset where this frame starts */
  startPos: number;
  /** stream offset just past this frame (payloadHash end) */
  endPos: number;
}

/** Encode one frame. */
export function encodeFrame(
  hasSeq: boolean,
  seq: number,
  streamEnd: boolean,
  payloadType: number,
  windowSize: number,
  payload: Uint8Array,
): Uint8Array {
  const w = new ByteWriter();
  for (const b of MAGIC) w.writeU8(b);
  w.writeU8(FORMAT.VERSION);
  let flags = 0;
  if (hasSeq) flags |= FORMAT.FLAG_HAS_SEQ;
  if (streamEnd) flags |= FORMAT.FLAG_STREAM_END;
  w.writeU8(flags);
  if (hasSeq) w.writeVarint(seq);
  w.writeU8(payloadType);
  w.writeVarint(windowSize);
  w.writeVarint(payload.length);
  const headerHash = hashFp(w.toUint8Array());
  w.writeU64LE(headerHash);
  w.pushBytes(payload);
  const payloadHash = hashFp(payload);
  w.writeU64LE(payloadHash);
  return w.toUint8Array();
}

export interface ScannedHeader {
  hasSeq: boolean;
  seq: number;
  streamEnd: boolean;
  payloadType: number;
  windowSize: number;
  payloadLen: number;
  /** absolute offset where the payload begins (start + header bytes + 8 hash bytes) */
  payloadStart: number;
  /** total frame length in bytes */
  frameLen: number;
}

/**
 * Scan (without consuming) the frame header starting at `reader.position`.
 * Returns the parsed header or `null` when more bytes are needed. Throws
 * FormatError/ResourceError on actual violations.
 */
export function scanFrameHeader(reader: ByteReader): ScannedHeader | null {
  const start = reader.position;
  const data = reader.data;
  const limit = reader.limit;
  let p = start;

  const need = (n: number): number | null => {
    if (p + n > limit) return null;
    const v = data[p]!;
    p += 1;
    return v;
  };
  const needVarint = (): number | null => {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (p >= limit) return null;
      const b = data[p++]!;
      const payload = b & 0x7f;
      if (i === 9 && payload > 0x01) {
        throw new FormatError(CODES.FORMAT_VARINT, "varint overflow (64-bit limit)", p);
      }
      result += payload * Math.pow(2, shift);
      shift += 7;
      if ((b & 0x80) === 0) {
        if (i > 0 && payload === 0) {
          throw new FormatError(CODES.FORMAT_VARINT, "overlong varint encoding", p);
        }
        return result;
      }
    }
    throw new FormatError(CODES.FORMAT_VARINT, "varint too long", p);
  };

  for (const b of MAGIC) {
    const got = need(1);
    if (got === null) return null;
    if (got !== b) throw new FormatError(CODES.FORMAT_MAGIC, `bad magic byte 0x${got.toString(16)}`, p - 1);
  }
  const version = need(1);
  if (version === null) return null;
  if (version !== FORMAT.VERSION) throw new FormatError(CODES.FORMAT_VERSION, `unsupported version ${version}`, p - 1);
  const flags = need(1);
  if (flags === null) return null;
  if ((flags & FORMAT.FLAG_RESERVED_MASK) !== 0) throw new FormatError(CODES.FORMAT_FLAGS, `reserved flag bits set: 0x${flags.toString(16)}`, p - 1);
  const hasSeq = (flags & FORMAT.FLAG_HAS_SEQ) !== 0;
  const streamEnd = (flags & FORMAT.FLAG_STREAM_END) !== 0;
  let seq = 0;
  if (hasSeq) {
    const s = needVarint();
    if (s === null) return null;
    seq = s;
  }
  const payloadType = need(1);
  if (payloadType === null) return null;
  if (payloadType !== PAYLOAD_TYPE.RAW_PASSTHROUGH && payloadType !== PAYLOAD_TYPE.FASTPACK_BLOCKS) {
    throw new FormatError(CODES.FORMAT_PAYLOAD_TYPE, `unknown payloadType ${payloadType}`, p - 1);
  }
  const windowSize = needVarint();
  if (windowSize === null) return null;
  if (windowSize > FORMAT.WINDOW_MAX) throw new ResourceError(CODES.RESOURCE_WINDOW, `windowSize ${windowSize} exceeds 2^24`, p);
  const payloadLen = needVarint();
  if (payloadLen === null) return null;
  if (payloadLen > windowSize) throw new ResourceError(CODES.RESOURCE_LENGTH, `payloadLen ${payloadLen} exceeds windowSize ${windowSize}`, p);
  const payloadStart = p + 8; // + headerHash
  if (payloadStart + payloadLen + 8 > limit) return null;
  return {
    hasSeq,
    seq,
    streamEnd,
    payloadType,
    windowSize,
    payloadLen,
    payloadStart,
    frameLen: payloadStart + payloadLen + 8 - start,
  };
}

/** Parse and verify one frame from `reader`. Throws on any violation. */
export function decodeFrame(reader: ByteReader): ParsedFrame {
  const startPos = reader.position;
  const h = scanFrameHeader(reader);
  if (h === null) {
    throw new FormatError(CODES.FORMAT_LENGTH, "truncated frame header", reader.position);
  }
  const headerHash = hashFp(reader.data.subarray(startPos, h.payloadStart - 8));
  reader.seek(h.payloadStart - 8);
  const storedHeaderHash = reader.readU64LE();
  if (!u64eq(storedHeaderHash, headerHash)) {
    throw new IntegrityError(CODES.INTEGRITY_HEADER, "frame header hash mismatch", reader.position - 8);
  }
  const payload = reader.readBytes(h.payloadLen);
  const payloadHash = hashFp(payload);
  const storedPayloadHash = reader.readU64LE();
  if (!u64eq(storedPayloadHash, payloadHash)) {
    throw new IntegrityError(CODES.INTEGRITY_PAYLOAD, "frame payload hash mismatch", reader.position - 8);
  }
  return { hasSeq: h.hasSeq, seq: h.seq, streamEnd: h.streamEnd, payloadType: h.payloadType, windowSize: h.windowSize, payload, startPos, endPos: reader.position };
}

/** Encode the stream-end footer. */
export function encodeFooter(totalLen: number, totalHash: U64, endSeq: number): Uint8Array {
  const w = new ByteWriter();
  for (const b of END_MAGIC) w.writeU8(b);
  w.writeVarint(totalLen);
  w.writeU64LE(totalHash);
  w.writeVarint(endSeq);
  return w.toUint8Array();
}

/** Parse and verify the stream-end footer. */
export function decodeFooter(reader: ByteReader): { totalLen: number; totalHash: U64; endSeq: number } {
  const start = reader.position;
  for (const b of END_MAGIC) {
    const got = reader.next();
    if (got !== b) {
      throw new FormatError(CODES.FORMAT_END, `bad end magic byte 0x${got.toString(16)}`, reader.position - 1);
    }
  }
  const totalLen = reader.readVarint().value;
  const totalHash = reader.readU64LE();
  const endSeq = reader.readVarint().value;
  void start;
  return { totalLen, totalHash, endSeq };
}

/**
 * Scan (without consuming) a footer at `reader.position`. Returns the parsed
 * footer or `null` when more bytes are needed. Throws on violations.
 * `len` is the footer's byte length (caller uses it for trailing checks).
 */
export function scanFooter(
  reader: ByteReader,
): { totalLen: number; totalHash: U64; endSeq: number; len: number } | null {
  const data = reader.data;
  const start = reader.position;
  const limit = reader.limit;
  let p = start;

  const need = (n: number): number | null => {
    if (p + n > limit) return null;
    return data[p++]!;
  };
  const needVarint = (): number | null => {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (p >= limit) return null;
      const b = data[p++]!;
      const payload = b & 0x7f;
      if (i === 9 && payload > 0x01) {
        throw new FormatError(CODES.FORMAT_VARINT, "varint overflow (64-bit limit)", p);
      }
      result += payload * Math.pow(2, shift);
      shift += 7;
      if ((b & 0x80) === 0) {
        if (i > 0 && payload === 0) {
          throw new FormatError(CODES.FORMAT_VARINT, "overlong varint encoding", p);
        }
        return result;
      }
    }
    throw new FormatError(CODES.FORMAT_VARINT, "varint too long", p);
  };

  for (const b of END_MAGIC) {
    const got = need(1);
    if (got === null) return null;
    if (got !== b) throw new FormatError(CODES.FORMAT_END, `bad end magic byte 0x${got.toString(16)}`, p - 1);
  }
  const totalLen = needVarint();
  if (totalLen === null) return null;
  // read 8 bytes for totalHash
  let hashLo = 0;
  let hashHi = 0;
  for (let i = 0; i < 4; i++) {
    const b = need(1);
    if (b === null) return null;
    hashLo |= b! << (8 * i);
  }
  for (let i = 0; i < 4; i++) {
    const b = need(1);
    if (b === null) return null;
    hashHi |= b! << (8 * i);
  }
  const endSeq = needVarint();
  if (endSeq === null) return null;
  return { totalLen, totalHash: { hi: hashHi >>> 0, lo: hashLo >>> 0 }, endSeq, len: p - start };
}

/** Largest rawLen whose RAW block record fits in a payload budget. */
function maxRawByPayload(budget: number): number {
  let r = Math.max(0, budget - 2);
  while (r > 0 && 2 + varintLen(r) + r > budget) r--;
  return r;
}

/**
 * Largest rawLen whose worst-case LZ-domain length fits in `remainingLZ`
 * (accounts for RLE expansion when RLE is enabled).
 */
function maxRawByLZ(remainingLZ: number, transforms: number[]): number {
  if (transforms.includes(TRANSFORM_ID.RLE)) {
    let r = Math.max(0, Math.floor(((remainingLZ - 1) * 128) / 129));
    while (r > 0 && rleMaxLen(r) > remainingLZ) r--;
    return r;
  }
  return remainingLZ;
}

function isRaw(block: EncodedBlock): boolean {
  return block.blockType === BLOCK_TYPE.RAW;
}

/** Append a block record to a payload writer. */
function writeBlockRecord(w: ByteWriter, block: EncodedBlock): void {
  w.writeU8(block.blockType);
  w.writeU8(block.transformId);
  w.writeVarint(block.rawLen);
  if (block.blockType === BLOCK_TYPE.COMPRESSED) {
    w.writeVarint(block.encLen);
    w.pushBytes(block.data);
  } else {
    w.pushBytes(block.data);
  }
}

/**
 * Encode a single block (streaming frame payload). The matcher is fresh per
 * frame, so history is empty; matches may only reference within the block.
 */
export function encodeSingleBlockPayload(
  block: Uint8Array,
  opts: FastPackOptions,
): Uint8Array {
  const { windowSize, matchChain, transforms } = opts;
  const offWidth = offsetWidth(windowSize);
  const chain = matchChain === "fast" ? FORMAT.CHAIN_FAST : FORMAT.CHAIN_NORMAL;
  const transformsEnabled = transforms.length > 0;
  const blockCapacity = worstTLen(transforms, block.length) + 8;
  if (block.length > windowSize) {
    throw new ResourceError(CODES.RESOURCE_LENGTH, `block ${block.length} larger than window ${windowSize}`);
  }
  const matcher = new LZMatcher(windowSize, chain, transformsEnabled, blockCapacity);
  const w = new ByteWriter();
  writeBlockRecord(w, encodeBlock(matcher, block, transforms, offWidth, 0));
  return w.toUint8Array();
}

/**
 * Pack the whole input into a one-shot stream: window-sized frames followed by
 * the footer. `hasSeq` is false (single contiguous byte stream; endSeq=0).
 */
export function packOneShot(input: Uint8Array, opts: FastPackOptions): Uint8Array {
  const { windowSize, matchChain, transforms, blockAlignment, rawHysteresis } = opts;
  const offWidth = offsetWidth(windowSize);
  const chain = matchChain === "fast" ? FORMAT.CHAIN_FAST : FORMAT.CHAIN_NORMAL;
  const transformsEnabled = transforms.length > 0;
  const blockCapacity = worstTLen(transforms, Math.min(blockAlignment, windowSize)) + 8;

  const out = new ByteWriter();
  const totalHash = new FpHashState();
  let totalPayloadLen = 0;
  let offset = 0;

  if (input.length === 0) {
    const empty: Uint8Array = new Uint8Array(0);
    out.pushBytes(encodeFrame(false, 0, true, PAYLOAD_TYPE.FASTPACK_BLOCKS, windowSize, empty));
    totalHash.update(empty);
    out.pushBytes(encodeFooter(0, totalHash.digest(), 0));
    return out.toUint8Array();
  }

  while (offset < input.length) {
    const matcher = new LZMatcher(windowSize, chain, transformsEnabled, blockCapacity);
    const framePayload = new ByteWriter();
    let blockStart = 0;
    let payloadLen = 0;
    let hysteresisLeft = 0;

    while (offset < input.length) {
      const remainingLZ = windowSize - blockStart;
      if (remainingLZ <= 0) break;
      const payloadBudget = windowSize - payloadLen;
      let rawLen = Math.min(
        input.length - offset,
        blockAlignment,
        maxRawByLZ(remainingLZ, transforms),
        maxRawByPayload(payloadBudget),
      );
      if (rawLen <= 0) break;

      const data = input.subarray(offset, offset + rawLen);
      const block = encodeBlock(matcher, data, transforms, offWidth, hysteresisLeft);
      const recStart = framePayload.length;
      writeBlockRecord(framePayload, block);
      const recLen = framePayload.length - recStart;

      offset += rawLen;
      blockStart += block.lzLen;
      payloadLen += recLen;
      if (isRaw(block)) hysteresisLeft = rawHysteresis;
      else if (hysteresisLeft > 0) hysteresisLeft--;

      if (blockStart >= windowSize || payloadLen >= windowSize) break;
    }

    const payload = framePayload.toUint8Array();
    const streamEnd = offset >= input.length;
    out.pushBytes(encodeFrame(false, 0, streamEnd, PAYLOAD_TYPE.FASTPACK_BLOCKS, windowSize, payload));
    totalHash.update(payload);
    totalPayloadLen += payload.length;
    if (streamEnd) break;
  }

  out.pushBytes(encodeFooter(totalPayloadLen, totalHash.digest(), 0));
  return out.toUint8Array();
}

/** Decode a frame's block payload into its LZ-domain bytes (frame-local). */
export function decodeFrameBlocks(payload: Uint8Array, windowSize: number): Uint8Array[] {
  const frameBuf = new Uint8Array(windowSize);
  const reader = new ByteReader(payload);
  const offWidth = offsetWidth(windowSize);
  const out: Uint8Array[] = [];
  let blockStart = 0;
  while (reader.remaining > 0) {
    const r = decodeBlock(reader, frameBuf, blockStart, windowSize, offWidth);
    blockStart += r.lzLen;
    out.push(r.output);
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/**
 * Scan `reader.data` from `from` (absolute offset) for the next "FPAK" magic.
 * Returns the absolute offset of the match, or -1.
 */
function resyncFrame(data: Uint8Array, from: number): number {
  for (let i = from; i + 3 < data.length; i++) {
    if (data[i] === MAGIC[0] && data[i + 1] === MAGIC[1] && data[i + 2] === MAGIC[2] && data[i + 3] === MAGIC[3]) {
      return i;
    }
  }
  return -1;
}

/**
 * Unpack a one-shot stream. Strict mode throws on the first integrity/format
 * violation; non-strict mode records RecoveryEvents, skips unverifiable
 * frames, and returns what it can (spec §12).
 */
export function unpackOneShot(input: Uint8Array, opts: FastPackOptions): DecodeResult {
  const strict = opts.strict;
  const reader = new ByteReader(input);
  const out: Uint8Array[] = [];
  let totalLen = 0;
  const totalHash = new FpHashState();
  let hasSeqMode: boolean | null = null;
  let highestContiguous = 0;
  let lastSeq = 0;
  let sawStreamEnd = false;
  let recovered = false;
  const events: RecoveryEvent[] = [];

  const handleError = (e: unknown): boolean => {
    if (e instanceof FastPackError) {
      if (strict) throw e;
      recovered = true;
      events.push({
        frameSeq: hasSeqMode ? highestContiguous + 1 : 0,
        streamOffset: reader.position,
        cause: e.message,
      });
      const found = resyncFrame(input, reader.absPos + 1);
      if (found < 0) return false;
      reader.seek(found);
      return true;
    }
    throw e;
  };

  while (!sawStreamEnd) {
    let frame: ParsedFrame;
    try {
      frame = decodeFrame(reader);
    } catch (e) {
      if (!handleError(e)) break;
      continue;
    }
    if (hasSeqMode === null) hasSeqMode = frame.hasSeq;
    else if (hasSeqMode !== frame.hasSeq) {
      if (!handleError(new FormatError(CODES.FORMAT_SEQ, "mixed hasSeq/seq-less frames", reader.position))) break;
      continue;
    }
    let skipOutput = false;
    if (frame.hasSeq) {
      if (frame.seq <= highestContiguous) {
        skipOutput = true;
      } else if (frame.seq !== highestContiguous + 1) {
        if (!handleError(new FormatError(CODES.FORMAT_SEQ, `seq gap: expected ${highestContiguous + 1}, got ${frame.seq}`, frame.startPos))) break;
        continue;
      } else {
        highestContiguous = frame.seq;
        lastSeq = frame.seq;
      }
    }
    totalLen += frame.payload.length;
    totalHash.update(frame.payload);
    if (!skipOutput) {
      if (frame.payloadType === PAYLOAD_TYPE.RAW_PASSTHROUGH) {
        out.push(frame.payload);
      } else {
        try {
          const blocks = decodeFrameBlocks(frame.payload, frame.windowSize);
          for (const b of blocks) out.push(b);
        } catch (e) {
          if (!handleError(e)) break;
          continue;
        }
      }
    }
    if (frame.streamEnd) {
      sawStreamEnd = true;
      try {
        const footer = decodeFooter(reader);
        if (footer.totalLen !== totalLen) {
          throw new IntegrityError(CODES.INTEGRITY_TOTAL, `totalLen mismatch: footer ${footer.totalLen}, decoded ${totalLen}`);
        }
        if (!u64eq(footer.totalHash, totalHash.digest())) {
          throw new IntegrityError(CODES.INTEGRITY_TOTAL, "totalHash mismatch");
        }
        if (hasSeqMode) {
          if (footer.endSeq !== lastSeq) {
            throw new FormatError(CODES.FORMAT_SEQ, `endSeq ${footer.endSeq} != last frame seq ${lastSeq}`);
          }
        } else if (footer.endSeq !== 0) {
          throw new FormatError(CODES.FORMAT_SEQ, `endSeq ${footer.endSeq} on seq-less stream`);
        }
        if (reader.remaining > 0) {
          throw new FormatError(CODES.FORMAT_TRAILING, `${reader.remaining} trailing bytes after footer`);
        }
      } catch (e) {
        if (!handleError(e)) break;
      }
    }
  }

  return { data: concat(out), recovered, events };
}
