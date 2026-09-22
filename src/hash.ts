/**
 * FPHash64 (spec §11) — original, deterministic, NON-CRYTOGRAPHIC 64-bit
 * integrity hash for corruption detection only. It is not an authentication
 * primitive and must not be used where an attacker could forge inputs.
 *
 * state = IV
 * for each byte b: state ^= b; state *= PRIME (wrapping mod 2^64)
 * 3 finalization rounds: state = (state ^ (state>>29)) * PRIME; state ^= state>>32
 *
 * Byte-identical across the TS reference and the Rust core.
 */

import { FORMAT } from "./ids.js";
import { U64, u64, u64MulMod, u64Shr, u64Xor, u64XorLo } from "./fp64.js";

export const FP_IV: U64 = u64(
  Number((FORMAT.FP_IV >> 32n) & 0xffffffffn),
  Number(FORMAT.FP_IV & 0xffffffffn),
);
export const FP_PRIME: U64 = u64(
  Number((FORMAT.FP_PRIME >> 32n) & 0xffffffffn),
  Number(FORMAT.FP_PRIME & 0xffffffffn),
);

export type FPHash64 = U64;

/** Hash a byte array. */
export function hashFp(data: Uint8Array): U64 {
  let s = FP_IV;
  for (let i = 0; i < data.length; i++) {
    s = u64XorLo(s, data[i]!);
    s = u64MulMod(s, FP_PRIME);
  }
  return finalize(s);
}

/** Incremental hashing state for streaming. */
export class FpHashState {
  private s: U64 = FP_IV;

  update(data: Uint8Array): void {
    let s = this.s;
    for (let i = 0; i < data.length; i++) {
      s = u64XorLo(s, data[i]!);
      s = u64MulMod(s, FP_PRIME);
    }
    this.s = s;
  }

  updateByte(b: number): void {
    let s = this.s;
    s = u64XorLo(s, b & 0xff);
    s = u64MulMod(s, FP_PRIME);
    this.s = s;
  }

  digest(): U64 {
    return finalize(this.s);
  }
}

function finalize(s: U64): U64 {
  let st = s;
  for (let i = 0; i < 3; i++) {
    st = u64MulMod(u64Xor(st, u64Shr(st, 29)), FP_PRIME);
    st = u64Xor(st, u64Shr(st, 32));
  }
  return st;
}
