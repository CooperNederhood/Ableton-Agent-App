import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";

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
import { recordSignalTelemetry, stableTelemetryId } from "./telemetry.js";
import type { NonBlockingObservabilityRecorder } from "@ableton-agent/observability";
import {
  sanitizePersistedText,
  sanitizeTelemetryAttributes,
} from "@ableton-agent/observability";
import {
  listenerControlInputSchema,
  type ListenerControl,
  type ListenerControlInput,
  type ListenerControlOptions,
  type ListenerDescriptor,
  type ListenerReply,
  type ListenerResult,
  type ListenerResultEvent,
  type ListenerService,
} from "./listener-contracts.js";

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
  readonly secretPath?: string;
  readonly registry: SignalIngressRegistry;
  readonly router: SignalIngressRouter;
  readonly host?: string;
  readonly port?: number;
  readonly maxFrameBytes?: number;
  readonly maxOutstandingMessages?: number;
  readonly idleTimeoutMs?: number;
  readonly idleCheckIntervalMs?: number;
  readonly descriptorPath?: string;
  readonly legacyDescriptorPath?: string;
  readonly onStatus?: (status: SignalIngressStatus) => void;
  readonly onDiagnostic?: (diagnostic: SignalIngressDiagnostic) => void;
  readonly now?: () => number;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
}

export interface SignalIngressEndpoint {
  readonly host: string;
  readonly port: number;
}

interface ClientState {
  readonly socket: Socket;
  buffer: Buffer;
  readonly queue: Array<{ readonly line: string; readonly receivedAt: number }>;
  pumping: boolean;
  closing: boolean;
  connectionId: string | undefined;
  producer: OutputProducer | undefined;
  lastHeartbeatAt: number;
  lastSequence: number;
  listener?: ListenerDescriptor["registration"];
  listenerSequence: number;
  listenerPhase: ListenerDescriptor["phase"];
  listenerOwner?: ListenerControl;
  listenerDeadline?: number;
  listenerResults: number;
  listenerStartedAt?: number;
}

interface PendingListenerControl {
  readonly state: ClientState;
  readonly control: ListenerControl;
  readonly startedAt: number;
  readonly resolve: (reply: ListenerReply) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;
const MAX_DIAGNOSTICS_PER_WINDOW = 20;
const DIAGNOSTIC_WINDOW_MS = 1000;

export class SignalIngressServer implements ListenerService {
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
  readonly #listenerControls = new Map<string, PendingListenerControl>();
  readonly #resultListeners = new Set<(event: ListenerResultEvent) => void>();
  readonly #now: () => number;
  readonly #secretBytes: Buffer;
  readonly #descriptor: DiscoveryDescriptorLifecycle | undefined;
  readonly #legacyDescriptor: DiscoveryDescriptorLifecycle | undefined;
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
    if (
      options.secretPath !== undefined &&
      (!isAbsolute(options.secretPath) || options.secretPath.length > 4096)
    )
      throw new RangeError(
        "Signal ingress secretPath must be a bounded absolute file reference",
      );
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
    this.#legacyDescriptor =
      options.legacyDescriptorPath === undefined ||
      options.legacyDescriptorPath === options.descriptorPath
        ? undefined
        : new DiscoveryDescriptorLifecycle(options.legacyDescriptorPath);
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

  inspectListeners(): readonly ListenerDescriptor[] {
    return [...this.#clients].flatMap((state) =>
      state.listener &&
      state.connectionId &&
      state.producer &&
      state.producer.track?.id !== undefined &&
      state.producer.device?.id !== undefined &&
      !state.closing &&
      !state.socket.destroyed
        ? [
            {
              connectionId: state.connectionId,
              binding: {
                trackId: state.producer.track.id,
                deviceId: state.producer.device.id,
              },
              producer: structuredClone(state.producer),
              registration: structuredClone(state.listener),
              phase: state.listenerPhase,
              ...(state.listenerOwner
                ? {
                    jobId: state.listenerOwner.jobId,
                    passId: state.listenerOwner.passId,
                  }
                : {}),
            },
          ]
        : [],
    );
  }

  onListenerResult(listener: (event: ListenerResultEvent) => void): () => void {
    this.#resultListeners.add(listener);
    return () => {
      this.#resultListeners.delete(listener);
    };
  }

  async requestListenerControl(
    connectionId: string,
    input: ListenerControlInput,
    options: ListenerControlOptions = {},
  ): Promise<ListenerReply> {
    const value = listenerControlInputSchema.parse(input);
    const denied = (reason: string): Error => {
      recordSignalTelemetry(this.#options.telemetry, {
        name: "output.listener.denied",
        source: "output-ingress",
        outcome: "failure",
        correlationId: value.correlationId,
        causationId: value.causationId,
        trace: {
          traceId: value.traceId,
          spanId: stableTelemetryId(`${value.traceId}:denied:${value.action}`),
        },
        attributes: {
          reason,
          connectionId,
          jobId: value.jobId,
          passId: value.passId,
          action: value.action,
        },
      });
      return new Error(reason);
    };
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new RangeError("Listener timeout must be 1 to 120000ms");
    if (options.signal?.aborted) throw denied("Listener control cancelled");
    const state = [...this.#clients].find(
      (client) => client.connectionId === connectionId,
    );
    if (
      !state?.listener ||
      !state.producer ||
      state.closing ||
      state.socket.destroyed
    )
      throw denied("Listener unavailable");
    if (this.#listenerControls.size >= 64)
      throw denied("Listener control backpressure");
    if (value.action === "prepare") {
      if (state.listenerOwner) throw denied("Listener already owned");
      if (
        state.listener.deviceCanonicalPath === undefined ||
        state.listener.trackCanonicalPath === undefined ||
        state.listener.nativeStatus === undefined
      )
        throw denied("listener_metadata_missing");
      if (
        state.listener.nativeStatus.timing !== "VERIFIED" ||
        state.listener.nativeStatus.readiness !== "READY"
      )
        throw denied(
          state.listener.nativeStatus.reason ??
            "real_live_timing_validation_required",
        );
    } else {
      if (
        !state.listenerOwner ||
        state.listenerOwner.jobId !== value.jobId ||
        state.listenerOwner.passId !== value.passId ||
        state.listenerOwner.traceId !== value.traceId
      )
        throw denied("Listener ownership mismatch");
      if (value.action === "arm" && state.listenerPhase !== "ready")
        throw denied("Listener is not ready");
      if (value.action === "cancel" && state.listenerPhase === "cancelling")
        throw denied("Listener cancellation already pending");
    }
    const control: ListenerControl = {
      ...value,
      type: "listener.control",
      protocolVersion: 1,
      listenerVersion: 1,
      requestId: randomUUID(),
      connectionEpoch: state.listener.connectionEpoch,
    };
    if (value.action === "prepare") {
      state.listenerOwner = control;
      state.listenerDeadline =
        this.#now() + (value.config?.durationMs ?? 0) + 20000;
      state.listenerResults = 0;
      state.listenerStartedAt = this.#now();
    }
    state.listenerPhase =
      value.action === "prepare"
        ? "preparing"
        : value.action === "arm"
          ? "arming"
          : "cancelling";
    this.#listenerTelemetry("queued", state, control);
    return new Promise<ListenerReply>((resolve, reject) => {
      const onAbort = (): void => {
        this.#finishListenerControl(
          control.requestId,
          undefined,
          new Error("Listener control cancelled"),
          "cancelled",
        );
        this.#publishListenerFailure(state, "control_cancelled");
        // Losing a reply leaves execution unknown: disconnect, never claim a successful disarm.
        state.socket.destroy();
      };
      const timer = setTimeout(() => {
        this.#finishListenerControl(
          control.requestId,
          undefined,
          new Error("Listener control timed out"),
        );
        this.#publishListenerFailure(state, "control_timeout");
        state.socket.destroy();
      }, timeoutMs);
      timer.unref();
      const pending: PendingListenerControl = {
        state,
        control,
        startedAt: this.#now(),
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.#listenerControls.set(control.requestId, pending);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      this.#listenerTelemetry("started", state, control);
      void this.#write(state, control).catch(() => {
        this.#finishListenerControl(
          control.requestId,
          undefined,
          new Error("Listener control write failed"),
        );
        state.socket.destroy();
      });
    });
  }

  #listenerTelemetry(
    stage: string,
    state: ClientState,
    message: ListenerControl | ListenerReply | ListenerResult,
    durationMs?: number,
  ): void {
    recordSignalTelemetry(this.#options.telemetry, {
      name: `output.listener.${stage}`,
      source: "output-ingress",
      correlationId: message.correlationId,
      causationId: message.causationId,
      trace: {
        traceId: message.traceId,
        spanId: stableTelemetryId(
          `${message.traceId}:${message.requestId}:${stage}`,
        ),
      },
      ...(durationMs === undefined
        ? state.listenerStartedAt === undefined
          ? {}
          : { durationMs: this.#now() - state.listenerStartedAt }
        : { durationMs }),
      outcome:
        stage === "failed"
          ? "failure"
          : stage === "cancelled"
            ? "cancelled"
            : "success",
      attributes: sanitizeTelemetryAttributes({
        connectionId: state.connectionId ?? "",
        ...(state.producer === undefined
          ? {}
          : {
              producerId: state.producer.producerId,
              instanceId: state.producer.instanceId,
              ...(state.producer.track?.id === undefined
                ? {}
                : { trackId: state.producer.track.id }),
              ...(state.producer.device?.id === undefined
                ? {}
                : { deviceId: state.producer.device.id }),
            }),
        connectionEpoch: message.connectionEpoch,
        jobId: message.jobId,
        passId: message.passId,
        requestId: message.requestId,
        ...("action" in message
          ? { action: message.action }
          : { status: message.status }),
        ...("reason" in message && message.reason !== undefined
          ? { reason: sanitizePersistedText(message.reason).slice(0, 512) }
          : {}),
        ...("observation" in message && message.observation !== undefined
          ? { observation: message.observation }
          : {}),
        ...("nativeArm" in message && message.nativeArm !== undefined
          ? { nativeArm: message.nativeArm }
          : {}),
        ...("nativeLaunch" in message && message.nativeLaunch !== undefined
          ? { nativeLaunch: message.nativeLaunch }
          : {}),
        ...("nativeCapture" in message && message.nativeCapture !== undefined
          ? { nativeCapture: message.nativeCapture }
          : {}),
      }),
    });
    if ("nativeLifecycle" in message && message.nativeLifecycle !== undefined) {
      const native = message.nativeLifecycle;
      const key = (id: string): string =>
        stableTelemetryId(
          `native-listener:${state.connectionId}:${state.producer?.instanceId}:${message.connectionEpoch}:${message.jobId}:${message.passId}:${id}`,
        );
      recordSignalTelemetry(this.#options.telemetry, {
        id: key(native.eventId),
        name: `output.listener.native.${native.stage}`,
        source: "output-ingress",
        correlationId: message.correlationId,
        causationId:
          native.causationId === message.causationId
            ? message.causationId
            : key(native.causationId),
        trace: { traceId: message.traceId, spanId: key(native.eventId) },
        durationMs: native.elapsedMs,
        outcome:
          native.stage === "failed"
            ? "failure"
            : native.stage === "cancelled"
              ? "cancelled"
              : "success",
        attributes: sanitizeTelemetryAttributes({
          connectionId: state.connectionId,
          producerId: state.producer?.producerId,
          instanceId: state.producer?.instanceId,
          connectionEpoch: message.connectionEpoch,
          jobId: message.jobId,
          passId: message.passId,
          ...native,
        }),
      });
    }
  }

  #finishListenerControl(
    requestId: string,
    reply?: ListenerReply,
    error?: Error,
    stage = "failed",
  ): void {
    const pending = this.#listenerControls.get(requestId);
    if (!pending) return;
    this.#listenerControls.delete(requestId);
    pending.cleanup();
    this.#listenerTelemetry(
      reply
        ? reply.status === "failed"
          ? "failed"
          : reply.status === "cancelled"
            ? "cancelled"
            : "completed"
        : stage,
      pending.state,
      reply ?? pending.control,
      this.#now() - pending.startedAt,
    );
    if (error) pending.reject(error);
    else if (reply) pending.resolve(reply);
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
      ...(this.#options.secretPath === undefined
        ? {}
        : { secretPath: this.#options.secretPath }),
      listenerVersions: [1],
      listenerCapabilities: ["audio-listener/v1"],
    };
    const descriptorStartedAt = this.#now();
    if (this.#legacyDescriptor) {
      for (const stage of ["queued", "started"])
        recordSignalTelemetry(this.#options.telemetry, {
          name: `output.ingress.legacy-discovery-${stage}`,
          source: "output-ingress",
          attributes: { compatibility: "installed-midi-producers" },
        });
    }
    try {
      await this.#descriptor?.write(descriptor);
      await this.#legacyDescriptor?.write(descriptor);
      if (this.#legacyDescriptor)
        recordSignalTelemetry(this.#options.telemetry, {
          name: "output.ingress.legacy-discovery-published",
          source: "output-ingress",
          outcome: "success",
          durationMs: this.#now() - descriptorStartedAt,
          attributes: { compatibility: "installed-midi-producers" },
        });
    } catch (error) {
      if (this.#legacyDescriptor)
        recordSignalTelemetry(this.#options.telemetry, {
          name: "output.ingress.legacy-discovery-failed",
          source: "output-ingress",
          outcome: "failure",
          durationMs: this.#now() - descriptorStartedAt,
          attributes: { compatibility: "installed-midi-producers" },
        });
      for (const state of this.#clients) {
        state.socket.destroy();
        this.#cleanupClient(state);
      }
      await this.#closeServer();
      await this.#descriptor?.remove();
      await this.#legacyDescriptor?.remove();
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
      listenerSequence: -1,
      listenerPhase: "idle",
      listenerResults: 0,
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
      state.queue.push({ line, receivedAt: this.#now() });
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
          const entry = state.queue.shift();
          if (entry === undefined) {
            break;
          }
          await this.#handleLine(state, entry.line, entry.receivedAt);
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

  async #handleLine(
    state: ClientState,
    line: string,
    receivedAt: number,
  ): Promise<void> {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      await this.#fail(
        state,
        "malformed-json",
        "Malformed JSON",
        true,
        undefined,
        receivedAt,
      );
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
        receivedAt,
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
        receivedAt,
      );
      return;
    }
    const message = parsed.data;
    const traceId =
      message.type === "signal.frame" && state.connectionId !== undefined
        ? stableTelemetryId(
            `output-signal:${state.connectionId}:${message.sequence}`,
          )
        : stableTelemetryId(`output-ingress-request:${message.requestId}`);
    recordSignalTelemetry(this.#options.telemetry, {
      name: "output.ingress.received",
      source: "output-ingress",
      correlationId: message.requestId,
      occurredAt: new Date(receivedAt).toISOString(),
      durationMs: this.#now() - receivedAt,
      trace: { traceId, spanId: traceId },
      attributes: {
        requestId: message.requestId,
        messageType: message.type,
        ...(state.connectionId === undefined
          ? {}
          : { connectionId: state.connectionId }),
        ...(message.type === "signal.frame"
          ? { sequence: message.sequence, capturedAt: message.capturedAt }
          : {}),
      },
    });
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
        await this.#route(state, message, receivedAt);
        break;
      case "producer.disconnect":
        await this.#ack(state, message.requestId, "disconnect");
        state.closing = true;
        state.socket.end();
        break;
      case "listener.reply":
      case "listener.result":
        await this.#listenerMessage(state, message);
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
    if (
      (message.listener !== undefined &&
        (message.producer.signalKind !== "audio" ||
          message.producer.schemaVersion !== "audio-observation/v1" ||
          message.producer.track?.id === undefined ||
          message.producer.device?.id === undefined)) ||
      (message.producer.schemaVersion === "audio-observation/v1" &&
        message.listener === undefined)
    ) {
      await this.#fail(
        state,
        "invalid-message",
        "Audio observations require negotiated listener capability and track/device binding",
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
    if (
      message.listener &&
      [...this.#liveInstances.values()].some(
        (candidate) =>
          !candidate.closing &&
          candidate.producer?.producerId === message.producer.producerId,
      )
    ) {
      await this.#fail(
        state,
        "duplicate-instance",
        "Listener producer already has an active connection",
        true,
        message.requestId,
      );
      return;
    }
    const connectionId = randomUUID();
    state.connectionId = connectionId;
    state.producer = message.producer;
    if (message.listener) state.listener = message.listener;
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

  async #listenerMessage(
    state: ClientState,
    message: ListenerReply | ListenerResult,
  ): Promise<void> {
    if (message.reason !== undefined)
      message.reason = sanitizePersistedText(message.reason).slice(0, 512);
    const owner = state.listenerOwner;
    if (
      !state.listener ||
      !owner ||
      message.connectionEpoch !== state.listener.connectionEpoch ||
      message.jobId !== owner.jobId ||
      message.passId !== owner.passId ||
      message.traceId !== owner.traceId
    ) {
      await this.#fail(
        state,
        "route-rejected",
        "Listener epoch or ownership mismatch",
        true,
        message.requestId,
      );
      return;
    }
    if (message.sequence !== state.listenerSequence + 1) {
      this.#publishListenerFailure(state, "sequence_gap");
      await this.#fail(
        state,
        "sequence-replay",
        "Listener sequences must be contiguous",
        true,
        message.requestId,
      );
      return;
    }
    state.listenerSequence = message.sequence;
    state.lastHeartbeatAt = this.#now();
    if (message.type === "listener.reply") {
      const pending = this.#listenerControls.get(message.requestId);
      if (
        !pending ||
        pending.state !== state ||
        pending.control.correlationId !== message.correlationId ||
        pending.control.causationId !== message.causationId ||
        (message.status !== "failed" &&
          message.status !==
            (pending.control.action === "prepare"
              ? "ready"
              : pending.control.action === "arm"
                ? "armed"
                : "cancelled"))
      ) {
        await this.#fail(
          state,
          "route-rejected",
          "Unexpected listener control reply",
          true,
          message.requestId,
        );
        return;
      }
      if (
        state.listenerPhase !== "cancelling" ||
        pending.control.action === "cancel"
      ) {
        state.listenerPhase =
          message.status === "ready"
            ? "ready"
            : message.status === "armed"
              ? "armed"
              : "idle";
        if (state.listenerPhase === "idle") {
          delete state.listenerOwner;
          delete state.listenerDeadline;
        } else if (message.status === "armed") {
          state.listenerDeadline =
            this.#now() + (owner.config?.durationMs ?? 0) + 5000;
        }
      }
      this.#finishListenerControl(message.requestId, message);
      if (message.status === "cancelled" || message.status === "failed") {
        for (const [requestId, other] of this.#listenerControls) {
          if (other.state === state)
            this.#finishListenerControl(
              requestId,
              undefined,
              new Error("Listener operation ended"),
              "cancelled",
            );
        }
      }
    } else {
      if (
        state.listenerPhase !== "armed" &&
        state.listenerPhase !== "cancelling"
      ) {
        await this.#fail(
          state,
          "route-rejected",
          "Listener result received before arm readiness",
          true,
          message.requestId,
        );
        return;
      }
      if (
        message.correlationId !== owner.correlationId ||
        message.causationId !== owner.causationId
      ) {
        await this.#fail(
          state,
          "route-rejected",
          "Listener result correlation or causation mismatch",
          true,
          message.requestId,
        );
        return;
      }
      state.listenerResults += 1;
      const observation = message.observation;
      if (
        state.listenerResults > 1024 ||
        (observation !== undefined &&
          (observation.listenerId !== state.producer?.producerId ||
            observation.passId !== owner.passId ||
            observation.sampleRate !== state.listener.sampleRate ||
            observation.algorithm.version !== state.listener.algorithmVersion ||
            observation.samples.length > (owner.config?.maxWindows ?? 0) ||
            observation.startBeat < (owner.config?.source.startBeat ?? 0) ||
            observation.endBeat > (owner.config?.source.endBeat ?? 0) ||
            (message.status === "completed" &&
              (!observation.complete ||
                observation.endSample <= observation.startSample ||
                observation.startBeat !== owner.config?.source.startBeat ||
                observation.endBeat !== owner.config?.source.endBeat)) ||
            (message.status !== "completed" && observation.complete) ||
            observation.endSample - observation.startSample >
              ((owner.config?.durationMs ?? 0) * observation.sampleRate) /
                1000 +
                observation.algorithm.timingUncertaintySamples))
      ) {
        await this.#fail(
          state,
          "route-rejected",
          "Listener observation attribution or capture bounds mismatch",
          true,
          message.requestId,
        );
        return;
      }
      this.#listenerTelemetry(
        message.status === "progress"
          ? "progress"
          : message.status === "completed"
            ? "completed"
            : "failed",
        state,
        message,
      );
      this.#emitListenerResult(state, message);
      if (
        message.status !== "progress" &&
        state.listenerPhase !== "cancelling"
      ) {
        delete state.listenerOwner;
        delete state.listenerDeadline;
        state.listenerPhase = "idle";
      }
    }
    await this.#ack(state, message.requestId, "listener");
  }

  #emitListenerResult(state: ClientState, result: ListenerResult): void {
    if (
      !state.connectionId ||
      !state.producer ||
      state.producer.track?.id === undefined ||
      state.producer.device?.id === undefined
    )
      return;
    for (const callback of this.#resultListeners) {
      try {
        callback({
          connectionId: state.connectionId,
          binding: {
            trackId: state.producer.track.id,
            deviceId: state.producer.device.id,
          },
          producer: structuredClone(state.producer),
          result: structuredClone(result),
        });
      } catch {
        this.#diagnostic(
          "internal-error",
          "Listener result subscriber failed",
          state.connectionId,
        );
      }
    }
  }

  #publishListenerFailure(state: ClientState, reason: string): void {
    const owner = state.listenerOwner;
    if (!owner) return;
    const result: ListenerResult = {
      type: "listener.result",
      protocolVersion: 1,
      listenerVersion: 1,
      requestId: randomUUID(),
      connectionEpoch: owner.connectionEpoch,
      jobId: owner.jobId,
      passId: owner.passId,
      traceId: owner.traceId,
      correlationId: owner.correlationId,
      causationId: owner.causationId,
      sequence: Math.min(Number.MAX_SAFE_INTEGER, state.listenerSequence + 1),
      status: "partial",
      reason,
    };
    this.#listenerTelemetry("failed", state, result);
    this.#emitListenerResult(state, result);
    delete state.listenerOwner;
    delete state.listenerDeadline;
    state.listenerPhase = "idle";
  }

  async #route(
    state: ClientState,
    message: Extract<
      ReturnType<typeof producerMessageSchema.parse>,
      { type: "signal.frame" }
    >,
    receivedAt: number,
  ): Promise<void> {
    const envelope: SignalEnvelope = {
      protocolVersion: 1,
      connectionId: state.connectionId as string,
      sequence: message.sequence,
      capturedAt: message.capturedAt,
      receivedAt,
      payload: message.payload,
    };
    const traceId = stableTelemetryId(
      `output-signal:${envelope.connectionId}:${envelope.sequence}`,
    );
    const routeStartedAt = this.#now();
    const result = this.#options.router.route(envelope);
    recordSignalTelemetry(this.#options.telemetry, {
      name: "output.ingress.routed",
      source: "output-ingress",
      correlationId: message.requestId,
      level: result.accepted ? "info" : "warn",
      outcome: result.accepted ? "success" : "failure",
      durationMs: this.#now() - routeStartedAt,
      trace: {
        traceId,
        spanId: stableTelemetryId(`${traceId}:ingress-route`),
        parentSpanId: traceId,
      },
      attributes: {
        requestId: message.requestId,
        connectionId: envelope.connectionId,
        sequence: envelope.sequence,
        assignmentCount: result.deliveries.length,
      },
    });
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
    const traceId =
      action === "signal" &&
      state.connectionId !== undefined &&
      state.lastSequence >= 0
        ? stableTelemetryId(
            `output-signal:${state.connectionId}:${state.lastSequence}`,
          )
        : stableTelemetryId(`output-ingress-request:${requestId}`);
    recordSignalTelemetry(this.#options.telemetry, {
      name: "output.ingress.acknowledged",
      source: "output-ingress",
      correlationId: requestId,
      outcome: "success",
      trace: {
        traceId,
        spanId: stableTelemetryId(`${traceId}:ack:${requestId}`),
        parentSpanId: traceId,
      },
      attributes: {
        requestId,
        action,
        ...(state.connectionId === undefined
          ? {}
          : { connectionId: state.connectionId }),
      },
    });
  }

  async #fail(
    state: ClientState,
    code: IngressErrorCode,
    message: string,
    fatal: boolean,
    requestId?: string,
    startedAt = this.#now(),
  ): Promise<void> {
    if (fatal) {
      state.closing = true;
      this.#publishListenerFailure(state, code);
    }
    this.#diagnostic(code, message, state.connectionId);
    this.#recordFailure(code, requestId, state.connectionId, fatal, startedAt);
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

  #recordFailure(
    code: IngressErrorCode,
    requestId: string | undefined,
    connectionId: string | undefined,
    fatal: boolean,
    startedAt: number,
  ): void {
    const traceId = stableTelemetryId(
      `output-ingress-request:${requestId ?? `${connectionId ?? "unknown"}:${startedAt}`}`,
    );
    recordSignalTelemetry(this.#options.telemetry, {
      name: "output.ingress.failed",
      source: "output-ingress",
      ...(requestId === undefined ? {} : { correlationId: requestId }),
      level: "warn",
      outcome: "failure",
      durationMs: this.#now() - startedAt,
      trace: { traceId, spanId: traceId },
      attributes: {
        code,
        fatal,
        ...(requestId === undefined ? {} : { requestId }),
        ...(connectionId === undefined ? {} : { connectionId }),
      },
    });
  }

  async #write(state: ClientState, value: object): Promise<void> {
    if (state.socket.destroyed) {
      throw new Error("Ingress socket closed");
    }
    const encoded = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(encoded, "utf8") - 1 > this.#options.maxFrameBytes)
      throw new Error("Ingress response exceeds frame bounds");
    if (
      state.listener &&
      state.socket.writableLength > this.#options.maxFrameBytes * 2
    )
      throw new Error("Listener outbound backpressure");
    const writable = state.socket.write(encoded);
    if (!writable) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          this.#publishListenerFailure(state, "outbound_backpressure");
          state.socket.destroy();
          reject(new Error("Ingress drain timed out"));
        }, 1000);
        timer.unref();
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error("Ingress socket closed before drain"));
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const cleanup = (): void => {
          clearTimeout(timer);
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
        state.listenerDeadline !== undefined &&
        now > state.listenerDeadline &&
        !state.closing
      ) {
        this.#publishListenerFailure(state, "capture_watchdog_timeout");
        state.socket.destroy();
        continue;
      }
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
    this.#publishListenerFailure(state, "disconnected");
    for (const [requestId, pending] of this.#listenerControls) {
      if (pending.state === state)
        this.#finishListenerControl(
          requestId,
          undefined,
          new Error("Listener disconnected"),
        );
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
      this.#publishListenerFailure(state, "server_shutdown");
      for (const [requestId, pending] of this.#listenerControls) {
        if (pending.state === state)
          this.#finishListenerControl(
            requestId,
            undefined,
            new Error("Listener ingress stopped"),
            "cancelled",
          );
      }
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
    const closeTimer = setTimeout(() => {
      for (const state of this.#clients) state.socket.destroy();
    }, 250);
    closeTimer.unref();
    try {
      await this.#closeServer();
    } finally {
      clearTimeout(closeTimer);
    }
    for (const state of this.#clients) {
      if (!state.socket.destroyed) {
        state.socket.destroy();
      }
      this.#cleanupClient(state);
    }
    await this.#descriptor?.remove();
    await this.#legacyDescriptor?.remove();
    this.#resultListeners.clear();
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
