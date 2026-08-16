import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import type {
  OutputConnection,
  OutputProducer,
  SignalEnvelope,
} from "./contracts.js";
import { DiscoveryDescriptorLifecycle } from "./discovery-descriptor.js";
import {
  DEFAULT_MAX_INGRESS_FRAME_BYTES,
  DEFAULT_SIGNAL_INGRESS_HOST,
  DEFAULT_SIGNAL_INGRESS_PORT,
  type IngressErrorCode,
  PRODUCER_PROTOCOL_VERSION,
  type ProducerAcknowledgement,
  type ProducerErrorResponse,
  producerMessageSchema,
  type SignalIngressDiscoveryDescriptor,
} from "./ingress-contracts.js";
import type { RouteResult } from "./router.js";

export interface SignalIngressRegistry {
  register(connectionId: string, producer: OutputProducer): OutputConnection;
  heartbeat(connectionId: string): OutputConnection | undefined;
  disconnect(connectionId: string): OutputConnection | undefined;
}

export interface SignalIngressRouter {
  route(input: unknown): RouteResult;
}

export type SignalIngressStatus =
  | {
      readonly kind: "listening";
      readonly host: string;
      readonly port: number;
    }
  | {
      readonly kind: "producer-connected" | "producer-disconnected";
      readonly connectionId: string;
      readonly producerId: string;
      readonly instanceId: string;
    }
  | { readonly kind: "stopped" };

export interface SignalIngressDiagnostic {
  readonly code: IngressErrorCode | "socket-error" | "server-error";
  readonly message: string;
  readonly connectionId?: string;
}

export interface SignalIngressServerOptions {
  readonly secret: string;
  readonly registry: SignalIngressRegistry;
  readonly router: SignalIngressRouter;
  readonly host?: string;
  readonly port?: number;
  readonly maxFrameBytes?: number;
  readonly maxOutstandingMessages?: number;
  readonly idleTimeoutMs?: number;
  readonly idleCheckIntervalMs?: number;
  readonly descriptorPath?: string;
  readonly onStatus?: (status: SignalIngressStatus) => void;
  readonly onDiagnostic?: (diagnostic: SignalIngressDiagnostic) => void;
  readonly now?: () => number;
}

export interface SignalIngressEndpoint {
  readonly host: string;
  readonly port: number;
}

interface ClientState {
  readonly socket: Socket;
  buffer: Buffer;
  readonly queue: string[];
  pumping: boolean;
  closing: boolean;
  connectionId: string | undefined;
  producer: OutputProducer | undefined;
  lastHeartbeatAt: number;
  lastSequence: number;
}

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;
const MAX_DIAGNOSTICS_PER_WINDOW = 20;
const DIAGNOSTIC_WINDOW_MS = 1000;

export class SignalIngressServer {
  readonly #options: Required<
    Pick<
      SignalIngressServerOptions,
      | "host"
      | "port"
      | "maxFrameBytes"
      | "maxOutstandingMessages"
      | "idleTimeoutMs"
      | "idleCheckIntervalMs"
    >
  > &
    SignalIngressServerOptions;
  readonly #server: Server;
  readonly #clients = new Set<ClientState>();
  readonly #liveInstances = new Map<string, ClientState>();
  readonly #now: () => number;
  readonly #secretBytes: Buffer;
  readonly #descriptor: DiscoveryDescriptorLifecycle | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #startPromise: Promise<SignalIngressEndpoint> | undefined;
  #stopPromise: Promise<void> | undefined;
  #diagnosticWindowStartedAt = 0;
  #diagnosticsInWindow = 0;
  #started = false;

  constructor(options: SignalIngressServerOptions) {
    if (options.secret.length < 32) {
      throw new RangeError(
        "Signal ingress secret must be at least 32 characters",
      );
    }
    const maxFrameBytes =
      options.maxFrameBytes ?? DEFAULT_MAX_INGRESS_FRAME_BYTES;
    const maxOutstandingMessages = options.maxOutstandingMessages ?? 32;
    const idleTimeoutMs = options.idleTimeoutMs ?? 15_000;
    const idleCheckIntervalMs =
      options.idleCheckIntervalMs ?? Math.min(1000, idleTimeoutMs);
    for (const [name, value] of [
      ["maxFrameBytes", maxFrameBytes],
      ["maxOutstandingMessages", maxOutstandingMessages],
      ["idleTimeoutMs", idleTimeoutMs],
      ["idleCheckIntervalMs", idleCheckIntervalMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
    const port = options.port ?? DEFAULT_SIGNAL_INGRESS_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new RangeError("port must be an integer between 0 and 65535");
    }
    this.#options = {
      ...options,
      host: options.host ?? DEFAULT_SIGNAL_INGRESS_HOST,
      port,
      maxFrameBytes,
      maxOutstandingMessages,
      idleTimeoutMs,
      idleCheckIntervalMs,
    };
    this.#now = options.now ?? Date.now;
    this.#secretBytes = Buffer.from(options.secret);
    this.#descriptor =
      options.descriptorPath === undefined
        ? undefined
        : new DiscoveryDescriptorLifecycle(options.descriptorPath);
    this.#server = createServer((socket) => this.#accept(socket));
    this.#server.on("error", (error) => {
      this.#diagnostic("server-error", error.message);
    });
  }

  start(): Promise<SignalIngressEndpoint> {
    if (this.#stopPromise !== undefined) {
      return Promise.reject(
        new Error("Signal ingress server has been stopped"),
      );
    }
    this.#startPromise ??= this.#listen();
    return this.#startPromise;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #listen(): Promise<SignalIngressEndpoint> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#options.port, this.#options.host);
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      await this.#closeServer();
      throw new Error("Signal ingress server did not expose a TCP address");
    }
    const endpoint = { host: this.#options.host, port: address.port };
    const descriptor: SignalIngressDiscoveryDescriptor = {
      ...endpoint,
      protocol: "newline-delimited-json",
      protocolVersion: PRODUCER_PROTOCOL_VERSION,
      maxFrameBytes: this.#options.maxFrameBytes,
    };
    try {
      await this.#descriptor?.write(descriptor);
    } catch (error) {
      await this.#closeServer();
      throw error;
    }
    this.#started = true;
    this.#idleTimer = setInterval(
      () => this.#checkIdleClients(),
      this.#options.idleCheckIntervalMs,
    );
    this.#idleTimer.unref();
    this.#options.onStatus?.({ kind: "listening", ...endpoint });
    return endpoint;
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true);
    const state: ClientState = {
      socket,
      buffer: Buffer.alloc(0),
      queue: [],
      pumping: false,
      closing: false,
      connectionId: undefined,
      producer: undefined,
      lastHeartbeatAt: this.#now(),
      lastSequence: -1,
    };
    this.#clients.add(state);
    socket.on("data", (chunk) => this.#receive(state, chunk));
    socket.on("error", (error) => {
      this.#diagnostic("socket-error", error.message, state.connectionId);
    });
    socket.on("close", () => this.#cleanupClient(state));
  }

  #receive(state: ClientState, chunk: Buffer): void {
    if (state.closing) {
      return;
    }
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (true) {
      const newline = state.buffer.indexOf(0x0a);
      if (newline === -1) {
        if (state.buffer.byteLength > this.#options.maxFrameBytes) {
          void this.#fail(
            state,
            "frame-too-large",
            `Frame exceeds ${this.#options.maxFrameBytes} bytes`,
            true,
          );
        }
        break;
      }
      if (newline > this.#options.maxFrameBytes) {
        void this.#fail(
          state,
          "frame-too-large",
          `Frame exceeds ${this.#options.maxFrameBytes} bytes`,
          true,
        );
        return;
      }
      const line = state.buffer.subarray(0, newline).toString("utf8");
      state.buffer = state.buffer.subarray(newline + 1);
      if (state.queue.length >= this.#options.maxOutstandingMessages) {
        void this.#fail(
          state,
          "backpressure",
          "Too many outstanding producer messages",
          true,
        );
        return;
      }
      state.queue.push(line);
    }
    this.#pump(state);
  }

  #pump(state: ClientState): void {
    if (state.pumping || state.closing) {
      return;
    }
    state.pumping = true;
    socketPause(state.socket);
    void (async () => {
      try {
        while (!state.closing) {
          const line = state.queue.shift();
          if (line === undefined) {
            break;
          }
          await this.#handleLine(state, line);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown ingress error";
        await this.#fail(state, "internal-error", message, true);
      } finally {
        state.pumping = false;
        if (!state.closing) {
          state.socket.resume();
          if (state.queue.length > 0) {
            this.#pump(state);
          }
        }
      }
    })();
  }

  async #handleLine(state: ClientState, line: string): Promise<void> {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      await this.#fail(state, "malformed-json", "Malformed JSON", true);
      return;
    }
    const requestId = extractRequestId(input);
    const version = extractProtocolVersion(input);
    if (version !== undefined && version !== PRODUCER_PROTOCOL_VERSION) {
      await this.#fail(
        state,
        "unsupported-version",
        `Unsupported producer protocol version ${describeValue(version)}`,
        true,
        requestId,
      );
      return;
    }
    const parsed = producerMessageSchema.safeParse(input);
    if (!parsed.success) {
      await this.#fail(
        state,
        "invalid-message",
        parsed.error.issues[0]?.message ?? "Invalid producer message",
        true,
        requestId,
      );
      return;
    }
    const message = parsed.data;
    if (message.type === "producer.hello") {
      await this.#hello(state, message);
      return;
    }
    if (state.connectionId === undefined || state.producer === undefined) {
      await this.#fail(
        state,
        "authentication-required",
        "producer.hello is required before other messages",
        true,
        message.requestId,
      );
      return;
    }
    switch (message.type) {
      case "producer.heartbeat":
        state.lastHeartbeatAt = this.#now();
        this.#options.registry.heartbeat(state.connectionId);
        await this.#ack(state, message.requestId, "heartbeat");
        break;
      case "signal.frame":
        if (message.sequence <= state.lastSequence) {
          await this.#fail(
            state,
            "sequence-replay",
            `Sequence ${message.sequence} does not exceed ${state.lastSequence}`,
            false,
            message.requestId,
          );
          return;
        }
        await this.#route(state, message);
        break;
      case "producer.disconnect":
        await this.#ack(state, message.requestId, "disconnect");
        state.closing = true;
        state.socket.end();
        break;
    }
  }

  async #hello(
    state: ClientState,
    message: Extract<
      ReturnType<typeof producerMessageSchema.parse>,
      { type: "producer.hello" }
    >,
  ): Promise<void> {
    if (state.connectionId !== undefined) {
      await this.#fail(
        state,
        "already-authenticated",
        "This socket is already authenticated",
        true,
        message.requestId,
      );
      return;
    }
    if (!this.#matchesSecret(message.secret)) {
      await this.#fail(
        state,
        "authentication-failed",
        "Producer authentication failed",
        true,
        message.requestId,
      );
      return;
    }
    const live = this.#liveInstances.get(message.producer.instanceId);
    if (live !== undefined && !live.closing) {
      await this.#fail(
        state,
        "duplicate-instance",
        `Producer instance ${message.producer.instanceId} is already connected`,
        true,
        message.requestId,
      );
      return;
    }
    const connectionId = randomUUID();
    state.connectionId = connectionId;
    state.producer = message.producer;
    state.lastHeartbeatAt = this.#now();
    this.#liveInstances.set(message.producer.instanceId, state);
    try {
      this.#options.registry.register(connectionId, message.producer);
    } catch (error) {
      this.#liveInstances.delete(message.producer.instanceId);
      state.connectionId = undefined;
      state.producer = undefined;
      throw error;
    }
    this.#options.onStatus?.({
      kind: "producer-connected",
      connectionId,
      producerId: message.producer.producerId,
      instanceId: message.producer.instanceId,
    });
    await this.#ack(state, message.requestId, "hello", connectionId);
  }

  async #route(
    state: ClientState,
    message: Extract<
      ReturnType<typeof producerMessageSchema.parse>,
      { type: "signal.frame" }
    >,
  ): Promise<void> {
    const envelope: SignalEnvelope = {
      protocolVersion: 1,
      connectionId: state.connectionId as string,
      sequence: message.sequence,
      capturedAt: message.capturedAt,
      payload: message.payload,
    };
    const result = this.#options.router.route(envelope);
    if (!result.accepted) {
      const decision =
        result.decisions.find((candidate) => !candidate.accepted) ??
        result.deliveries.find(({ decision }) => !decision.accepted)?.decision;
      await this.#fail(
        state,
        decision?.accepted === false && decision.code === "sequence-replay"
          ? "sequence-replay"
          : "route-rejected",
        decision?.reason ?? "Signal route rejected",
        false,
        message.requestId,
      );
      return;
    }
    state.lastSequence = message.sequence;
    await this.#ack(state, message.requestId, "signal");
  }

  async #ack(
    state: ClientState,
    requestId: string,
    action: ProducerAcknowledgement["action"],
    connectionId?: string,
  ): Promise<void> {
    const response: ProducerAcknowledgement = {
      type: "producer.ack",
      protocolVersion: PRODUCER_PROTOCOL_VERSION,
      requestId,
      action,
      ...(connectionId === undefined ? {} : { connectionId }),
    };
    await this.#write(state, response);
  }

  async #fail(
    state: ClientState,
    code: IngressErrorCode,
    message: string,
    fatal: boolean,
    requestId?: string,
  ): Promise<void> {
    this.#diagnostic(code, message, state.connectionId);
    const response: ProducerErrorResponse = {
      type: "producer.error",
      protocolVersion: PRODUCER_PROTOCOL_VERSION,
      ...(requestId === undefined ? {} : { requestId }),
      code,
      message: boundedMessage(message),
      fatal,
    };
    try {
      await this.#write(state, response);
    } catch (error) {
      this.#diagnostic(
        "socket-error",
        error instanceof Error
          ? error.message
          : "Failed to write error response",
        state.connectionId,
      );
      state.socket.destroy();
    } finally {
      if (fatal) {
        state.closing = true;
        if (!state.socket.destroyed) {
          state.socket.end();
        }
      }
    }
  }

  async #write(state: ClientState, value: object): Promise<void> {
    if (state.socket.destroyed) {
      return;
    }
    const writable = state.socket.write(`${JSON.stringify(value)}\n`);
    if (!writable) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const cleanup = (): void => {
          state.socket.off("drain", onDrain);
          state.socket.off("close", onClose);
          state.socket.off("error", onError);
        };
        state.socket.once("drain", onDrain);
        state.socket.once("close", onClose);
        state.socket.once("error", onError);
      });
    }
  }

  #matchesSecret(candidate: string): boolean {
    const candidateBytes = Buffer.from(candidate);
    return (
      candidateBytes.byteLength === this.#secretBytes.byteLength &&
      timingSafeEqual(candidateBytes, this.#secretBytes)
    );
  }

  #checkIdleClients(): void {
    const now = this.#now();
    for (const state of this.#clients) {
      if (
        state.connectionId !== undefined &&
        !state.closing &&
        now - state.lastHeartbeatAt >= this.#options.idleTimeoutMs
      ) {
        void this.#fail(
          state,
          "idle-timeout",
          "Producer heartbeat timed out",
          true,
        );
      }
    }
  }

  #cleanupClient(state: ClientState): void {
    if (!this.#clients.delete(state)) {
      return;
    }
    const { connectionId, producer } = state;
    if (
      producer !== undefined &&
      this.#liveInstances.get(producer.instanceId) === state
    ) {
      this.#liveInstances.delete(producer.instanceId);
    }
    if (connectionId !== undefined) {
      this.#options.registry.disconnect(connectionId);
    }
    if (connectionId !== undefined && producer !== undefined) {
      this.#options.onStatus?.({
        kind: "producer-disconnected",
        connectionId,
        producerId: producer.producerId,
        instanceId: producer.instanceId,
      });
    }
  }

  #diagnostic(
    code: SignalIngressDiagnostic["code"],
    message: string,
    connectionId?: string,
  ): void {
    const now = this.#now();
    if (now - this.#diagnosticWindowStartedAt >= DIAGNOSTIC_WINDOW_MS) {
      this.#diagnosticWindowStartedAt = now;
      this.#diagnosticsInWindow = 0;
    }
    if (this.#diagnosticsInWindow >= MAX_DIAGNOSTICS_PER_WINDOW) {
      return;
    }
    this.#diagnosticsInWindow += 1;
    this.#options.onDiagnostic?.({
      code,
      message: boundedMessage(message),
      ...(connectionId === undefined ? {} : { connectionId }),
    });
  }

  async #stop(): Promise<void> {
    if (this.#idleTimer !== undefined) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    for (const state of this.#clients) {
      state.closing = true;
      if (!state.socket.destroyed) {
        const response: ProducerErrorResponse = {
          type: "producer.error",
          protocolVersion: PRODUCER_PROTOCOL_VERSION,
          code: "server-shutdown",
          message: "Signal ingress server is shutting down",
          fatal: true,
        };
        state.socket.end(`${JSON.stringify(response)}\n`);
      }
    }
    await this.#closeServer();
    for (const state of this.#clients) {
      if (!state.socket.destroyed) {
        state.socket.destroy();
      }
      this.#cleanupClient(state);
    }
    await this.#descriptor?.remove();
    if (this.#started) {
      this.#started = false;
      this.#options.onStatus?.({ kind: "stopped" });
    }
  }

  async #closeServer(): Promise<void> {
    if (!this.#server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}

function socketPause(socket: Socket): void {
  if (!socket.isPaused()) {
    socket.pause();
  }
}

function extractRequestId(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string"
  ) {
    return value.requestId.slice(0, 128);
  }
  return undefined;
}

function extractProtocolVersion(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value
  ) {
    return value.protocolVersion;
  }
  return undefined;
}

function boundedMessage(message: string): string {
  return message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
}

function describeValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? typeof value : serialized;
}
