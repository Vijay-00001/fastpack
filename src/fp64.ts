/**
 * Exact 64-bit integer arithmetic on (hi, lo) pairs of unsigned 32-bit words.
 *
 * JS `number` is exact only up to 2^53, so we represent every 64-bit value as
 * two 32-bit words and implement the operations FastPack needs (xor, shift,
 * wrapping multiply mod 2^64) with 16-bit limb arithmetic. This module backs
 * FPHash64 and must produce identical results to the Rust `u64` implementation.
 */

export interface U64 {
  hi: number; // unsigned 32-bit, bits 32..63
  lo: number; // unsigned 32-bit, bits 0..31
}

export function u64(hi: number, lo: number): U64 {
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

export function u64FromBigInt(v: bigint): U64 {
  const hi = Number((v >> 32n) & 0xffffffffn);
  const lo = Number(v & 0xffffffffn);
  return { hi, lo };
}

export function u64ToBigInt(v: U64): bigint {
  return (BigInt(v.hi) << 32n) | BigInt(v.lo);
}

export function u64ToNumber(v: U64): number {
  // exact only when the value fits in 2^53
  return v.hi * 0x100000000 + v.lo;
}

export function u64Xor(a: U64, b: U64): U64 {
  return { hi: (a.hi ^ b.hi) >>> 0, lo: (a.lo ^ b.lo) >>> 0 };
}

export function u64XorLo(a: U64, lo: number): U64 {
  return { hi: a.hi, lo: (a.lo ^ lo) >>> 0 };
}

/** logical right shift by k (0 ≤ k ≤ 64) */
export function u64Shr(v: U64, k: number): U64 {
  if (k <= 0) return v;
  if (k >= 64) return { hi: 0, lo: 0 };
  if (k >= 32) {
    return { hi: 0, lo: v.hi >>> (k - 32) };
  }
  const hi = v.hi >>> k;
  const lo = ((v.lo >>> k) | ((v.hi & ((1 << k) - 1)) << (32 - k))) >>> 0;
  return { hi, lo };
}

/**
 * Wrapping 64-bit multiply mod 2^64. `a` and `b` are 64-bit values; the result
 * is (a * b) mod 2^64. Uses 16-bit limbs; every intermediate product is exact
 * in JS numbers (max 2^34 for a 3-term sum).
 */
export function u64MulMod(a: U64, b: U64): U64 {
  // limb decomposition: value = a3·2^48 + a2·2^32 + a1·2^16 + a0
  const a0 = a.lo & 0xffff;
  const a1 = a.lo >>> 16;
  const a2 = a.hi & 0xffff;
  const a3 = a.hi >>> 16;
  const b0 = b.lo & 0xffff;
  const b1 = b.lo >>> 16;
  const b2 = b.hi & 0xffff;
  const b3 = b.hi >>> 16;

  // coefficients of the product mod 2^64 (degrees 0..3)
  const c0 = a0 * b0;
  const c1 = a0 * b1 + a1 * b0;
  const c2 = a0 * b2 + a1 * b1 + a2 * b0;
  const c3 = a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0;

  // carry propagation
  let carry = 0;
  let s0 = c0;
  const lo0 = s0 & 0xffff;
  carry = Math.floor(s0 / 0x10000);

  let s1 = c1 + carry;
  const lo1 = s1 & 0xffff;
  carry = Math.floor(s1 / 0x10000);

  let s2 = c2 + carry;
  const lo2 = s2 & 0xffff;
  carry = Math.floor(s2 / 0x10000);

  const s3 = c3 + carry;
  const lo3 = s3 & 0xffff;

  const lo = (lo0 | (lo1 << 16)) >>> 0;
  const hi = (lo2 | (lo3 << 16)) >>> 0;
  return { hi, lo };
}
