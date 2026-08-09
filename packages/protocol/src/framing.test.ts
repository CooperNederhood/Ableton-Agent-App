import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodeFrame, FrameDecodeError, FrameDecoder } from "./framing.js";
import { PROTOCOL_VERSION } from "./constants.js";
import type { RequestEnvelope } from "./schemas.js";

function request(): RequestEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "request",
    requestId: randomUUID(),
    command: "system.ping",
    params: {},
  };
}

describe("frame codec", () => {
  it("round trips a complete frame", () => {
    const message = request();
    expect(new FrameDecoder().push(encodeFrame(message))).toEqual([message]);
  });

  it("buffers fragmented frames", () => {
    const message = request();
    const frame = encodeFrame(message);
    const decoder = new FrameDecoder();

    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 9))).toEqual([]);
    expect(decoder.push(frame.subarray(9))).toEqual([message]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("round trips deterministic random fragmentation and concatenation", () => {
    const messages = Array.from({ length: 25 }, request);
    const frames = messages.map(encodeFrame);
    const totalLength = frames.reduce(
      (total, frame) => total + frame.length,
      0,
    );
    const combined = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const frame of frames) {
      combined.set(frame, writeOffset);
      writeOffset += frame.length;
    }

    let seed = 0x5eed1234;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const decoder = new FrameDecoder();
    const decoded: RequestEnvelope[] = [];
    for (let offset = 0; offset < combined.length;) {
      const size = Math.min(
        combined.length - offset,
        1 + Math.floor(random() * 37),
      );
      decoded.push(
        ...(decoder.push(
          combined.subarray(offset, offset + size),
        ) as RequestEnvelope[]),
      );
      offset += size;
    }
    decoder.finish();

    expect(decoded).toEqual(messages);
  });

  it("decodes concatenated frames", () => {
    const first = request();
    const second = request();
    const firstFrame = encodeFrame(first);
    const secondFrame = encodeFrame(second);
    const combined = new Uint8Array(firstFrame.length + secondFrame.length);
    combined.set(firstFrame);
    combined.set(secondFrame, firstFrame.length);

    expect(new FrameDecoder().push(combined)).toEqual([first, second]);
  });

  it("rejects zero-length frames", () => {
    expect(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 0]))).toThrow(
      FrameDecodeError,
    );
  });

  it("rejects oversized frames before buffering the payload", () => {
    expect(() =>
      new FrameDecoder(16).push(new Uint8Array([0, 0, 0, 17])),
    ).toThrow(/exceeds maximum/);
  });

  it("rejects invalid JSON", () => {
    const frame = new Uint8Array([0, 0, 0, 1, 123]);
    expect(() => new FrameDecoder().push(frame)).toThrow(
      /Invalid frame payload/,
    );
  });

  it("rejects invalid UTF-8", () => {
    const frame = new Uint8Array([0, 0, 0, 2, 0xc3, 0x28]);
    expect(() => new FrameDecoder().push(frame)).toThrow(
      /Invalid frame payload/,
    );
  });

  it("rejects a truncated frame when the stream finishes", () => {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame(request()).subarray(0, 8));
    expect(() => decoder.finish()).toThrow(/truncated frame/);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("fuzzes bounded random decoder input without unbounded buffering", () => {
    let seed = 0xc0ffee;
    const randomByte = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed & 0xff;
    };

    for (let sample = 0; sample < 250; sample += 1) {
      const decoder = new FrameDecoder(256);
      const bytes = Uint8Array.from({ length: sample % 65 }, () =>
        randomByte(),
      );
      try {
        decoder.push(bytes);
        expect(decoder.bufferedBytes).toBeLessThanOrEqual(260);
      } catch (error) {
        expect(error).toBeInstanceOf(FrameDecodeError);
      }
    }
  });
});
