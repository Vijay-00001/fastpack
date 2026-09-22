/**
 * FastPack v0 unified developer SDK surface (layered on the stable M1 API).
 *
 * This module adds developer-facing conveniences WITHOUT changing the format,
 * the core encode/decode behavior, or the existing `api.ts` entry points:
 *
 *   - `compressStream`  / `decompressStream`  — Web Streams pipeline helpers.
 *   - `metadata`  — read-only structural extraction of version, frame layout,
 *     lengths, and stored hashes from an existing stream (no decode, no hash
 *     verification; use `decompress` when verification is required).
 *
 * All functions here are pure wrappers over the validated M1 surface and never
 * alter the wire format.
 */

import { ByteReader } from "./reader.js";
import { scanFrameHeader, decodeFooter, type ScannedHeader } from "./container.js";
import { FormatError, CODES } from "./errors.js";
import { FORMAT, PAYLOAD_TYPE } from "./ids.js";
import { createEncoderStream, createDecoderStream } from "./api.js";
import { u64ToBigInt } from "./fp64.js";
import type { FastPackOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Web Streams pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Compress a Web Stream of input chunks into a Web Stream of encoded bytes.
 * The produced stream is a valid FastPack stream (frames + footer); it is
 * byte-identical to feeding the same bytes through `createEncoder` in order,
 * regardless of how the input was chunked.
 */
export function compressStream(
  input: ReadableStream<Uint8Array>,
  opts?: Partial<FastPackOptions>,
): ReadableStream<Uint8Array> {
  return input.pipeThrough(createEncoderStream(opts));
}

/**
 * Decompress a Web Stream of encoded bytes into a Web Stream of decoded bytes.
 * Strict by default; set `{ strict: false }` to opt into partial recovery.
 * Throws (errors the stream) on integrity violations in strict mode.
 */
export function decompressStream(
  input: ReadableStream<Uint8Array>,
  opts?: Partial<FastPackOptions>,
): ReadableStream<Uint8Array> {
  return input.pipeThrough(createDecoderStream(opts));
}

// ---------------------------------------------------------------------------
// Read-only stream metadata
// ---------------------------------------------------------------------------

export interface StreamFrameMeta {
  /** whether this frame carried a sequence number */
  hasSeq: boolean;
  /** frame sequence number (0 when hasSeq is false) */
  seq: number;
  /** true for the frame that carries the stream-end footer */
  streamEnd: boolean;
  /** payloadType registry ID (0 = raw passthrough, 1 = fastpack blocks) */
  payloadType: number;
  /** encoder window size declared by the frame, in bytes */
  windowSize: number;
  /** payload byte length */
  payloadLen: number;
  /** stored header hash (u64 as bigint), read verbatim */
  headerHash: bigint;
  /** stored payload hash (u64 as bigint), read verbatim */
  payloadHash: bigint;
  /** stream offset where this frame starts */
  startPos: number;
  /** stream offset just past this frame (payloadHash end) */
  endPos: number;
}

export interface StreamMetadata {
  /** format version (1 in v0) */
  version: number;
  /** number of frames parsed */
  frameCount: number;
  /** per-frame structural information, in stream order */
  frames: StreamFrameMeta[];
  /** footer: total payload bytes across all frames */
  totalLen: number;
  /** footer: FPHash64 over the concatenation of all frame payloads */
  totalHash: bigint;
  /** footer: last frame seq (0 for seq-less streams) */
  endSeq: number;
  /** total encoded byte length of the stream */
  encodedBytes: number;
}

function readU64LEAt(data: Uint8Array, pos: number): bigint {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 4; i++) lo |= data[pos + i]! << (8 * i);
  for (let i = 0; i < 4; i++) hi |= data[pos + 4 + i]! << (8 * i);
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

function finishHeader(data: Uint8Array, limit: number, h: ScannedHeader): StreamFrameMeta {
  const headerHash = readU64LEAt(data, h.payloadStart - 8);
  const payloadHashPos = h.payloadStart + h.payloadLen;
  if (payloadHashPos + 8 > limit) {
    throw new FormatError(CODES.FORMAT_LENGTH, "truncated payload hash", payloadHashPos);
  }
  const payloadHash = readU64LEAt(data, payloadHashPos);
  return {
    hasSeq: h.hasSeq,
    seq: h.seq,
    streamEnd: h.streamEnd,
    payloadType: h.payloadType,
    windowSize: h.windowSize,
    payloadLen: h.payloadLen,
    headerHash,
    payloadHash,
    startPos: 0,
    endPos: payloadHashPos + 8,
  };
}

/**
 * Read-only structural inspection of an existing FastPack stream.
 *
 * Parses every frame header and the footer, returning the version, per-frame
 * layout (seq, streamEnd, payloadType, windowSize, payloadLen, stored hashes),
 * and the footer totals. It does NOT decode payloads and does NOT verify
 * hashes — use `decompress` when verification is required. Structural
 * violations (bad magic/version/IDs/lengths, missing footer, trailing bytes)
 * throw typed errors so inspection never silently misreads a stream.
 */
export function metadata(data: Uint8Array): StreamMetadata {
  const limit = data.length;
  const frames: StreamFrameMeta[] = [];
  let pos = 0;
  let sawStreamEnd = false;

  while (!sawStreamEnd) {
    if (pos >= limit) {
      throw new FormatError(CODES.FORMAT_END, "stream did not end with a streamEnd frame", pos);
    }
    const reader = new ByteReader(data, limit);
    reader.seek(pos);
    const h = scanFrameHeader(reader);
    if (h === null) {
      throw new FormatError(CODES.FORMAT_LENGTH, "truncated frame header", pos);
    }
    const meta = finishHeader(data, limit, h);
    meta.startPos = pos;
    frames.push(meta);
    pos = meta.endPos;
    if (h.streamEnd) sawStreamEnd = true;
  }

  if (pos >= limit) {
    throw new FormatError(CODES.FORMAT_END, "missing footer after streamEnd frame", pos);
  }
  const reader = new ByteReader(data, limit);
  reader.seek(pos);
  const footer = decodeFooter(reader);
  if (reader.remaining > 0) {
    throw new FormatError(CODES.FORMAT_TRAILING, `${reader.remaining} trailing bytes after footer`, reader.position);
  }

  return {
    version: FORMAT.VERSION,
    frameCount: frames.length,
    frames,
    totalLen: footer.totalLen,
    totalHash: u64ToBigInt(footer.totalHash),
    endSeq: footer.endSeq,
    encodedBytes: data.length,
  };
}

/** Convenience: sum of all frame payload lengths from a metadata result. */
export function payloadBytes(meta: StreamMetadata): number {
  let total = 0;
  for (const f of meta.frames) total += f.payloadLen;
  return total;
}

/** Convenience: whether every frame declares the same window size. */
export function uniformWindow(meta: StreamMetadata): boolean {
  if (meta.frames.length === 0) return true;
  const w = meta.frames[0]!.windowSize;
  return meta.frames.every((f) => f.windowSize === w);
}

// Re-export for convenience so SDK consumers get the payloadType registry too.
export { PAYLOAD_TYPE };
