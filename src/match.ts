/**
 * Original LZ77-style match finder (spec §8).
 *
 * Data structures:
 *   - 4-byte polynomial rolling-hash over 2^18 buckets
 *   - `head[h]` = most recent position with hash h, `prev[pos]` = previous
 *     position with the same hash (singly linked chain)
 *   - chain walk limited by `maxChain` (fast=16, normal=64)
 *   - lazy matching; MIN_MATCH=4, MAX_MATCH=258; first candidate wins ties
 *
 * Frame model: the matcher operates on one frame's buffer. Committed bytes are
 * in `buf[0..len)`. A candidate segment is staged at `buf[len..len+segLen)`,
 * then either committed (len advances) or rolled back. Rollback restores the
 * hash table so rejected candidates leave no trace — required so that a block
 * that is ultimately stored RAW can contribute its ORIGINAL bytes (or nothing)
 * without pollution from a discarded transformed evaluation.
 *
 * Matches only reference committed positions; a RAW block's bytes still enter
 * the frame buffer (the decoder mirrors this), so offsets stay consistent.
 */

import { FORMAT } from "./ids.js";
import { CorruptionError, CODES } from "./errors.js";

const HASH_MASK = FORMAT.HASH_SIZE - 1;
const P = FORMAT.HASH_PRIME;
const PM = P % FORMAT.HASH_SIZE;
const P2M = (PM * PM) % FORMAT.HASH_SIZE;
const P3M = (P2M * PM) % FORMAT.HASH_SIZE;
const EMPTY = -1;

export interface MatchSymbol {
  t: 0 | 1;
  /** literal byte (t=0) */
  b: number;
  /** match length (t=1), in [MIN_MATCH, MAX_MATCH] */
  len: number;
  /** match offset (t=1), in [1, windowSize] */
  off: number;
}

/** Growable symbol collector. */
export class SymbolList {
  readonly types: number[] = [];
  readonly bs: number[] = [];
  readonly lens: number[] = [];
  readonly offs: number[] = [];

  get length(): number {
    return this.types.length;
  }

  pushLiteral(b: number): void {
    this.types.push(0);
    this.bs.push(b);
    this.lens.push(0);
    this.offs.push(0);
  }

  pushMatch(len: number, off: number): void {
    this.types.push(1);
    this.bs.push(0);
    this.lens.push(len);
    this.offs.push(off);
  }
}

export class LZMatcher {
  private readonly buf: Uint8Array;
  private readonly head: Int32Array;
  private readonly prev: Int32Array;
  private readonly maxChain: number;
  /** tracking of writes for rollback */
  private readonly trackUndo: boolean;
  private readonly headStamp: Int32Array;
  private readonly prevUndoIdx: Int32Array;
  private readonly prevUndoVal: Int32Array;
  private readonly headUndoIdx: Int32Array;
  private readonly headUndoVal: Int32Array;
  private stamp = 1;
  private undoCount = 0;
  private headUndoCount = 0;
  /** committed length */
  len = 0;

  constructor(windowSize: number, maxChain: number, trackUndo: boolean, blockCapacity: number) {
    this.buf = new Uint8Array(windowSize);
    this.head = new Int32Array(FORMAT.HASH_SIZE);
    this.head.fill(EMPTY);
    this.prev = new Int32Array(windowSize);
    this.prev.fill(EMPTY);
    this.maxChain = maxChain;
    this.trackUndo = trackUndo;
    if (trackUndo) {
      this.headStamp = new Int32Array(FORMAT.HASH_SIZE);
      const cap = blockCapacity + 8;
      this.prevUndoIdx = new Int32Array(cap);
      this.prevUndoVal = new Int32Array(cap);
      this.headUndoIdx = new Int32Array(cap);
      this.headUndoVal = new Int32Array(cap);
    } else {
      this.headStamp = new Int32Array(0);
      this.prevUndoIdx = new Int32Array(0);
      this.prevUndoVal = new Int32Array(0);
      this.headUndoIdx = new Int32Array(0);
      this.headUndoVal = new Int32Array(0);
    }
  }

  private hashAt(pos: number): number {
    const b = this.buf;
    return (b[pos]! * P3M + b[pos + 1]! * P2M + b[pos + 2]! * PM + b[pos + 3]!) & HASH_MASK;
  }

  private insert(pos: number): void {
    const h = this.hashAt(pos);
    const old = this.head[h]!;
    if (this.trackUndo) {
      if (this.headStamp[h]! !== this.stamp) {
        this.headStamp[h] = this.stamp;
        if (this.headUndoCount < this.headUndoIdx.length) {
          this.headUndoIdx[this.headUndoCount] = h;
          this.headUndoVal[this.headUndoCount] = old;
          this.headUndoCount++;
        }
      }
      if (this.undoCount < this.prevUndoIdx.length) {
        this.prevUndoIdx[this.undoCount] = pos;
        this.prevUndoVal[this.undoCount] = this.prev[pos]!;
        this.undoCount++;
      }
    }
    this.prev[pos] = old;
    this.head[h] = pos;
  }

  /**
   * Find the best match at `pos` (pos must already be inserted). Returns
   * {len, off} or null. `end` bounds match length.
   */
  private search(pos: number, end: number): { len: number; off: number } | null {
    const maxLen = Math.min(FORMAT.MAX_MATCH, end - pos);
    if (maxLen < FORMAT.MIN_MATCH) return null;
    const h = this.hashAt(pos);
    let cur = this.prev[pos]!;
    let bestLen = 0;
    let bestOff = 0;
    let count = 0;
    const b = this.buf;
    while (cur !== EMPTY && count < this.maxChain) {
      let k = 0;
      while (k < maxLen && b[cur + k]! === b[pos + k]!) k++;
      if (k > bestLen) {
        bestLen = k;
        bestOff = pos - cur;
        if (bestLen === maxLen) break;
      }
      cur = this.prev[cur]!;
      count++;
    }
    if (bestLen >= FORMAT.MIN_MATCH) return { len: bestLen, off: bestOff };
    return null;
  }

  /**
   * Match the staged segment at `buf[segStart..segEnd)` (already copied in),
   * appending symbols to `out`. Uses committed history `buf[0..segStart)`.
   * This mutates the hash table; call `rollback` to discard.
   */
  matchSegment(segStart: number, segEnd: number, out: SymbolList): void {
    const b = this.buf;
    let i = segStart;
    let held: { len: number; off: number } | null = null;
    while (i < segEnd) {
      if (i + FORMAT.MIN_MATCH <= segEnd) {
        this.insert(i);
      }
      const m = i + FORMAT.MIN_MATCH <= segEnd ? this.search(i, segEnd) : null;
      if (m !== null) {
        if (held !== null && m.len <= held.len) {
          out.pushMatch(held.len, held.off);
          i = i - 1 + held.len;
          held = null;
          continue;
        }
        if (held !== null) {
          out.pushLiteral(b[i - 1]!);
          held = null;
        }
        held = m;
        i++;
        continue;
      }
      if (held !== null) {
        out.pushMatch(held.len, held.off);
        i = i - 1 + held.len;
        held = null;
        continue;
      }
      out.pushLiteral(b[i]!);
      i++;
    }
    if (held !== null) {
      throw new CorruptionError(CODES.CORRUPT_BLOCK, "internal: held match not drained");
    }
  }

  /** Discard all hash-table writes since the last commit. */
  rollback(): void {
    if (!this.trackUndo) {
      throw new CorruptionError(CODES.CORRUPT_BLOCK, "internal: rollback with undo disabled");
    }
    for (let i = 0; i < this.headUndoCount; i++) {
      this.head[this.headUndoIdx[i]!] = this.headUndoVal[i]!;
    }
    for (let i = 0; i < this.undoCount; i++) {
      this.prev[this.prevUndoIdx[i]!] = this.prevUndoVal[i]!;
    }
    this.headUndoCount = 0;
    this.undoCount = 0;
    this.stamp++;
    if (this.stamp === 0x7fffffff) {
      this.headStamp.fill(0);
      this.stamp = 1;
    }
  }

  /**
   * Insert every position in [start, end) that can anchor a match (i.e. that
   * has MIN_MATCH readable bytes) into the hash table. Mirrors the positions
   * `matchSegment` inserts, so post-commit history is identical whether a
   * segment was matched or inserted directly. When undo is enabled, each write
   * is tracked so a later `rollback` restores the prior state.
   */
  insertRange(start: number, end: number): void {
    const last = end - FORMAT.MIN_MATCH;
    for (let pos = start; pos <= last; pos++) {
      this.insert(pos);
    }
  }

  /** Stage bytes at the current commit frontier. */
  stage(bytes: Uint8Array): number {
    const start = this.len;
    this.buf.set(bytes, start);
    return start;
  }

  /** Commit the staged/inserted bytes up to `newLen`. */
  commit(newLen: number): void {
    this.len = newLen;
    // Committed writes are permanent; clear the undo log so a later
    // `rollback` only undoes writes made after this commit.
    this.headUndoCount = 0;
    this.undoCount = 0;
    this.stamp++;
    if (this.stamp === 0x7fffffff) {
      this.headStamp.fill(0);
      this.stamp = 1;
    }
  }
}
