import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_MAX_FRAME_BYTES,
  FRAME_HEADER_BYTES,
} from "../../packages/protocol/src/constants.js";
import { FrameDecoder } from "../../packages/protocol/src/framing.js";
import { commandCatalog } from "../../packages/protocol/src/catalog.js";
import type { MessageEnvelope } from "../../packages/protocol/src/schemas.js";

const READ_COMMANDS = new Set([
  "listening.inspect_session_source",
  "live_set.get_identity",
  "listening.inspect_context",
  "listening.inspect_session_pass",
]);
const READ_ONLY_COMMANDS = new Set(
  Object.entries(commandCatalog)
    .filter(([, definition]) => !definition.mutates)
    .map(([command]) => command),
);

export const ACCEPTANCE_BRIDGE_TIMING_LIMITS = {
  tunnels: 4,
  records: 512,
  pendingFrames: 128,
  pendingBytes: 8 * 1024 * 1024,
} as const;

type State = "queued" | "started" | "completed" | "failed" | "cancelled";
export interface AcceptanceBridgeTimingRecord {
  id: number;
  stage: "proxy" | "tunnel" | "request" | "handoff" | "close";
  state: State;
  queuedMs: number;
  startedMs?: number;
  endedMs?: number;
  tunnelId?: number;
  requestId?: string;
  command?: string;
  readOnly?: boolean;
  minimumReadMs?: number;
  responseOk?: boolean;
  observedResponseMs?: number;
  deliveredRoundTripMs?: number;
  failure?: string;
  traceId?: string;
  correlationId?: string;
  causationId?: string;
}

export interface AcceptanceBridgeTimingEvent {
  phase: State | "progress";
  atMs: number;
  record: AcceptanceBridgeTimingRecord;
}

export interface AcceptanceBridgeTimingOptions {
  minimumReadMs: number;
  /** Synchronous, bounded metadata only; throwing fails the diagnostic closed. */
  onEvent?: (event: AcceptanceBridgeTimingEvent) => void;
  /** Unit tests only. Production acceptance must leave this unset. */
  testOnlyUpstreamPort?: number;
}

interface PendingFrame {
  raw: Buffer;
  dueMs: number;
  request?: AcceptanceBridgeTimingRecord;
}

interface Tunnel {
  record: AcceptanceBridgeTimingRecord;
  client: Socket;
  upstream: Socket;
  requests: Map<string, AcceptanceBridgeTimingRecord>;
  queue: PendingFrame[];
  pendingBytes: number;
  writing: boolean;
  stopped: boolean;
  requestFrames: RawFrames;
  responseFrames: RawFrames;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

/** Retains original frame bytes; the canonical decoder is used for validation only. */
class RawFrames {
  #buffer = Buffer.alloc(0);

  public push(
    chunk: Buffer,
    receive: (raw: Buffer, message: MessageEnvelope) => void,
  ): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= FRAME_HEADER_BYTES) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > DEFAULT_MAX_FRAME_BYTES) {
        throw new Error("invalid_frame_length");
      }
      const size = FRAME_HEADER_BYTES + length;
      if (this.#buffer.length < size) return;
      const raw = this.#buffer.subarray(0, size);
      this.#buffer = this.#buffer.subarray(size);
      const message = new FrameDecoder().push(raw)[0];
      if (!message) throw new Error("invalid_frame");
      receive(raw, message);
    }
  }

  public get incomplete(): boolean {
    return this.#buffer.length !== 0;
  }

  public clear(): void {
    this.#buffer = Buffer.alloc(0);
  }
}

/**
 * Runner-only socket handoff/timing proxy, never a bridge implementation: forwarded
 * frames are byte-for-byte originals, including auth, sequence and trace fields.
 * Any diagnostic failure tears down the proxy rather than bypassing the delay.
 */
export class AcceptanceBridgeTimingProxy {
  readonly #minimumReadMs: number;
  readonly #upstreamPort: number;
  readonly #origin = performance.now();
  readonly #records: AcceptanceBridgeTimingRecord[] = [];
  readonly #tunnels = new Set<Tunnel>();
  #onEvent: AcceptanceBridgeTimingOptions["onEvent"];
  #server?: Server;
  #shutdown?: Promise<void>;
  #state: "idle" | "starting" | "listening" | "closing" | "closed" | "failed" =
    "idle";
  #failure?: string;
  #proxyRecord?: AcceptanceBridgeTimingRecord;
  #exclusive = false;
  #handoffUsed = false;

  public constructor(options: AcceptanceBridgeTimingOptions) {
    if (
      !Number.isFinite(options.minimumReadMs) ||
      options.minimumReadMs < 0 ||
      options.minimumReadMs > 1000
    ) {
      throw new RangeError("minimumReadMs must be between 0 and 1000");
    }
    const port = options.testOnlyUpstreamPort ?? 8765;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new RangeError("testOnlyUpstreamPort must be a valid TCP port");
    }
    this.#minimumReadMs = options.minimumReadMs;
    this.#upstreamPort = port;
    this.#onEvent = options.onEvent;
  }

  #now(): number {
    return performance.now() - this.#origin;
  }

  #emit(
    record: AcceptanceBridgeTimingRecord,
    phase: AcceptanceBridgeTimingEvent["phase"],
  ): void {
    try {
      this.#onEvent?.({ phase, atMs: this.#now(), record: { ...record } });
    } catch {
      this.#onEvent = undefined;
      this.#fail("event_callback_failed");
    }
  }

  #record(
    stage: AcceptanceBridgeTimingRecord["stage"],
    fields: Partial<AcceptanceBridgeTimingRecord> = {},
  ): AcceptanceBridgeTimingRecord | undefined {
    // Reserve the last receipt for cleanup, even on evidence overflow.
    if (
      this.#records.length >=
      ACCEPTANCE_BRIDGE_TIMING_LIMITS.records - (stage === "close" ? 0 : 1)
    ) {
      this.#fail("evidence_limit_exceeded");
      return undefined;
    }
    const record: AcceptanceBridgeTimingRecord = {
      ...fields,
      id: this.#records.length + 1,
      stage,
      state: "queued",
      queuedMs: this.#now(),
    };
    this.#records.push(record);
    this.#emit(record, "queued");
    return record;
  }

  #transition(
    record: AcceptanceBridgeTimingRecord,
    state: State,
    failure?: string,
  ): void {
    if (["completed", "cancelled", "failed"].includes(record.state)) return;
    record.state = state;
    if (state === "started") record.startedMs = this.#now();
    else if (state !== "queued") record.endedMs = this.#now();
    if (failure) record.failure = failure;
    this.#emit(record, state);
  }

  public async start(): Promise<number> {
    if (this.#state !== "idle") throw new Error("timing_proxy_not_idle");
    this.#state = "starting";
    const record = this.#record("proxy");
    if (record) this.#proxyRecord = record;
    if (!record || this.#failure)
      throw new Error(this.#failure ?? "timing_proxy_failed");
    this.#transition(record, "started");
    if (this.#failure) throw new Error(this.#failure);
    const server = createServer((client) => this.#accept(client));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.on("error", () => {
        this.#fail("server_error");
        reject(new Error("server_error"));
      });
      server.once("close", () => reject(new Error("start_cancelled")));
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (this.#state !== "starting" || !address || typeof address === "string") {
      throw new Error(this.#failure ?? "start_cancelled");
    }
    this.#state = "listening";
    this.#emit(record, "progress");
    return address.port;
  }

  #accept(client: Socket): void {
    if (this.#exclusive) {
      client.on("error", () => undefined);
      client.destroy();
      return;
    }
    // Install an error handler even for a rejected socket.
    client.on("error", () => this.#fail("client_socket_error"));
    if (
      this.#state !== "listening" ||
      this.#tunnels.size >= ACCEPTANCE_BRIDGE_TIMING_LIMITS.tunnels
    ) {
      client.destroy();
      if (this.#state === "listening") this.#fail("tunnel_limit_exceeded");
      return;
    }
    const record = this.#record("tunnel");
    if (!record || this.#failure) {
      client.destroy();
      return;
    }
    const upstream = createConnection({
      host: "127.0.0.1",
      port: this.#upstreamPort,
    });
    const requests = new RawFrames();
    const responses = new RawFrames();
    const tunnel: Tunnel = {
      record,
      client,
      upstream,
      requests: new Map(),
      queue: [],
      pendingBytes: 0,
      writing: false,
      stopped: false,
      requestFrames: requests,
      responseFrames: responses,
    };
    this.#tunnels.add(tunnel);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    upstream.on("error", () => this.#fail("upstream_socket_error"));
    upstream.once("connect", () => {
      if (!tunnel.stopped) this.#transition(record, "started");
    });
    client.on("data", (chunk: Buffer) => {
      try {
        requests.push(chunk, (raw, message) => {
          if (tunnel.stopped) return;
          if (message.kind !== "request")
            throw new Error("invalid_client_message");
          if (tunnel.requests.has(message.requestId)) {
            this.#fail("duplicate_request_id");
            return;
          }
          const receipt = this.#record("request", {
            tunnelId: record.id,
            requestId: message.requestId,
            command:
              READ_COMMANDS.has(message.command) ||
              message.command === "system.hello" ||
              message.command === "system.ping" ||
              message.command === "system.authenticate"
                ? message.command
                : "[other]",
            readOnly: READ_ONLY_COMMANDS.has(message.command),
            minimumReadMs: READ_COMMANDS.has(message.command)
              ? this.#minimumReadMs
              : 0,
          });
          if (!receipt || tunnel.stopped) return;
          tunnel.requests.set(message.requestId, receipt);
          this.#transition(receipt, "started");
          if (tunnel.stopped) return;
          if (
            upstream.writableLength + raw.length >
            ACCEPTANCE_BRIDGE_TIMING_LIMITS.pendingBytes
          ) {
            this.#fail("upstream_write_limit_exceeded");
            return;
          }
          upstream.write(raw, (error) => {
            if (error && !tunnel.stopped) this.#fail("upstream_write_failed");
          });
        });
      } catch {
        this.#fail("invalid_client_frame");
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      try {
        responses.push(chunk, (raw, message) => {
          if (tunnel.stopped) return;
          let receipt: AcceptanceBridgeTimingRecord | undefined;
          if (message.kind === "response") {
            receipt = tunnel.requests.get(message.requestId);
            if (!receipt || receipt.observedResponseMs !== undefined) {
              this.#fail("unmatched_response");
              return;
            }
            receipt.observedResponseMs = this.#now() - receipt.queuedMs;
            receipt.responseOk = message.ok;
            this.#emit(receipt, "progress");
          } else if (message.kind !== "event") {
            this.#fail("invalid_upstream_message");
            return;
          }
          if (tunnel.stopped) return;
          if (
            tunnel.queue.length >=
              ACCEPTANCE_BRIDGE_TIMING_LIMITS.pendingFrames ||
            tunnel.pendingBytes + raw.length >
              ACCEPTANCE_BRIDGE_TIMING_LIMITS.pendingBytes
          ) {
            this.#fail("downstream_queue_limit_exceeded");
            return;
          }
          tunnel.queue.push({
            raw,
            dueMs: receipt
              ? receipt.queuedMs + (receipt.minimumReadMs ?? 0)
              : this.#now(),
            ...(receipt ? { request: receipt } : {}),
          });
          tunnel.pendingBytes += raw.length;
          this.#drain(tunnel);
        });
      } catch {
        this.#fail("invalid_upstream_frame");
      }
    });
    const ended = (side: "client" | "upstream"): void => {
      if (tunnel.stopped) return;
      if ((side === "client" ? requests : responses).incomplete) {
        this.#fail(`truncated_${side}_frame`);
      } else if (tunnel.requests.size || tunnel.queue.length) {
        this.#fail(`${side}_closed_with_pending_work`);
      } else {
        this.#stopTunnel(tunnel, "completed");
      }
    };
    client.once("end", () => ended("client"));
    upstream.once("end", () => ended("upstream"));
    client.once("close", () => {
      ended("client");
      requests.clear();
    });
    upstream.once("close", () => {
      ended("upstream");
      responses.clear();
    });
  }

  #drain(tunnel: Tunnel): void {
    if (tunnel.stopped || tunnel.writing || tunnel.timer) return;
    const frame = tunnel.queue[0];
    if (!frame) return;
    const remaining = frame.dueMs - this.#now();
    if (remaining > 0) {
      tunnel.timer = setTimeout(() => {
        tunnel.timer = undefined;
        this.#drain(tunnel);
      }, Math.ceil(remaining));
      return;
    }
    tunnel.writing = true;
    tunnel.client.write(frame.raw, (error) => {
      if (tunnel.stopped) return;
      if (error) {
        this.#fail("downstream_write_failed");
        return;
      }
      tunnel.writing = false;
      tunnel.queue.shift();
      tunnel.pendingBytes -= frame.raw.length;
      if (frame.request) {
        frame.request.deliveredRoundTripMs =
          this.#now() - frame.request.queuedMs;
        tunnel.requests.delete(frame.request.requestId!);
        this.#transition(frame.request, "completed");
      }
      this.#drain(tunnel);
    });
  }

  #stopTunnel(
    tunnel: Tunnel,
    state: "completed" | "cancelled" | "failed",
  ): void {
    if (tunnel.stopped) return;
    tunnel.stopped = true;
    clearTimeout(tunnel.timer);
    tunnel.timer = undefined;
    tunnel.client.destroy();
    tunnel.upstream.destroy();
    for (const receipt of tunnel.requests.values()) {
      this.#transition(
        receipt,
        state === "completed" ? "cancelled" : state,
        this.#failure,
      );
    }
    tunnel.requests.clear();
    tunnel.queue.length = 0;
    tunnel.pendingBytes = 0;
    this.#tunnels.delete(tunnel);
    this.#transition(tunnel.record, state, this.#failure);
  }

  /** Release the single-client Remote Script socket only between completed turns. */
  public async withExclusiveUpstream<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    trace: { traceId: string; correlationId: string; causationId: string },
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.#state !== "listening" || this.#handoffUsed || this.#exclusive)
      throw new Error("runner_handoff_not_admitted");
    if (
      Object.values(trace).some(
        (value) => !/^[a-zA-Z0-9._:-]{1,256}$/u.test(value),
      )
    )
      throw new Error("runner_handoff_invalid_trace");
    this.#handoffUsed = true;
    const record = this.#record("handoff", trace);
    if (!record || this.#failure)
      throw new Error(this.#failure ?? "runner_handoff_failed");
    this.#transition(record, "started");
    try {
      const deadline = performance.now() + 5000;
      while (
        [...this.#tunnels].some(
          (tunnel) =>
            tunnel.requests.size > 0 ||
            tunnel.queue.length > 0 ||
            tunnel.writing ||
            tunnel.requestFrames.incomplete ||
            tunnel.responseFrames.incomplete,
        )
      ) {
        signal.throwIfAborted();
        if (this.#state !== "listening" || performance.now() >= deadline)
          throw new Error("runner_handoff_bridge_not_idle");
        await delay(5, undefined, { signal });
      }
      signal.throwIfAborted();
      if (this.#state !== "listening")
        throw new Error("runner_handoff_proxy_closed");
      this.#exclusive = true;
      const closed: Promise<void>[] = [];
      for (const tunnel of this.#tunnels) {
        for (const socket of [tunnel.client, tunnel.upstream])
          if (!socket.closed)
            closed.push(
              new Promise((resolve) => socket.once("close", resolve)),
            );
        this.#stopTunnel(tunnel, "completed");
      }
      await Promise.all(closed);
      signal.throwIfAborted();
      this.#emit(record, "progress");
      if (this.#failure) throw new Error(this.#failure);
      const result = await operation();
      signal.throwIfAborted();
      if (this.#state !== "listening")
        throw new Error("runner_handoff_proxy_closed");
      this.#transition(record, "completed");
      return result;
    } catch (error) {
      this.#transition(
        record,
        signal.aborted ? "cancelled" : "failed",
        "runner_handoff_operation_failed",
      );
      throw error;
    } finally {
      this.#exclusive = false;
    }
  }

  #fail(failure: string): void {
    if (this.#failure) return;
    this.#failure = failure;
    this.#state = "failed";
    if (this.#proxyRecord)
      this.#transition(this.#proxyRecord, "failed", failure);
    void this.close();
  }

  public close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    // Assign before emitting so a callback failure cannot recursively start cleanup.
    let finish!: () => void;
    this.#shutdown = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (
      !this.#failure &&
      [...this.#tunnels].some((tunnel) =>
        [...tunnel.requests.values()].some((request) => !request.readOnly),
      )
    )
      this.#fail("pending_mutation_or_unknown_at_close");
    if (!this.#failure) this.#state = "closing";
    const record = this.#record("close");
    if (record) this.#transition(record, "started");
    const closedSockets: Promise<void>[] = [];
    for (const tunnel of this.#tunnels) {
      for (const socket of [tunnel.client, tunnel.upstream]) {
        if (!socket.closed)
          closedSockets.push(
            new Promise((resolve) => socket.once("close", resolve)),
          );
      }
      this.#stopTunnel(tunnel, this.#failure ? "failed" : "cancelled");
    }
    const serverClosed = new Promise<void>((resolve) => {
      if (!this.#server) resolve();
      else this.#server.close(() => resolve());
    });
    void Promise.all([...closedSockets, serverClosed]).then(() => {
      if (!this.#failure) this.#state = "closed";
      for (const pending of this.#records) {
        if (pending !== record && pending !== this.#proxyRecord) {
          this.#transition(
            pending,
            this.#failure ? "failed" : "cancelled",
            this.#failure,
          );
        }
      }
      if (this.#proxyRecord)
        this.#transition(
          this.#proxyRecord,
          this.#failure ? "failed" : "completed",
          this.#failure,
        );
      if (record) this.#transition(record, "completed");
      finish();
    });
    return this.#shutdown;
  }

  public snapshot() {
    return {
      state: this.#state,
      ...(this.#failure ? { failure: this.#failure } : {}),
      minimumReadMs: this.#minimumReadMs,
      activeTunnels: this.#tunnels.size,
      pendingFrames: [...this.#tunnels].reduce(
        (sum, tunnel) => sum + tunnel.queue.length,
        0,
      ),
      pendingBytes: [...this.#tunnels].reduce(
        (sum, tunnel) => sum + tunnel.pendingBytes,
        0,
      ),
      records: this.#records.map((record) => ({ ...record })),
    };
  }
}
