import { DEFAULT_MAX_FRAME_BYTES, FRAME_HEADER_BYTES } from "./constants.js";
import { messageEnvelopeSchema, type MessageEnvelope } from "./schemas.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export class FrameDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

export function encodeFrame(message: MessageEnvelope): Uint8Array {
  const parsed = messageEnvelopeSchema.parse(message);
  const payload = encoder.encode(JSON.stringify(parsed));
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = new Uint8Array(0);

  public constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  public push(chunk: Uint8Array): MessageEnvelope[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    combined.set(this.#buffer);
    combined.set(chunk, this.#buffer.byteLength);
    this.#buffer = combined;

    const messages: MessageEnvelope[] = [];
    let offset = 0;

    while (this.#buffer.byteLength - offset >= FRAME_HEADER_BYTES) {
      const length = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + offset,
        FRAME_HEADER_BYTES,
      ).getUint32(0, false);

      if (length === 0) {
        this.#buffer = new Uint8Array(0);
        throw new FrameDecodeError("Zero-length frames are not allowed");
      }
      if (length > this.#maxFrameBytes) {
        this.#buffer = new Uint8Array(0);
        throw new FrameDecodeError(
          `Frame length ${length} exceeds maximum ${this.#maxFrameBytes}`,
        );
      }
      if (this.#buffer.byteLength - offset < FRAME_HEADER_BYTES + length) {
        break;
      }

      const payloadStart = offset + FRAME_HEADER_BYTES;
      const payload = this.#buffer.subarray(
        payloadStart,
        payloadStart + length,
      );
      let json: unknown;
      try {
        json = JSON.parse(decoder.decode(payload));
      } catch (error) {
        this.#buffer = new Uint8Array(0);
        throw new FrameDecodeError(
          error instanceof Error
            ? `Invalid frame payload: ${error.message}`
            : "Invalid frame payload",
        );
      }

      const result = messageEnvelopeSchema.safeParse(json);
      if (!result.success) {
        this.#buffer = new Uint8Array(0);
        throw new FrameDecodeError(
          `Invalid message envelope: ${result.error.message}`,
        );
      }
      messages.push(result.data);
      offset = payloadStart + length;
    }

    this.#buffer = this.#buffer.slice(offset);
    return messages;
  }

  public reset(): void {
    this.#buffer = new Uint8Array(0);
  }

  public get bufferedBytes(): number {
    return this.#buffer.byteLength;
  }
}
