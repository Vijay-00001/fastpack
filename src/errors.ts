/**
 * FastPack error taxonomy.
 *
 * Every error carries a stable string `code` (see CODES below) that tests and
 * callers may branch on. Codes are part of the public contract; messages are
 * not.
 */

export const CODES = {
  /** invalid options or encode/decode option mismatch */
  OPTION_INVALID: "fastpack.option.invalid",
  OPTION_MISMATCH: "fastpack.option.mismatch",
  /** magic, version, reserved flag bits, unknown IDs, varint/length violations */
  FORMAT_MAGIC: "fastpack.format.magic",
  FORMAT_VERSION: "fastpack.format.version",
  FORMAT_FLAGS: "fastpack.format.flags",
  FORMAT_PAYLOAD_TYPE: "fastpack.format.payload_type",
  FORMAT_BLOCK_TYPE: "fastpack.format.block_type",
  FORMAT_TRANSFORM_ID: "fastpack.format.transform_id",
  FORMAT_VARINT: "fastpack.format.varint",
  FORMAT_LENGTH: "fastpack.format.length",
  FORMAT_TRAILING: "fastpack.format.trailing",
  FORMAT_SEQ: "fastpack.format.seq",
  FORMAT_END: "fastpack.format.end",
  FORMAT_DICT_ID: "fastpack.format.dict_id",
  FORMAT_DICT_VERSION: "fastpack.format.dict_version",
  FORMAT_DICT_HASH: "fastpack.format.dict_hash",
  /** FPHash64 mismatch (strict mode) */
  INTEGRITY_HEADER: "fastpack.integrity.header",
  INTEGRITY_PAYLOAD: "fastpack.integrity.payload",
  INTEGRITY_TOTAL: "fastpack.integrity.total",
  /** structural corruption inside a payload/bitstream */
  CORRUPT_SYMBOL: "fastpack.corrupt.symbol",
  CORRUPT_OFFSET: "fastpack.corrupt.offset",
  CORRUPT_LENGTH: "fastpack.corrupt.length",
  CORRUPT_MODEL: "fastpack.corrupt.model",
  CORRUPT_BLOCK: "fastpack.corrupt.block",
  /** over-limit window/len/alloc */
  RESOURCE_WINDOW: "fastpack.resource.window",
  RESOURCE_LENGTH: "fastpack.resource.length",
  RESOURCE_BUFFER: "fastpack.resource.buffer",
  RESOURCE_REORDER: "fastpack.resource.reorder",
} as const;

export type ErrorCode = (typeof CODES)[keyof typeof CODES];

/** Base class for every FastPack error. */
export class FastPackError extends Error {
  readonly code: ErrorCode;
  /** 0-based byte offset in the input where the problem was detected, if known. */
  readonly position: number | undefined;

  constructor(code: ErrorCode, message: string, position?: number) {
    super(`[${code}] ${message}${position !== undefined ? ` @ offset ${position}` : ""}`);
    this.name = "FastPackError";
    this.code = code;
    this.position = position;
  }
}

export class OptionError extends FastPackError {
  constructor(message: string) {
    super(CODES.OPTION_INVALID, message);
    this.name = "OptionError";
  }
}

export class OptionMismatchError extends FastPackError {
  constructor(message: string) {
    super(CODES.OPTION_MISMATCH, message);
    this.name = "OptionMismatchError";
  }
}

export class FormatError extends FastPackError {
  constructor(code: ErrorCode, message: string, position?: number) {
    super(code, message, position);
    this.name = "FormatError";
  }
}

export class IntegrityError extends FastPackError {
  constructor(code: ErrorCode, message: string, position?: number) {
    super(code, message, position);
    this.name = "IntegrityError";
  }
}

export class CorruptionError extends FastPackError {
  constructor(code: ErrorCode, message: string, position?: number) {
    super(code, message, position);
    this.name = "CorruptionError";
  }
}

export class ResourceError extends FastPackError {
  constructor(code: ErrorCode, message: string, position?: number) {
    super(code, message, position);
    this.name = "ResourceError";
  }
}
