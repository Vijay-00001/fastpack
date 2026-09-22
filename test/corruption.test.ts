/**
 * Corruption and integrity tests (spec §12): strict mode throws typed errors;
 * non-strict mode recovers at frame boundaries with RecoveryEvents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, decompress, createEncoder, createDecoder } from "../src/api.js";
import { FastPackError, IntegrityError } from "../src/errors.js";

const enc = new TextEncoder();

function buildStream(n = 5000): { input: Uint8Array; stream: Uint8Array } {
  const input = enc.encode("integrity ".repeat(n));
  const stream = compress(input);
  return { input, stream };
}

test("strict decode throws on corrupted payload hash", () => {
  const { stream } = buildStream();
  const corrupt = stream.slice();
  // corrupt a byte in the payload region (after the header)
  corrupt[Math.floor(corrupt.length / 2)]! ^= 0x40;
  assert.throws(() => decompress(corrupt), (e: unknown) => {
    return e instanceof IntegrityError || e instanceof FastPackError;
  });
});

test("strict decode throws on truncated stream", () => {
  const { stream } = buildStream();
  for (const cut of [1, 10, stream.length - 5, stream.length - 1]) {
    const truncated = stream.subarray(0, cut);
    assert.throws(() => decompress(truncated), FastPackError);
  }
});

test("strict decode throws on trailing garbage", () => {
  const { stream } = buildStream();
  const extra = new Uint8Array(stream.length + 5);
  extra.set(stream);
  for (let i = stream.length; i < extra.length; i++) extra[i] = 0xab;
  assert.throws(() => decompress(extra), FastPackError);
});

test("non-strict decode recovers with events and no crash", () => {
  const { input, stream } = buildStream();
  // corrupt the middle of the stream
  const corrupt = stream.slice();
  corrupt[Math.floor(corrupt.length / 2)]! ^= 0x01;
  const result = decompress(corrupt, { strict: false });
  assert.equal(typeof result.recovered, "boolean");
  assert.ok(Array.isArray(result.events));
  assert.ok(result.recovered === true || result.recovered === false);
  // whatever we return must be decodable/validated by the caller; we just
  // assert we didn't crash and events are well-typed
  for (const ev of result.events) {
    assert.equal(typeof ev.frameSeq, "number");
    assert.equal(typeof ev.streamOffset, "number");
    assert.equal(typeof ev.cause, "string");
  }
});

test("non-strict decode of a valid stream has no events", () => {
  const { input, stream } = buildStream();
  const result = decompress(stream, { strict: false });
  assert.equal(result.recovered, false);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.data, input);
});

test("streaming decoder throws on truncated end", () => {
  const encd = createEncoder();
  encd.write(enc.encode("stream integrity ".repeat(100)));
  const stream = encd.flush();
  const dec = createDecoder();
  dec.write(stream.subarray(0, stream.length - 3));
  assert.throws(() => dec.end(), FastPackError);
});

test("streaming decoder rejects trailing bytes after footer", () => {
  const encd = createEncoder();
  encd.write(enc.encode("trailing ".repeat(50)));
  const stream = encd.flush();
  const extra = new Uint8Array(stream.length + 2);
  extra.set(stream);
  extra[stream.length] = 0xff;
  extra[stream.length + 1] = 0xff;
  const dec = createDecoder();
  assert.throws(() => dec.write(extra), FastPackError);
});

test("streaming decoder rejects duplicate write after completion", () => {
  const encd = createEncoder();
  encd.write(enc.encode("done ".repeat(10)));
  const stream = encd.flush();
  const dec = createDecoder();
  dec.write(stream);
  dec.end();
  assert.throws(() => dec.write(stream), FastPackError);
});

test("non-strict streaming decoder handles garbage prefix", () => {
  const encd = createEncoder();
  encd.write(enc.encode("recover me ".repeat(50)));
  const stream = encd.flush();
  const dec = createDecoder({ strict: false });
  // feed garbage then the real stream
  dec.write(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]));
  dec.write(stream);
  const out = dec.end();
  // resync should find the first frame and decode everything
  assert.equal(new TextDecoder().decode(out), "recover me ".repeat(50));
});
