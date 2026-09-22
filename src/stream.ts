/**
 * Streaming codec (spec §14), transport ACK state machine (§13), and the
 * LEARN/ANALYZE interface.
 *
 * The streaming encoder emits ONE frame per block (default 4 KiB of input
 * per frame) for low latency; frames carry monotonic sequence numbers and
 * the stream ends with a footer. The one-shot `compress` (container.ts)
 * instead emits window-sized frames. Both are deterministic and independent
 * of how the caller chunks the input.
 *
 * The decoder consumes bytes, assembles frames, verifies hashes/seq, and
 * emits decoded blocks. The transport layer here is an API-only state
 * machine (send/ack/timeout); the actual byte transport belongs to the
 * caller's channel.
 */

import { FORMAT, PAYLOAD_TYPE } from "./ids.js";
import { ByteReader } from "./reader.js";
import { FpHashState } from "./hash.js";
import {
  encodeFrame,
  encodeFooter,
  decodeFrame,
  decodeFrameBlocks,
  scanFrameHeader,
  scanFooter,
  encodeSingleBlockPayload,
} from "./container.js";
import {
  FormatError,
  IntegrityError,
  ResourceError,
  FastPackError,
  CODES,
} from "./errors.js";
import { FastPackOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Streaming encoder
// ---------------------------------------------------------------------------

export interface EncoderWriteResult {
  /** bytes accepted from this chunk */
  accepted: number;
  /** input bytes still buffered, not yet emitted */
  bufferedBytes: number;
}

export class Encoder {
  private readonly opts: FastPackOptions;
  private readonly blockSize: number;
  private input: Uint8Array;
  private inputLen = 0;
  private seq = 0;
  private totalHash = new FpHashState();
  private totalPayloadLen = 0;
  private emitted: Uint8Array[] = [];
  private finished = false;

  /** Optional push callback; when set, completed frames are delivered here. */
  onData: ((bytes: Uint8Array) => void) | null = null;

  constructor(opts: FastPackOptions) {
    this.opts = opts;
    this.blockSize = Math.min(opts.blockAlignment, opts.windowSize);
    this.input = new Uint8Array(this.blockSize);
  }

  /** Number of input bytes currently buffered. */
  get bufferedBytes(): number {
    return this.inputLen;
  }

  /** Feed a chunk. Emits a complete frame per full block of input. */
  write(chunk: Uint8Array): EncoderWriteResult {
    if (this.finished) {
      throw new ResourceError(CODES.RESOURCE_BUFFER, "encoder already flushed");
    }
    const accepted = chunk.length;
    this.append(chunk);
    this.drain();
    return { accepted, bufferedBytes: this.inputLen };
  }

  /** Encode the tail block, emit the final frame and footer. */
  flush(): Uint8Array {
    if (this.finished) {
      throw new ResourceError(CODES.RESOURCE_BUFFER, "encoder already flushed");
    }
    this.finished = true;
    // Final frame carries any remaining bytes (possibly an empty payload).
    const tail = this.input.subarray(0, this.inputLen);
    this.emitFrame(tail, true);
    this.inputLen = 0;

    const footer = encodeFooter(this.totalPayloadLen, this.totalHash.digest(), this.seq);
    this.pushOut(footer);
    return this.bytes();
  }

  private append(chunk: Uint8Array): void {
    if (this.inputLen + chunk.length > this.input.length) {
      let cap = this.input.length * 2;
      while (cap < this.inputLen + chunk.length) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.input.subarray(0, this.inputLen));
      this.input = next;
    }
    this.input.set(chunk, this.inputLen);
    this.inputLen += chunk.length;
  }

  private drain(): void {
    while (this.inputLen >= this.blockSize) {
      const block = this.input.subarray(0, this.blockSize);
      this.emitFrame(block, false);
      // shift remaining input left
      this.input.copyWithin(0, this.blockSize, this.inputLen);
      this.inputLen -= this.blockSize;
    }
  }

  private emitFrame(block: Uint8Array, streamEnd: boolean): Uint8Array {
    const { windowSize } = this.opts;
    if (block.length > windowSize) {
      throw new ResourceError(CODES.RESOURCE_LENGTH, "block larger than window");
    }
    this.seq += 1;
    const payload = this.encodeBlockPayload(block);
    this.totalHash.update(payload);
    this.totalPayloadLen += payload.length;
    const frame = encodeFrame(true, this.seq, streamEnd, PAYLOAD_TYPE.FASTPACK_BLOCKS, windowSize, payload);
    this.pushOut(frame);
    return frame;
  }

  private encodeBlockPayload(block: Uint8Array): Uint8Array {
    // Streaming: one frame per block => each frame's matcher is fresh.
    return encodeSingleBlockPayload(block, this.opts);
  }

  private pushOut(bytes: Uint8Array): void {
    if (this.onData) {
      this.onData(bytes);
    } else {
      this.emitted.push(bytes);
    }
  }

  private bytes(): Uint8Array {
    let total = 0;
    for (const c of this.emitted) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of this.emitted) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Streaming decoder
// ---------------------------------------------------------------------------

export class Decoder {
  private readonly strict: boolean;
  private buffer: Uint8Array;
  private bufferLen = 0;
  private totalHash = new FpHashState();
  private totalLen = 0;
  private hasSeqMode: boolean | null = null;
  private highestContiguous = 0;
  private sawStreamEnd = false;
  private footerDone = false;
  /** offset in `buffer` where the footer begins (after streamEnd frame) */
  private footerPos = -1;
  private emitted: Uint8Array[] = [];

  /** Optional push callback for decoded blocks. */
  onBlock: ((data: Uint8Array) => void) | null = null;

  constructor(opts: FastPackOptions) {
    this.strict = opts.strict;
    this.buffer = new Uint8Array(1024);
  }

  /** Number of buffered (not yet parsed) bytes. */
  get bufferedBytes(): number {
    return this.bufferLen;
  }

  /** True once the streamEnd frame + footer have been verified. */
  get isComplete(): boolean {
    return this.footerDone;
  }

  /** Feed raw stream bytes. Parses complete frames as they arrive. */
  write(bytes: Uint8Array): void {
    if (this.footerDone) {
      throw new FormatError(CODES.FORMAT_TRAILING, "decoder already completed");
    }
    this.append(bytes);
    if (this.footerPos >= 0) {
      this.tryVerifyFooter();
      if (this.footerDone) return;
    }
    this.parseLoop();
    if (this.footerPos >= 0) {
      this.tryVerifyFooter();
    }
  }

  /**
   * Signal end of input. Verifies that a streamEnd frame and footer were seen
   * and that totalLen/totalHash match. Returns all decoded bytes so far.
   */
  end(): Uint8Array {
    if (!this.footerDone) {
      if (this.sawStreamEnd) {
        throw new FormatError(CODES.FORMAT_END, "missing footer after streamEnd frame");
      }
      throw new FormatError(CODES.FORMAT_END, "stream did not end with a streamEnd frame");
    }
    return this.bytes();
  }

  private append(bytes: Uint8Array): void {
    if (this.bufferLen + bytes.length > this.buffer.length) {
      let cap = this.buffer.length * 2;
      while (cap < this.bufferLen + bytes.length) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buffer.subarray(0, this.bufferLen));
      this.buffer = next;
    }
    this.buffer.set(bytes, this.bufferLen);
    this.bufferLen += bytes.length;
  }

  private parseLoop(): void {
    if (this.footerPos >= 0) return; // footer located: stop frame scanning
    let pos = 0;
    while (!this.footerDone && pos < this.bufferLen) {
      const reader = new ByteReader(this.buffer, this.bufferLen);
      reader.seek(pos);
      let h;
      try {
        h = scanFrameHeader(reader);
      } catch (e) {
        if (this.strict || !(e instanceof FastPackError)) throw e;
        pos = this.resync(pos + 1);
        if (pos < 0) {
          this.bufferLen = 0;
          return;
        }
        continue;
      }
      if (h === null) break; // need more bytes
      if (pos + h.frameLen > this.bufferLen) break; // need more bytes

      const frameReader = new ByteReader(this.buffer, this.bufferLen);
      frameReader.seek(pos);
      let frame;
      try {
        frame = decodeFrame(frameReader);
      } catch (e) {
        if (this.strict || !(e instanceof FastPackError)) throw e;
        // non-strict: skip this frame, resync to next magic
        pos = this.resync(pos + 1);
        if (pos < 0) {
          this.bufferLen = 0;
          return;
        }
        continue;
      }
      pos += h.frameLen;
      this.handleFrame(frame, pos);
      if (this.footerPos >= 0) break; // footer begins here; stop frame parsing
    }
    // compact consumed prefix
    if (pos > 0) {
      this.buffer.copyWithin(0, pos, this.bufferLen);
      this.bufferLen -= pos;
      if (this.footerPos >= 0) this.footerPos -= pos;
    }
  }

  private resync(from: number): number {
    const magic = FORMAT.MAGIC;
    const data = this.buffer;
    for (let i = from; i + 3 < this.bufferLen; i++) {
      if (data[i] === magic[0] && data[i + 1] === magic[1] && data[i + 2] === magic[2] && data[i + 3] === magic[3]) {
        return i;
      }
    }
    return -1;
  }

  private handleFrame(frame: ReturnType<typeof decodeFrame>, endPos: number): void {
    if (this.hasSeqMode === null) this.hasSeqMode = frame.hasSeq;
    else if (this.hasSeqMode !== frame.hasSeq) {
      throw new FormatError(CODES.FORMAT_SEQ, "mixed hasSeq/seq-less frames", frame.startPos);
    }

    let deliver = true;
    if (frame.hasSeq) {
      if (frame.seq <= this.highestContiguous) {
        deliver = false; // duplicate (idempotent retransmission)
      } else if (frame.seq !== this.highestContiguous + 1) {
        throw new FormatError(CODES.FORMAT_SEQ, `seq gap: expected ${this.highestContiguous + 1}, got ${frame.seq}`, frame.startPos);
      } else {
        this.highestContiguous = frame.seq;
      }
    }

    if (deliver) {
      this.totalLen += frame.payload.length;
      this.totalHash.update(frame.payload);
      if (frame.payloadType === PAYLOAD_TYPE.RAW_PASSTHROUGH) {
        this.emitBlock(frame.payload);
      } else {
        const blocks = decodeFrameBlocks(frame.payload, frame.windowSize);
        for (const b of blocks) this.emitBlock(b);
      }
    }

    if (frame.streamEnd) {
      this.sawStreamEnd = true;
      // Footer follows immediately after this frame in the buffer.
      this.footerPos = endPos;
      // Do NOT compact the buffer past endPos; the footer must stay.
    }
  }

  /** Attempt to parse and verify the footer at footerPos. */
  private tryVerifyFooter(): void {
    const freader = new ByteReader(this.buffer, this.bufferLen);
    freader.seek(this.footerPos);
    const footer = scanFooter(freader);
    if (footer === null) return; // need more bytes
    const { totalLen, totalHash, endSeq, len } = footer;
    if (this.footerPos + len !== this.bufferLen) {
      throw new FormatError(CODES.FORMAT_TRAILING, `${this.bufferLen - (this.footerPos + len)} trailing bytes after footer`);
    }
    if (totalLen !== this.totalLen) {
      throw new IntegrityError(CODES.INTEGRITY_TOTAL, `totalLen mismatch: footer ${totalLen}, decoded ${this.totalLen}`);
    }
    if (!this.hashesEqual(totalHash, this.totalHash.digest())) {
      throw new IntegrityError(CODES.INTEGRITY_TOTAL, "totalHash mismatch");
    }
    if (this.hasSeqMode) {
      if (endSeq !== this.highestContiguous) {
        throw new FormatError(CODES.FORMAT_SEQ, `endSeq ${endSeq} != last frame seq ${this.highestContiguous}`);
      }
    } else if (endSeq !== 0) {
      throw new FormatError(CODES.FORMAT_SEQ, `endSeq ${endSeq} on seq-less stream`);
    }
    this.footerDone = true;
    this.footerPos = -1;
    // clear buffered bytes
    this.bufferLen = 0;
  }

  private hashesEqual(a: { hi: number; lo: number }, b: { hi: number; lo: number }): boolean {
    return a.hi === b.hi && a.lo === b.lo;
  }

  private emitBlock(data: Uint8Array): void {
    if (this.onBlock) {
      this.onBlock(data);
    } else {
      this.emitted.push(data);
    }
  }

  private bytes(): Uint8Array {
    let total = 0;
    for (const c of this.emitted) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of this.emitted) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Transport ACK state machine (spec §13, API only)
// ---------------------------------------------------------------------------

export type TransportState = "SEND_READY" | "SENT" | "ACKED" | "TIMED_OUT" | "FAILED";

export interface TransportFrameRecord {
  seq: number;
  frame: Uint8Array;
  state: TransportState;
  /** bytes the frame's payload decodes to (for caller bookkeeping) */
  decodedLen: number;
}

/**
 * Reliable-delivery state machine. Retransmission policy and the physical
 * transport belong to the caller; FastPack tracks seq/ack/timeout state and
 * re-emits buffered frames with the same seq on demand.
 */
export class Transport {
  private readonly reorderWindow: number;
  private records: Map<number, TransportFrameRecord> = new Map();
  private nextSeq = 1;
  /** highest seq the receiver has confirmed contiguous */
  private ackedHigh = 0;

  constructor(reorderWindow: number = 0) {
    this.reorderWindow = reorderWindow;
  }

  /** Register a frame for reliable delivery; assigns the next seq. */
  sendFrame(frame: Uint8Array, decodedLen: number): number {
    const seq = this.nextSeq++;
    this.records.set(seq, { seq, frame, state: "SEND_READY", decodedLen });
    return seq;
  }

  /** Mark a frame as in flight. */
  markSent(seq: number): void {
    const r = this.records.get(seq);
    if (!r) throw new FormatError(CODES.FORMAT_SEQ, `unknown seq ${seq}`, 0);
    r.state = "SENT";
  }

  /** Receiver confirms delivery of `seq`. */
  onAck(seq: number): void {
    const r = this.records.get(seq);
    if (!r) return; // already evicted or unknown
    r.state = "ACKED";
    // advance contiguous ack window while the next frame is acked
    while (this.records.get(this.ackedHigh + 1)?.state === "ACKED") {
      this.ackedHigh += 1;
    }
    this.evictAcked();
  }

  /** Caller timeout; re-emit the frame with the SAME seq. */
  onTimeout(seq: number): Uint8Array {
    const r = this.records.get(seq);
    if (!r) throw new FormatError(CODES.FORMAT_SEQ, `unknown seq ${seq}`, 0);
    r.state = "TIMED_OUT";
    return r.frame;
  }

  /** Re-arm a timed-out frame for another attempt. */
  retry(seq: number): void {
    const r = this.records.get(seq);
    if (!r) throw new FormatError(CODES.FORMAT_SEQ, `unknown seq ${seq}`, 0);
    r.state = "SEND_READY";
  }

  /** Frames that have not been acked yet (in-flight or unconfirmed). */
  outstanding(): TransportFrameRecord[] {
    const out: TransportFrameRecord[] = [];
    for (const r of this.records.values()) {
      if (r.state !== "ACKED") out.push(r);
    }
    return out;
  }

  private evictAcked(): void {
    // evict only the contiguous acked prefix (up to ackedHigh)
    const toRemove: number[] = [];
    for (let s = 1; s <= this.ackedHigh; s++) {
      const r = this.records.get(s);
      if (r && r.state === "ACKED") toRemove.push(s);
    }
    for (const s of toRemove) this.records.delete(s);
  }

  /** Highest contiguous acked seq. */
  get ackHigh(): number {
    return this.ackedHigh;
  }
}

// ---------------------------------------------------------------------------
// LEARN / ANALYZE (spec §22.3 note; separate from FAST RUNTIME)
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  size: number;
  /** per-byte entropy estimate (0..8) from a 256-bucket frequency count */
  entropy: number;
  /** fraction of bytes in runs of length >= 4 (0..1) */
  runFraction: number;
  /** delta-coded byte entropy (0..8); low value suggests the delta transform */
  deltaEntropy: number;
  /** suggested transform IDs, sorted by estimated gain */
  suggestedTransforms: number[];
}

/**
 * Analyze input to build precomputed knowledge for the runtime. This is the
 * LEARN path: it never encodes; it returns stats a caller can use to pick
 * options (e.g., enabling transforms). Reusing this knowledge at encode time
 * is the caller's choice, keeping LEARN separate from the fast runtime path.
 */
export function analyze(input: Uint8Array): AnalysisResult {
  const n = input.length;
  const freq = new Uint32Array(256);
  let runBytes = 0;
  if (n > 0) {
    let prev = input[0]!;    let len = 1;
    for (let i = 1; i <= n; i++) {
      const b = i < n ? input[i]! : -1;
      if (b === prev) {
        len++;
      } else {
        if (len >= 4) {
          runBytes += len;
        }
        prev = b;
        len = 1;
      }
    }
  }
  for (let i = 0; i < n; i++) freq[input[i]!]!++;

  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const fi = freq[i]!;
    if (fi === 0) continue;
    const p = fi / n;
    entropy -= p * Math.log2(p);
  }

  // delta-coded entropy
  const dfreq = new Uint32Array(256);
  if (n > 0) {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const cur = input[i]!;
      const d = (cur - prev) & 0xff;
      prev = cur;
      dfreq[d]!++;
    }
  }
  let deltaEntropy = 0;
  for (let i = 0; i < 256; i++) {
    const di = dfreq[i]!;
    if (di === 0) continue;
    const p = di / n;
    deltaEntropy -= p * Math.log2(p);
  }

  const runFraction = n > 0 ? runBytes / n : 0;
  const suggestedTransforms: number[] = [];
  if (deltaEntropy < entropy - 0.5) suggestedTransforms.push(1);
  if (runFraction > 0.3) suggestedTransforms.push(2);

  return { size: n, entropy, runFraction, deltaEntropy, suggestedTransforms };
}
