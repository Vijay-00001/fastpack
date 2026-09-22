/**
 * Transport ACK state machine (spec §13) and analyze() stats tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/api.js";
import { Transport } from "../src/stream.js";
import { FormatError } from "../src/errors.js";

test("transport: send/markSent/ack lifecycle evicts acked frames", () => {
  const t = new Transport();
  const f1 = new Uint8Array([1]);
  const f2 = new Uint8Array([2, 2]);
  const s1 = t.sendFrame(f1, 1);
  const s2 = t.sendFrame(f2, 2);
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  assert.equal(t.outstanding().length, 2);

  t.markSent(s1);
  t.onAck(s1);
  // s2 still unacked -> not evicted
  assert.equal(t.outstanding().length, 1);
  assert.equal(t.outstanding()[0]!.seq, s2);

  t.markSent(s2);
  t.onAck(s2);
  assert.equal(t.outstanding().length, 0);
  assert.equal(t.ackHigh, 2);
});

test("transport: out-of-order ack keeps gap frame alive", () => {
  const t = new Transport();
  const s1 = t.sendFrame(new Uint8Array([1]), 1);
  const s2 = t.sendFrame(new Uint8Array([2]), 1);
  const s3 = t.sendFrame(new Uint8Array([3]), 1);
  t.onAck(s3); // high ack but gap at s1
  // contiguous ack window does not advance past the gap
  assert.equal(t.ackHigh, 0);
  // s3 is acked (no retransmission needed) but s1, s2 are outstanding
  assert.equal(t.outstanding().length, 2);
  t.onAck(s1);
  assert.equal(t.ackHigh, 1);
  t.onAck(s2);
  assert.equal(t.ackHigh, 3);
  assert.equal(t.outstanding().length, 0);
});

test("transport: timeout returns frame and retry re-arms", () => {
  const t = new Transport();
  const s1 = t.sendFrame(new Uint8Array([9]), 1);
  t.markSent(s1);
  const re = t.onTimeout(s1);
  assert.deepEqual(re, new Uint8Array([9]));
  assert.equal(t.outstanding()[0]!.state, "TIMED_OUT");
  t.retry(s1);
  assert.equal(t.outstanding()[0]!.state, "SEND_READY");
});

test("transport: unknown seq is silent for ack, typed error for timeout", () => {
  const t = new Transport();
  t.onAck(99); // evicted/unknown -> no-op
  assert.throws(() => t.onTimeout(99), FormatError);
});

test("analyze: empty input is well-formed", () => {
  const r = analyze(new Uint8Array(0));
  assert.equal(r.size, 0);
  assert.equal(r.entropy, 0);
  assert.equal(r.runFraction, 0);
  assert.deepEqual(r.suggestedTransforms, []);
});

test("analyze: repetitive runs suggest rle", () => {
  const r = analyze(new TextEncoder().encode("aaaaabbbbbccccc".repeat(100)));
  assert.ok(r.runFraction > 0.5);
  assert.ok(r.suggestedTransforms.includes(2));
});

test("analyze: low delta entropy suggests delta", () => {
  const data = new Uint8Array(4096);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;
  const r = analyze(data);
  assert.ok(r.deltaEntropy < r.entropy - 0.5);
  assert.ok(r.suggestedTransforms.includes(1));
});
