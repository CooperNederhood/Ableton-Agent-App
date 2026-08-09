import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type { AbletonService } from "@ableton-agent/application";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  capabilityDocumentSchema,
  encodeFrame,
  type MessageEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "@ableton-agent/protocol";
import type { ConnectionStatus, EventPublisher } from "@ableton-agent/shared";

export interface AbletonBridgeOptions {
  authenticationToken: string;
  events: EventPublisher;
  host?: string;
  port?: number;
  appVersion?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(response: ResponseEnvelope): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class AbletonBridgeService implements AbletonService {
  readonly #host: string;
  readonly #port: number;
  readonly #appVersion: string;
  readonly #requestTimeoutMs: number;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  #socket: Socket | undefined;
  #status: ConnectionStatus = { state: "disconnected" };

  public constructor(private readonly options: AbletonBridgeOptions) {
    if (options.authenticationToken.length < 32) {
      throw new Error(
        "Ableton bridge authentication token must be at least 32 characters",
      );
    }
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 8765;
    this.#appVersion = options.appVersion ?? "0.1.0";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  public async start(): Promise<void> {
    if (this.#socket) {
      return;
    }
    this.#setStatus({ state: "connecting" });

    try {
      await this.#connect();
      const result = await this.#request("system.hello", {
        authenticationToken: this.options.authenticationToken,
        supportedProtocolVersions: [PROTOCOL_VERSION],
        appVersion: this.#appVersion,
        eventSubscriptions: [],
      });
      const capabilities = capabilityDocumentSchema.parse(result);
      this.#setStatus({
        state: "connected",
        liveVersion: capabilities.liveVersion,
        remoteScriptVersion: capabilities.remoteScriptVersion,
        projectId: capabilities.projectId,
      });
    } catch (error) {
      this.#destroySocket();
      this.#setStatus({
        state: "error",
        code: "connection_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async stop(): Promise<void> {
    this.#destroySocket();
    this.#setStatus({ state: "disconnected" });
  }

  public async getStatus(): Promise<ConnectionStatus> {
    return this.#status;
  }

  public async ping(): Promise<unknown> {
    return this.#request("system.ping", {});
  }

  async #request(
    command: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      throw new Error("Ableton bridge is not connected");
    }
    const requestId = randomUUID();
    const request: RequestEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId,
      command,
      params: { ...params },
    };

    const response = new Promise<ResponseEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Ableton request timed out: ${command}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { resolve, reject, timeout });
    });
    socket.write(encodeFrame(request));
    const envelope = await response;
    if (!envelope.ok) {
      throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.result;
  }

  async #connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.#host, port: this.#port });
      this.#socket = socket;
      const onInitialError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onInitialError);
        this.#bindSocket(socket);
        resolve();
      };
      socket.once("error", onInitialError);
      socket.once("connect", onConnect);
    });
  }

  #bindSocket(socket: Socket): void {
    socket.on("data", (chunk) => {
      try {
        for (const message of this.#decoder.push(chunk)) {
          this.#handleMessage(message);
        }
      } catch (error) {
        this.#failConnection(error);
      }
    });
    socket.on("error", (error) => this.#failConnection(error));
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
        if (this.#status.state === "connected") {
          this.#setStatus({
            state: "error",
            code: "connection_closed",
            message: "Ableton bridge connection closed",
          });
        }
      }
    });
  }

  #handleMessage(message: MessageEnvelope): void {
    if (message.kind !== "response") {
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #failConnection(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#rejectPending(failure);
    this.#destroySocket();
    this.#setStatus({
      state: "error",
      code: "connection_error",
      message: failure.message,
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #destroySocket(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();
    this.#decoder.reset();
    this.#rejectPending(new Error("Ableton bridge stopped"));
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.options.events.publish({
      type: "ableton.connection_changed",
      status,
    });
  }
}
