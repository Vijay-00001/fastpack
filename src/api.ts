/**
 * FastPack v0 public API (spec §17). One-shot and streaming entry points.
 */

import {
  packOneShot,
  unpackOneShot,
  encodeFrame,
  encodeFooter,
} from "./container.js";
import { Encoder, Decoder, analyze } from "./stream.js";
import { hashFp } from "./hash.js";
import {
  DEFAULT_OPTIONS,
  resolveOptions,
  transformName,
  type DecodeResult,
  type FastPackOptions,
  type Dictionary,
  type TransformId,
  type RecoveryEvent,
} from "./types.js";
import { FastPackError, OptionError, OptionMismatchError, FormatError, IntegrityError, CorruptionError, ResourceError, CODES } from "./errors.js";
import { FORMAT, PAYLOAD_TYPE, BLOCK_TYPE, TRANSFORM_ID, HASH_ID } from "./ids.js";
import { compressStream, decompressStream, metadata } from "./sdk.js";
import type { StreamMetadata, StreamFrameMeta } from "./sdk.js";

export {
  Encoder,
  Decoder,
  analyze,
  hashFp,
  FastPackError,
  OptionError,
  OptionMismatchError,
  FormatError,
  IntegrityError,
  CorruptionError,
  ResourceError,
  CODES,
  DEFAULT_OPTIONS,
  resolveOptions,
  transformName,
  FORMAT,
  PAYLOAD_TYPE,
  BLOCK_TYPE,
  TRANSFORM_ID,
  HASH_ID,
  compressStream,
  decompressStream,
  metadata,
};
export type {
  DecodeResult,
  FastPackOptions,
  Dictionary,
  TransformId,
  RecoveryEvent,
  StreamMetadata,
  StreamFrameMeta,
};

export interface CompressResult {
  data: Uint8Array;
  /** bytes of `data` actually represented (always input length for one-shot) */
  size: number;
}

/**
 * One-shot compress. The returned stream is self-contained (frames + footer).
 */
export function compress(
  data: Uint8Array,
  opts?: Partial<FastPackOptions>,
): Uint8Array {
  const options = resolveOptions(opts);
  return packOneShot(data, options);
}

/**
 * One-shot compress, keeping the raw passthrough representation when it is
 * strictly smaller. The raw representation is a single RAW_PASSTHROUGH frame
 * (payload = input) plus a footer, so it is always decodable.
 */
export function compressOrRaw(
  data: Uint8Array,
  opts?: Partial<FastPackOptions>,
): CompressResult {
  const options = resolveOptions(opts);
  const packed = packOneShot(data, options);
  if (packed.length < data.length) return { data: packed, size: packed.length };
  return { data: rawStream(data, options), size: data.length };
}

/** One-frame RAW_PASSTHROUGH stream + footer. */
function rawStream(data: Uint8Array, options: FastPackOptions): Uint8Array {
  const { windowSize } = options;
  const frame = encodeFrame(false, 0, true, PAYLOAD_TYPE.RAW_PASSTHROUGH, windowSize, data);
  const footer = encodeFooter(data.length, hashFp(data), 0);
  const out = new Uint8Array(frame.length + footer.length);
  out.set(frame, 0);
  out.set(footer, frame.length);
  return out;
}

/** One-shot decompress. Throws on integrity violations in strict mode. */
export function decompress(
  data: Uint8Array,
  opts?: Partial<FastPackOptions>,
): DecodeResult {
  const options = resolveOptions(opts);
  return unpackOneShot(data, options);
}

/** Streaming encoder (spec §14). One frame per block, fresh matcher per frame. */
export function createEncoder(opts?: Partial<FastPackOptions>): Encoder {
  return new Encoder(resolveOptions(opts));
}

/** Streaming decoder. Feed bytes with `write`, finish with `end`. */
export function createDecoder(opts?: Partial<FastPackOptions>): Decoder {
  return new Decoder(resolveOptions(opts));
}

/**
 * Stream-compatible encoder (Web Streams). Feed input chunks, read encoded
 * frames from the readable side. The stream ends with the footer after the
 * writer closes.
 */
export function createEncoderStream(
  opts?: Partial<FastPackOptions>,
): TransformStream<Uint8Array, Uint8Array> {
  const enc = createEncoder(opts);
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      enc.onData = (bytes) => controller.enqueue(bytes);
    },
    transform(chunk) {
      enc.write(chunk);
    },
    flush() {
      enc.flush();
    },
  });
}

/**
 * Stream-compatible decoder (Web Streams). Feed encoded chunks, read decoded
 * bytes. Throws on integrity violations (strict).
 */
export function createDecoderStream(
  opts?: Partial<FastPackOptions>,
): TransformStream<Uint8Array, Uint8Array> {
  const dec = createDecoder(opts);
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      dec.onBlock = (data) => controller.enqueue(data);
    },
    transform(chunk) {
      dec.write(chunk);
    },
    flush() {
      dec.end();
    },
  });
}
