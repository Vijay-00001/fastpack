/**
 * Adaptive binary context models (spec §7).
 *
 * Each model is a 12-bit `prob0` (probability the next bit is 0) with the
 * deterministic update:
 *
 *   prob0 += bit==0 ? (4096 - prob0) >> rate : -(prob0 >> rate),  rate = 5
 *
 * Models are initialized to 2048 (uniform) and are local to one compressed
 * block. Model memory is constant (~4.2 KiB) regardless of window size.
 */

import { FORMAT } from "./ids.js";
import { RangeEncoder, RangeDecoder } from "./range.js";

const PROB_MAX = FORMAT.PROB_MAX;
const RATE = 5;

export class BitModel {
  prob0 = FORMAT.PROB_HALF; // 2048

  encodeBit(enc: RangeEncoder, bit: number): void {
    enc.encodeBit(this.prob0, bit);
    this.update(bit);
  }

  decodeBit(dec: RangeDecoder): number {
    const bit = dec.decodeBit(this.prob0);
    this.update(bit);
    return bit;
  }

  private update(bit: number): void {
    if (bit === 0) {
      this.prob0 += (PROB_MAX - this.prob0) >> RATE;
    } else {
      this.prob0 -= this.prob0 >> RATE;
    }
    // prob0 stays within [1, PROB_MAX-1] by construction
  }
}

export const LITERAL_MODELS = 256 * 8; // 2048
/** offset models = offWidth bits * 8 posStates */
export const OFFSET_MODELS = 8 * 8; // minimum: offWidth >= 8 always

/**
 * The model set for one compressed block (spec §7.2). Fresh instance per
 * block; positions are block-local. `offWidth` sizes the offset model table
 * (window up to 2^24 => offWidth up to 24 => 192 offset models).
 */
export class BlockModelSet {
  matchFlag = new BitModel();
  endFlag = new BitModel();
  literal: BitModel[] = [];
  lengthBits: BitModel[] = [];
  offsetBits: BitModel[] = [];

  constructor(offWidth = OFFSET_MODELS / 8) {
    for (let i = 0; i < LITERAL_MODELS; i++) this.literal.push(new BitModel());
    for (let i = 0; i < FORMAT.LENGTH_BITS; i++) this.lengthBits.push(new BitModel());
    for (let i = 0; i < offWidth * 8; i++) this.offsetBits.push(new BitModel());
  }
}
