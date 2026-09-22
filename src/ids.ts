/**
 * FastPack format constants and extensible ID registries (spec §9.4, §10).
 *
 * Every registry is versioned and extensible via numeric IDs; unknown IDs are
 * always a typed FormatError — the decoder never silently skips fields.
 */

export const FORMAT = {
  VERSION: 1,
  MAGIC: [0x46, 0x50, 0x41, 0x4b] as const, // "FPAK"
  END_MAGIC: [0x46, 0x50, 0x4b, 0x30] as const, // "FPK0"
  /** reserved flag bits must be zero */
  FLAG_HAS_SEQ: 0x01,
  FLAG_STREAM_END: 0x02,
  FLAG_RESERVED_MASK: 0xfc,

  WINDOW_MIN: 1,
  WINDOW_MAX: 1 << 24, // 2^24
  BLOCK_ALIGN_MIN: 1,
  BLOCK_ALIGN_MAX: 1 << 16,

  DEFAULT_WINDOW: 1 << 20, // 1 MiB
  DEFAULT_BLOCK_ALIGN: 1 << 12, // 4096
  DEFAULT_HYSTERESIS: 2,
  REORDER_WINDOW: 32,

  MIN_MATCH: 4,
  MAX_MATCH: 258,
  /** length value = len - MIN_MATCH; value 255 is reserved and rejected */
  LENGTH_BITS: 8,
  LENGTH_VALUE_MAX: 254,

  /** probability precision for range coder models */
  PROB_BITS: 12,
  PROB_MAX: 1 << 12, // 4096
  PROB_HALF: 1 << 11, // 2048 initial value

  /** range coder constants (spec §6) */
  RC_TOP: 0x100000000,
  RC_RENORM: 1 << 23,
  RC_MASK: 0xffffffff,

  /** matcher constants (spec §8) */
  HASH_BITS: 18,
  HASH_SIZE: 1 << 18,
  HASH_PRIME: 0x01000193,
  CHAIN_FAST: 16,
  CHAIN_NORMAL: 64,

  /** FPHash64 constants (spec §11) */
  FP_IV: 0xcbf29ce484222325n,
  FP_PRIME: 0x00000100000001b3n,
} as const;

/** payloadType registry */
export const PAYLOAD_TYPE = {
  RAW_PASSTHROUGH: 0,
  FASTPACK_BLOCKS: 1,
  // 2 = fastpack-v2 (future), 3 = persistent-dict-v1 (future), 100+ = user
} as const;

/** blockType registry */
export const BLOCK_TYPE = {
  RAW: 0,
  COMPRESSED: 1,
} as const;

/** transformId registry */
export const TRANSFORM_ID = {
  NONE: 0,
  DELTA: 1,
  RLE: 2,
  BITPLANE: 3, // future
  TOKENIZE: 4, // future
  PERSISTENT_DICT: 5, // future
} as const;

/** hashId registry */
export const HASH_ID = {
  FPHASH64: 0,
} as const;

/** human names for transform IDs */
export const TRANSFORM_NAMES: Record<number, string> = {
  [TRANSFORM_ID.NONE]: "none",
  [TRANSFORM_ID.DELTA]: "delta",
  [TRANSFORM_ID.RLE]: "rle",
  [TRANSFORM_ID.BITPLANE]: "bitplane",
  [TRANSFORM_ID.TOKENIZE]: "tokenize",
  [TRANSFORM_ID.PERSISTENT_DICT]: "persistent-dict",
};

export const TRANSFORM_ID_BY_NAME: Record<string, number> = {
  none: TRANSFORM_ID.NONE,
  delta: TRANSFORM_ID.DELTA,
  rle: TRANSFORM_ID.RLE,
  bitplane: TRANSFORM_ID.BITPLANE,
  tokenize: TRANSFORM_ID.TOKENIZE,
  "persistent-dict": TRANSFORM_ID.PERSISTENT_DICT,
};

export const VALID_TRANSFORM_IDS: ReadonlySet<number> = new Set([
  TRANSFORM_ID.NONE,
  TRANSFORM_ID.DELTA,
  TRANSFORM_ID.RLE,
]);
