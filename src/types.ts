/**
 * Public option and interface types (spec §5.1, §17, §22.3).
 */

import { FORMAT, TRANSFORM_ID } from "./ids.js";
import { OptionError } from "./errors.js";

export type TransformId =
  | typeof TRANSFORM_ID.NONE
  | typeof TRANSFORM_ID.DELTA
  | typeof TRANSFORM_ID.RLE
  | (number & {});

export interface FastPackOptions {
  /** match window, in bytes; 1..2^24, default 1 MiB */
  windowSize: number;
  /** matcher chain depth: fast=16, normal=64 */
  matchChain: "fast" | "normal";
  /** opt-in transforms (0..2 valid in M1) */
  transforms: TransformId[];
  /** input bytes per block, aligned to power-of-two; 1..2^16, default 4096 */
  blockAlignment: number;
  /** consecutive RAW decisions before re-evaluating COMPRESSED; default 2 */
  rawHysteresis: number;
  /** strict decoding (default true) vs opt-in partial recovery */
  strict: boolean;
}

export interface Dictionary {
  /** caller-supplied stable identifier (not a hash) */
  id: number;
  /** caller-supplied dictionary version */
  version: number;
  /** the dictionary bytes; must be identical on both sides */
  data: Uint8Array;
}

export interface RecoveryEvent {
  /** seq of the frame that failed, if known; 0 otherwise */
  frameSeq: number;
  /** byte offset into the stream where the failure was detected */
  streamOffset: number;
  /** short human-readable cause description */
  cause: string;
}

export interface DecodeResult {
  /** decoded bytes (partial in non-strict mode) */
  data: Uint8Array;
  /** true when corruption was recovered from in non-strict mode */
  recovered: boolean;
  /** recovery events (non-strict mode only) */
  events: RecoveryEvent[];
}

export const DEFAULT_OPTIONS: FastPackOptions = {
  windowSize: FORMAT.DEFAULT_WINDOW,
  matchChain: "normal",
  transforms: [],
  blockAlignment: FORMAT.DEFAULT_BLOCK_ALIGN,
  rawHysteresis: FORMAT.DEFAULT_HYSTERESIS,
  strict: true,
};

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Validate user-supplied options and fill defaults. */
export function resolveOptions(opts?: Partial<FastPackOptions>): FastPackOptions {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  if (!Number.isInteger(o.windowSize) || o.windowSize < FORMAT.WINDOW_MIN || o.windowSize > FORMAT.WINDOW_MAX) {
    throw new OptionError(`windowSize must be in [${FORMAT.WINDOW_MIN}, ${FORMAT.WINDOW_MAX}]`);
  }
  if (o.matchChain !== "fast" && o.matchChain !== "normal") {
    throw new OptionError(`matchChain must be 'fast' or 'normal'`);
  }
  if (!Array.isArray(o.transforms)) {
    throw new OptionError("transforms must be an array of transform IDs");
  }
  const seen = new Set<number>();
  for (const t of o.transforms) {
    if (!Number.isInteger(t) || t < 0) throw new OptionError(`invalid transform id ${t}`);
    if (seen.has(t)) throw new OptionError(`duplicate transform id ${t}`);
    seen.add(t);
    if (t !== TRANSFORM_ID.NONE && t !== TRANSFORM_ID.DELTA && t !== TRANSFORM_ID.RLE) {
      throw new OptionError(`transform id ${t} is not available in FastPack v0`);
    }
  }
  if (!Number.isInteger(o.blockAlignment) || o.blockAlignment < FORMAT.BLOCK_ALIGN_MIN || o.blockAlignment > FORMAT.BLOCK_ALIGN_MAX || !isPowerOfTwo(o.blockAlignment)) {
    throw new OptionError(`blockAlignment must be a power of two in [${FORMAT.BLOCK_ALIGN_MIN}, ${FORMAT.BLOCK_ALIGN_MAX}]`);
  }
  if (!Number.isInteger(o.rawHysteresis) || o.rawHysteresis < 0 || o.rawHysteresis > 255) {
    throw new OptionError("rawHysteresis must be an integer in [0, 255]");
  }
  o.strict = o.strict !== false;
  return o;
}

/** Convert a transform ID to its canonical name. */
export function transformName(id: number): string {
  switch (id) {
    case TRANSFORM_ID.NONE:
      return "none";
    case TRANSFORM_ID.DELTA:
      return "delta";
    case TRANSFORM_ID.RLE:
      return "rle";
    default:
      return `unknown(${id})`;
  }
}
