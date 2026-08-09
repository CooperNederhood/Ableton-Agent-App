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
});
