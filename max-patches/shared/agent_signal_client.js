/* global Buffer, clearInterval, clearTimeout, module, process, require, setInterval, setTimeout */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PROTOCOL_VERSION = 1;

function loadMetricProtocol() {
  let codec;
  try {
    codec = require("./audio_listener_metric_protocol.js");
  } catch {
    throw new Error("metric_listener_protocol_companion_unavailable");
  }
  if (
    codec.LISTENER_VERSION_METRIC !== 5 ||
    codec.MAX_METRIC_RESULT_FRAME_BYTES !== 2 * 1024 * 1024 ||
    codec.LISTENER_CAPABILITY_METRIC !==
      "audio-listener/independent-metric-timelines-v1" ||
    codec.LISTENER_METRIC_ALGORITHM_VERSION !== "3.0.0" ||
    codec.LISTENER_METRIC_PRODUCER_SCHEMA_VERSION !==
      "metric-audio-observation/v1" ||
    ![
      "listenerControlMetricSchema",
      "listenerMetricProducerSchema",
      "listenerMetricWireIdentitySchema",
      "listenerRegistrationMetricSchema",
      "listenerReplyMetricSchema",
      "listenerResultMetricSchema"
    ].every((name) => typeof codec[name]?.parse === "function") ||
    ![
      "assertNativeMetricReadyProof",
      "assertNativeMetricArmProof",
      "assertNativeMetricObservationSource",
      "nativeMetricLaunchCoordinates",
      "snapshotNativeMetricListeningExpectation"
    ].every((name) => typeof codec[name] === "function")
  )
    throw new Error("metric_listener_protocol_companion_invalid");
  return codec;
}

function freezeMetricData(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeMetricData(child);
    Object.freeze(value);
  }
  return value;
}

function assertMetricData(value) {
  const seen = new Set();
  let count = 0;
  const inspect = (item) => {
    if (item === null || typeof item !== "object") return;
    if (
      seen.has(item) ||
      ++count > 50_000 ||
      ![Object.prototype, Array.prototype, null].includes(
        Object.getPrototypeOf(item)
      )
    )
      throw new Error("metric_listener_non_data_payload");
    seen.add(item);
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(item)
    )) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value"))
        throw new Error("metric_listener_accessor_payload");
      inspect(descriptor.value);
    }
    seen.delete(item);
  };
  inspect(value);
}

function parseMetricData(schema, value) {
  assertMetricData(value);
  return freezeMetricData(schema.parse(value));
}

const DEFAULT_MAX_FRAME_BYTES = 128 * 1024;
const OUTBOUND_DRAIN_TIMEOUT_MS = 1000;
const WRITE_DIAGNOSTIC_SCHEMA = "write-backpressure/v1";
const WRITE_DIAGNOSTIC_REASONS = [
  "write_backpressure",
  "drain",
  "pending_quota_exceeded",
  "outbound_queue_quota_exceeded",
  "outbound_write_failed",
  "outbound_drain_timeout",
  "disconnected",
  "stopped"
];
const DEFAULT_DESCRIPTOR_ENV = "ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR";
const DEFAULT_SECRET_ENV = "ABLETON_AGENT_SIGNAL_INGRESS_SECRET";
const DEFAULT_SECRET_PATH_ENV = "ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH";
const DEFAULT_SIGNAL_DIRECTORY = path.join(os.homedir(), ".ableton-agent");
const DEFAULT_DESCRIPTOR_PATH = path.join(
  DEFAULT_SIGNAL_DIRECTORY,
  "signal-ingress.json"
);
const DEFAULT_SECRET_PATH = path.join(
  DEFAULT_SIGNAL_DIRECTORY,
  "signal-ingress.secret"
);

function installedDiscoveryPaths() {
  try {
    const config = require("./agent_signal_storage.js");
    if (
      config.version !== 1 ||
      typeof config.descriptorPath !== "string" ||
      !path.isAbsolute(config.descriptorPath) ||
      config.descriptorPath.length > 4096 ||
      typeof config.secretPath !== "string" ||
      !path.isAbsolute(config.secretPath) ||
      config.secretPath.length > 4096
    ) {
      throw new Error("invalid installed producer discovery configuration");
    }
    return config;
  } catch (error) {
    if (
      error.code !== "MODULE_NOT_FOUND" ||
      !String(error.message).includes("./agent_signal_storage.js")
    )
      throw error;
    return null;
  }
}

async function defaultReadText(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > DEFAULT_MAX_FRAME_BYTES)
      throw new Error(
        "discovery and credential files must be bounded regular files"
      );
    const buffer = Buffer.alloc(DEFAULT_MAX_FRAME_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > DEFAULT_MAX_FRAME_BYTES)
      throw new Error("discovery and credential files exceed read bounds");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

function boundedMessage(value, maxLength = 240) {
  return String(value)
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function encodedFrameBytes(encoded) {
  return Buffer.byteLength(encoded, "utf8") - 1;
}

function boundedRequiredString(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error(`${field} must contain 1 to 256 characters`);
  }
  return normalized;
}

function validateProducerIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("identity must be an object");
  }
  const canonicalPath = boundedRequiredString(
    value.canonicalPath,
    "canonicalPath"
  );
  const track = value.track;
  const device = value.device;
  if (!track || typeof track !== "object" || Array.isArray(track)) {
    throw new Error("track must be an object");
  }
  if (!device || typeof device !== "object" || Array.isArray(device)) {
    throw new Error("device must be an object");
  }
  const normalizedTrack = {
    id: boundedRequiredString(track.id, "track.id"),
    name: boundedRequiredString(track.name, "track.name")
  };
  if (track.index !== undefined && track.index !== null) {
    if (!Number.isInteger(track.index) || track.index < 0) {
      throw new Error("track.index must be a nonnegative integer");
    }
    normalizedTrack.index = track.index;
  }
  return {
    canonicalPath,
    track: normalizedTrack,
    device: {
      id: boundedRequiredString(device.id, "device.id"),
      name: boundedRequiredString(device.name, "device.name")
    }
  };
}

function producerIdForCanonicalPath(
  canonicalPath,
  prefix = "ableton-midi-capture"
) {
  const normalized = boundedRequiredString(canonicalPath, "canonicalPath");
  const digest = crypto
    .createHash("sha256")
    .update(`live-path-v1:${normalized}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${boundedRequiredString(prefix, "producerIdPrefix")}:path:${digest}`;
}

function validateDescriptor(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    value.protocol !== "newline-delimited-json" ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !Number.isInteger(value.maxFrameBytes) ||
    value.maxFrameBytes <= 0
  ) {
    throw new Error("invalid ingress descriptor");
  }
  if (
    value.secretPath !== undefined &&
    (typeof value.secretPath !== "string" ||
      !path.isAbsolute(value.secretPath) ||
      value.secretPath.length > 4096)
  )
    throw new Error("invalid ingress credential file reference");
  return value;
}

function sameListenerOwner(control, job) {
  return (
    !!job &&
    [
      "listenerId",
      "connectionId",
      "connectionEpoch",
      "generation",
      "mode",
      "jobId",
      "passId",
      "traceId",
      "correlationId",
      "causationId"
    ].every((key) => control[key] === job[key])
  );
}

class AgentSignalClient {
  constructor(options = {}) {
    const discovery = installedDiscoveryPaths();
    const audio = options.signalKind === "audio";
    this.onStatus = options.onStatus || (() => {});
    this.env = options.env || process.env;
    this.readText = options.readText || defaultReadText;
    this.createConnection =
      options.createConnection ||
      ((connectionOptions) => net.createConnection(connectionOptions));
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.descriptorPath =
      options.descriptorPath ||
      this.env[DEFAULT_DESCRIPTOR_ENV] ||
      discovery?.descriptorPath ||
      (audio ? null : DEFAULT_DESCRIPTOR_PATH);
    this.secret = options.secret || null;
    this.secretPath =
      options.secretPath ||
      this.env[DEFAULT_SECRET_PATH_ENV] ||
      discovery?.secretPath ||
      (audio ? null : DEFAULT_SECRET_PATH);
    this.configuredSecretPath = Boolean(
      options.secretPath ||
      this.env[DEFAULT_SECRET_PATH_ENV] ||
      discovery?.secretPath
    );
    this.legacyDiscovery =
      !audio &&
      !discovery &&
      !options.descriptorPath &&
      !this.env[DEFAULT_DESCRIPTOR_ENV];
    this.instanceId = options.instanceId || this.randomUUID();
    this.signalKind = options.signalKind || "midi";
    this.displayName =
      options.displayName ||
      (this.signalKind === "audio" ? "Audio Listener" : "Midi-Capture");
    this.listener = options.listener || null;
    if (
      this.listener &&
      (this.signalKind !== "audio" || this.listener.version !== 5)
    )
      throw new Error("Only canonical metric5 audio listening is supported");
    this.metricProtocol = this.listener ? loadMetricProtocol() : null;
    this.listenerVersion = this.listener?.version;
    this.schemaVersion =
      options.schemaVersion ||
      this.metricProtocol?.LISTENER_METRIC_PRODUCER_SCHEMA_VERSION ||
      (audio ? "audio-reference/v1" : "midi-sample/v1");
    if (
      !this.listener &&
      /^(?:metric-)?audio-observation\//u.test(this.schemaVersion)
    )
      throw new Error(
        "Audio observation delivery requires a canonical metric5 listener"
      );
    this.producerIdPrefix =
      options.producerIdPrefix ||
      (audio ? "ableton-audio-listener" : "ableton-midi-capture");
    this.metricPhase = null;
    this.metricControls = new Map();
    this.listenerControlSequence = -1;
    this.onListenerControl = options.onListenerControl || (() => {});
    this.onListenerFailure = options.onListenerFailure || (() => {});
    this.listenerSequence = 0;
    this.listenerJob = null;
    this.listenerControlIds = new Set();
    this.listenerJobControlIds = new Set();
    this.notifyingListenerFailure = false;
    if (this.metricProtocol) {
      for (const field of [
        "instanceId",
        "displayName",
        "signalKind",
        "schemaVersion"
      ])
        this[field] = this.metricProtocol.listenerMetricProducerSchema.shape[
          field
        ].parse(this[field]);
      this.listener = parseMetricData(
        this.metricProtocol.listenerRegistrationMetricSchema,
        this.listener
      );
      if (
        !this.listener.nativeStatus.acceptedSampleRates.includes(
          this.listener.sampleRate
        ) ||
        !this.listener.nativeStatus.acceptedVectorSizes.includes(
          this.listener.vectorSize
        )
      )
        throw new Error("invalid native metric DSP registration");
    }
    this.producer = null;
    this.maxOfflineSamples = options.maxOfflineSamples || 32;
    this.maxPendingRequests = options.maxPendingRequests || 64;
    this.heartbeatMs = options.heartbeatMs || 5000;
    this.reconnectInitialMs = options.reconnectInitialMs || 250;
    this.reconnectMaxMs = options.reconnectMaxMs || 10000;
    this.configuredMaxFrameBytes =
      options.maxFrameBytes ||
      this.metricProtocol?.MAX_METRIC_RESULT_FRAME_BYTES ||
      DEFAULT_MAX_FRAME_BYTES;
    this.started = false;
    this.stopping = false;
    this.authenticated = false;
    this.socket = null;
    this.buffer = "";
    this.connectionId = null;
    this.sequence = 0;
    this.requestSequence = 0;
    this.offlineQueue = [];
    this.pending = new Map();
    this.writeDrain = null;
    this.writeQueue = [];
    this.writeQueueBytes = 0;
    this.failedWriteSocket = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectDelay = this.reconnectInitialMs;
    this.lastStatus = null;
    this.writeDiagnosticEvents = [];
    this.writeDiagnosticGaps = { overflow: 0, expired: 0, unsupported: 0 };
    this.writeDiagnosticBatches = new Map();
    this.writeDiagnosticsSupported = null;
    this.writeDiagnosticOrder = 0;
    this.onWriteDiagnostic =
      options.onWriteDiagnostic ||
      ((event) => this.collectWriteDiagnostic(event));
  }

  configureProducer(identity) {
    if (this.started || this.stopping) {
      throw new Error("producer identity cannot change after startup");
    }
    const normalized = validateProducerIdentity(identity);
    const producer = {
      producerId: producerIdForCanonicalPath(
        normalized.canonicalPath,
        this.producerIdPrefix
      ),
      instanceId: this.instanceId,
      displayName: this.displayName,
      signalKind: this.signalKind,
      schemaVersion: this.schemaVersion,
      track: normalized.track,
      device: normalized.device
    };
    this.producer = this.metricProtocol
      ? parseMetricData(
          this.metricProtocol.listenerMetricProducerSchema,
          producer
        )
      : producer;
    return this.producer;
  }

  start() {
    if (this.started || this.stopping) {
      return;
    }
    if (!this.producer) {
      throw new Error("producer identity must be configured before startup");
    }
    this.started = true;
    if (this.legacyDiscovery)
      this.emitStatus("live", "legacy_discovery", DEFAULT_DESCRIPTOR_PATH);
    this.emitStatus("live", "starting");
    void this.connect();
  }

  isConnected() {
    return this.authenticated;
  }

  sendSample(sample, capturedAt = this.now()) {
    if (this.stopping) {
      return false;
    }
    if (this.listener && this.authenticated) {
      this.listenerFailure("listener_result_required");
      return false;
    }
    const queued = { sample, capturedAt: Math.max(0, Math.floor(capturedAt)) };
    if (!this.authenticated || !this.socket) {
      this.enqueue(queued);
      return false;
    }
    return this.sendQueuedSample(queued);
  }

  enqueue(item) {
    if (this.signalKind === "audio") {
      this.listenerFailure("offline_audio_not_replayed");
      return;
    }
    if (this.offlineQueue.length >= this.maxOfflineSamples) {
      this.offlineQueue.shift();
      this.emitStatus("live", "queue_coalesced", this.maxOfflineSamples);
    }
    this.offlineQueue.push(item);
  }

  async connect() {
    if (!this.started || this.stopping || this.socket) {
      return;
    }
    let descriptor;
    let secret;
    try {
      descriptor = await this.loadDescriptor();
      secret = await this.loadSecret(descriptor);
      this.loadedSecret = secret;
    } catch (error) {
      this.emitStatus("live", "unavailable", boundedMessage(error.message));
      this.scheduleReconnect();
      return;
    }
    if (!this.started || this.stopping) {
      return;
    }

    let socket;
    try {
      socket = this.createConnection({
        host: descriptor.host,
        port: descriptor.port
      });
    } catch (error) {
      this.emitStatus("live", "socket_error", boundedMessage(error.message));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    if (this.signalKind === "audio" && !this.listener)
      this.transportEpoch = this.randomUUID();
    this.writeDiagnosticsSupported = null;
    this.failedWriteSocket = null;
    if (this.listener) {
      this.listener = parseMetricData(
        this.metricProtocol.listenerRegistrationMetricSchema,
        {
          ...this.listener,
          connectionEpoch: this.randomUUID(),
          nativeStatus: {
            ...this.listener.nativeStatus,
            readiness: "BLOCKED",
            reason: "fresh_per_pass_native_validation_required",
            executedGen: null
          }
        }
      );
      this.metricPhase = null;
      this.metricControls.clear();
      this.listenerControlSequence = -1;
      this.listenerSequence = 0;
      this.listenerJob = null;
      this.listenerControlIds.clear();
      this.listenerJobControlIds.clear();
    }
    this.descriptor = descriptor;
    this.buffer = "";
    socket.setEncoding?.("utf8");
    socket.on("connect", () => {
      if (socket !== this.socket || this.stopping) {
        return;
      }
      this.emitStatus("live", "authenticating");
      const sent = this.writeMessage({
        type: "producer.hello",
        protocolVersion: PROTOCOL_VERSION,
        requestId: this.nextRequestId("hello"),
        secret,
        producer: this.producer,
        ...(this.listener ? { listener: this.listener } : {})
      });
      if (!sent) {
        socket.destroy();
      }
    });
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => {
      this.emitStatus("live", "socket_error", boundedMessage(error.message));
    });
    socket.on("close", () => this.handleClose(socket));
  }

  async loadDescriptor() {
    if (!this.descriptorPath) {
      throw new Error(`${DEFAULT_DESCRIPTOR_ENV} is not configured`);
    }
    const text = await this.readText(this.descriptorPath);
    if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_FRAME_BYTES)
      throw new Error("ingress descriptor exceeds read bounds");
    const descriptor = validateDescriptor(JSON.parse(text));
    if (
      this.listener &&
      (!Array.isArray(descriptor.listenerVersions) ||
        !Array.isArray(descriptor.listenerCapabilities) ||
        !descriptor.listenerVersions?.includes(this.listenerVersion) ||
        !this.listener.capabilities.every((capability) =>
          descriptor.listenerCapabilities?.includes(capability)
        ))
    ) {
      throw new Error("listener capability is not advertised by ingress");
    }
    return descriptor;
  }

  async loadSecret(descriptor) {
    const secretPath =
      !this.configuredSecretPath && descriptor?.secretPath
        ? descriptor.secretPath
        : this.secretPath;
    let secret =
      this.secret ||
      this.env[DEFAULT_SECRET_ENV] ||
      (secretPath ? (await this.readText(secretPath)).trim() : "");
    if (Buffer.byteLength(secret, "utf8") > DEFAULT_MAX_FRAME_BYTES)
      throw new Error("signal ingress credential document exceeds read bounds");
    if (
      !this.secret &&
      !this.env[DEFAULT_SECRET_ENV] &&
      secret.startsWith("{")
    ) {
      let document;
      try {
        document = JSON.parse(secret);
      } catch {
        throw new Error("invalid signal ingress credential document");
      }
      const candidates = ["secret", "token"].filter(
        (key) => typeof document?.[key] === "string"
      );
      if (document?.version !== 1 || candidates.length !== 1)
        throw new Error("invalid signal ingress credential document");
      secret = document[candidates[0]];
    }
    if (
      typeof secret !== "string" ||
      secret.length < 32 ||
      secret.length > 4096
    ) {
      throw new Error("signal ingress secret is not configured");
    }
    return secret;
  }

  receive(chunk) {
    this.buffer += String(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes()) {
        this.emitStatus("live", "invalid_response", "frame_too_large");
        this.socket?.destroy();
        return;
      }
      if (line.length > 0) {
        this.handleResponse(line);
      }
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes()) {
      this.emitStatus("live", "invalid_response", "frame_too_large");
      this.socket?.destroy();
    }
  }

  handleResponse(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.emitStatus("live", "invalid_response", "malformed_json");
      this.socket?.destroy();
      return;
    }
    if (response?.type === "listener.control") {
      this.handleListenerControl(response);
      return;
    }
    if (
      !response ||
      response.protocolVersion !== PROTOCOL_VERSION ||
      (response.type !== "producer.ack" && response.type !== "producer.error")
    ) {
      this.emitStatus("live", "invalid_response", "invalid_message");
      this.socket?.destroy();
      return;
    }
    if (response.type === "producer.error") {
      const diagnostic = this.writeDiagnosticBatches.delete(response.requestId);
      if (this.signalKind === "audio" && !diagnostic)
        this.listenerFailure(response.code);
      this.emitStatus(
        "live",
        "server_error",
        boundedMessage(response.code),
        response.fatal ? "fatal" : "recoverable"
      );
      if (response.requestId) {
        this.pending.delete(response.requestId);
      }
      if (response.fatal) {
        this.socket?.destroy();
      }
      return;
    }

    const pendingAction = this.pending.get(response.requestId);
    this.pending.delete(response.requestId);
    if (pendingAction === "heartbeat" && response.action === "heartbeat") {
      const batch = this.writeDiagnosticBatches.get(response.requestId);
      if (batch) {
        this.writeDiagnosticBatches.delete(response.requestId);
        const ids = new Set(batch.eventIds);
        this.writeDiagnosticEvents = this.writeDiagnosticEvents.filter(
          (event) => !ids.has(event.eventId)
        );
        for (const key of Object.keys(this.writeDiagnosticGaps))
          this.writeDiagnosticGaps[key] = Math.max(
            0,
            this.writeDiagnosticGaps[key] - (batch.gaps?.[key] || 0)
          );
      }
    }
    if (response.action === "hello") {
      if (
        pendingAction !== "hello" ||
        typeof response.connectionId !== "string" ||
        response.connectionId.length === 0 ||
        (this.metricProtocol &&
          !this.metricProtocol.listenerMetricWireIdentitySchema.shape.connectionId.safeParse(
            response.connectionId
          ).success)
      ) {
        this.emitStatus("live", "invalid_response", "invalid_hello_ack");
        this.socket?.destroy();
        return;
      }
      if (
        this.listener &&
        (!Array.isArray(response.listenerCapabilities) ||
          !this.listener.capabilities.every((capability) =>
            response.listenerCapabilities.includes(capability)
          ))
      ) {
        this.emitStatus(
          "live",
          "invalid_response",
          "unsupported_listener_capability"
        );
        this.socket?.destroy();
        return;
      }
      this.authenticated = true;
      this.connectionId = response.connectionId;
      this.writeDiagnosticsSupported =
        Array.isArray(response.producerDiagnostics) &&
        response.producerDiagnostics.includes(WRITE_DIAGNOSTIC_SCHEMA);
      if (!this.writeDiagnosticsSupported) {
        this.writeDiagnosticGaps.unsupported = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.writeDiagnosticGaps.unsupported +
            this.writeDiagnosticEvents.length
        );
        this.writeDiagnosticEvents.length = 0;
        if (this.signalKind === "audio")
          this.emitStatus("live", "write_diagnostics", "unsupported");
      }
      this.reconnectDelay = this.reconnectInitialMs;
      this.emitStatus("live", "connected", response.connectionId);
      this.startHeartbeat();
      this.flushQueue();
    }
  }

  sendQueuedSample(item) {
    const requestId = this.nextRequestId("signal");
    const message = {
      type: "signal.frame",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      sequence: this.sequence,
      capturedAt: item.capturedAt,
      payload: item.sample
    };
    const encoded = `${JSON.stringify(message)}\n`;
    if (encodedFrameBytes(encoded) > this.maxFrameBytes()) {
      this.emitStatus("live", "sample_dropped", "frame_too_large");
      if (this.signalKind === "audio") {
        this.listenerFailure("frame_too_large");
        return false;
      }
      return true;
    }
    if (!this.writeEncoded(message, encoded)) {
      this.enqueue(item);
      return false;
    }
    this.sequence += 1;
    return true;
  }

  flushQueue() {
    while (this.authenticated && this.socket && this.offlineQueue.length > 0) {
      const item = this.offlineQueue.shift();
      if (!this.sendQueuedSample(item)) {
        break;
      }
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = this.setInterval(() => {
      if (!this.authenticated || !this.socket) {
        return;
      }
      const requestId = this.nextRequestId("heartbeat");
      const diagnostics = this.heartbeatDiagnostics(requestId);
      const message = {
        type: "producer.heartbeat",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ...(diagnostics ? { diagnostics } : {})
      };
      if (diagnostics)
        this.writeDiagnosticBatches.set(message.requestId, {
          sentAt: this.now(),
          eventIds: diagnostics.events.map((event) => event.eventId),
          gaps: diagnostics.gaps
        });
      if (!this.writeMessage(message))
        this.writeDiagnosticBatches.delete(message.requestId);
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  expireWriteDiagnostics() {
    const cutoff = this.now() - 60000;
    for (const [requestId, batch] of this.writeDiagnosticBatches)
      if (batch.sentAt <= cutoff) this.writeDiagnosticBatches.delete(requestId);
    const retained = this.writeDiagnosticEvents.filter(
      (event) => event.sourceTime > cutoff
    );
    const expired = this.writeDiagnosticEvents.length - retained.length;
    this.writeDiagnosticEvents = retained;
    if (expired) {
      this.writeDiagnosticGaps.expired = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.writeDiagnosticGaps.expired + expired
      );
      this.emitStatus("live", "write_diagnostics", "expired", expired);
    }
  }

  collectWriteDiagnostic(event) {
    const fields = [
      "eventId",
      "stage",
      "sourceTime",
      "order",
      "elapsedMs",
      "requestId",
      "originConnectionId",
      "connectionEpoch",
      "queueCount",
      "queueBytes",
      "reason"
    ];
    const optional = [
      "traceId",
      "correlationId",
      "causationId",
      "jobId",
      "passId",
      "writeReturn",
      "writableLength",
      "writableHighWaterMark"
    ];
    const identifier = (value) =>
      typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 128 &&
      ![this.loadedSecret, this.secret, this.env[DEFAULT_SECRET_ENV]].some(
        (secret) => secret && value.includes(secret)
      );
    if (this.stopping || this.signalKind !== "audio") return false;
    if (
      !event ||
      Object.keys(event).some(
        (key) => !fields.includes(key) && !optional.includes(key)
      ) ||
      fields.some((key) => event[key] === undefined) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        event.eventId
      ) ||
      ![
        "queued",
        "started",
        "progress",
        "completed",
        "failed",
        "cancelled"
      ].includes(event.stage) ||
      !WRITE_DIAGNOSTIC_REASONS.includes(event.reason) ||
      !["sourceTime", "order", "queueCount", "queueBytes"].every(
        (key) => Number.isSafeInteger(event[key]) && event[key] >= 0
      ) ||
      !Number.isFinite(event.elapsedMs) ||
      event.elapsedMs < 0 ||
      ![
        "requestId",
        "originConnectionId",
        "connectionEpoch",
        ...optional.slice(0, 5)
      ].every((key) => event[key] === undefined || identifier(event[key])) ||
      (event.writeReturn !== undefined &&
        typeof event.writeReturn !== "boolean") ||
      !["writableLength", "writableHighWaterMark"].every(
        (key) =>
          event[key] === undefined ||
          (Number.isSafeInteger(event[key]) && event[key] >= 0)
      )
    ) {
      this.writeDiagnosticGaps.invalid = Math.min(
        Number.MAX_SAFE_INTEGER,
        (this.writeDiagnosticGaps.invalid || 0) + 1
      );
      this.emitStatus(
        "live",
        "write_diagnostics",
        "invalid",
        this.writeDiagnosticGaps.invalid
      );
      return false;
    }
    this.expireWriteDiagnostics();
    if (this.writeDiagnosticsSupported === false) {
      this.writeDiagnosticGaps.unsupported = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.writeDiagnosticGaps.unsupported + 1
      );
      this.emitStatus(
        "live",
        "write_diagnostics",
        "unsupported",
        this.writeDiagnosticGaps.unsupported
      );
      return false;
    }
    if (
      this.writeDiagnosticEvents.some((item) => item.eventId === event.eventId)
    )
      return false;
    if (this.writeDiagnosticEvents.length >= 64) {
      this.writeDiagnosticEvents.shift();
      this.writeDiagnosticGaps.overflow = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.writeDiagnosticGaps.overflow + 1
      );
      this.emitStatus(
        "live",
        "write_diagnostics",
        "overflow",
        this.writeDiagnosticGaps.overflow
      );
    }
    this.writeDiagnosticEvents.push(Object.freeze({ ...event }));
    return true;
  }

  heartbeatDiagnostics(requestId = "x".repeat(128)) {
    this.expireWriteDiagnostics();
    if (
      !this.writeDiagnosticsSupported ||
      this.writeDrain ||
      this.writeQueue.length ||
      this.socket?.writableLength > 0 ||
      this.writeDiagnosticBatches.size
    )
      return null;
    const diagnostics = {
      schema: WRITE_DIAGNOSTIC_SCHEMA,
      events: [],
      ...(Object.values(this.writeDiagnosticGaps).some(Boolean)
        ? { gaps: { ...this.writeDiagnosticGaps } }
        : {})
    };
    for (const event of this.writeDiagnosticEvents.slice(0, 8)) {
      diagnostics.events.push(event);
      if (
        Buffer.byteLength(JSON.stringify(diagnostics), "utf8") > 8192 ||
        Buffer.byteLength(
          JSON.stringify({
            type: "producer.heartbeat",
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            diagnostics
          }),
          "utf8"
        ) +
          1 >
          this.maxFrameBytes()
      ) {
        diagnostics.events.pop();
        break;
      }
    }
    if (
      Buffer.byteLength(
        JSON.stringify({
          type: "producer.heartbeat",
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          diagnostics
        }),
        "utf8"
      ) +
        1 >
      this.maxFrameBytes()
    )
      return null;
    return diagnostics.events.length || diagnostics.gaps ? diagnostics : null;
  }

  writeMessage(message) {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }
    const encoded = `${JSON.stringify(message)}\n`;
    if (encodedFrameBytes(encoded) > this.maxFrameBytes()) {
      this.pending.delete(message.requestId);
      this.emitStatus("live", "sample_dropped", "frame_too_large");
      return false;
    }
    return this.writeEncoded(message, encoded);
  }

  writeEncoded(message, encoded) {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }
    if (this.pending.size >= this.maxPendingRequests) {
      this.emitStatus("live", "backpressure", this.maxPendingRequests);
      this.clearWriteDrain("failed", "pending_quota_exceeded");
      this.socket.destroy();
      return false;
    }
    const queued = this.writeDrain !== null || this.writeQueue.length > 0;
    if (
      queued &&
      this.writeQueueBytes +
        this.socket.writableLength +
        Buffer.byteLength(encoded, "utf8") >
        this.maxFrameBytes() * 2
    ) {
      this.failWrite(this.socket, "outbound_queue_quota_exceeded");
      return false;
    }
    this.pending.set(message.requestId, message.type.replace("producer.", ""));
    const context = {
      requestId: message.requestId,
      traceId: message.traceId,
      correlationId: message.correlationId,
      causationId: message.causationId,
      jobId: message.jobId,
      passId: message.passId,
      originConnectionId: this.connectionId,
      connectionEpoch:
        message.connectionEpoch ||
        this.listener?.connectionEpoch ||
        this.transportEpoch,
      diagnostic: message.diagnostics !== undefined
    };
    if (queued) {
      this.writeQueue.push({ context, encoded });
      this.writeQueueBytes += Buffer.byteLength(encoded, "utf8");
      if (this.writeDrain) this.writeDrainStatus("progress", this.writeDrain);
      return true;
    }
    return this.writeAccepted(this.socket, context, encoded);
  }

  writeAccepted(socket, context, encoded) {
    try {
      const writable =
        this.signalKind === "audio"
          ? socket.write(encoded, (error) => {
              if (error) this.failWrite(socket, "outbound_write_failed", error);
            })
          : socket.write(encoded);
      context.writeReturn = writable;
      if (Number.isSafeInteger(socket.writableLength))
        context.writableLength = socket.writableLength;
      if (Number.isSafeInteger(socket.writableHighWaterMark))
        context.writableHighWaterMark = socket.writableHighWaterMark;
      // false accepts this frame; only subsequent frames wait for drain.
      if (
        !writable &&
        this.signalKind === "audio" &&
        !this.stopping &&
        !socket.destroyed &&
        socket === this.socket
      )
        this.waitForDrain(socket, context);
      return true;
    } catch (error) {
      this.pending.delete(context.requestId);
      this.emitStatus("live", "socket_error", boundedMessage(error.message));
      if (this.signalKind === "audio")
        this.failWrite(socket, "outbound_write_failed", error);
      else socket.destroy();
      return false;
    }
  }

  waitForDrain(socket, context) {
    const drain = {
      socket,
      context,
      startedAt: this.now(),
      onDrain: () => {
        if (this.writeDrain !== drain || socket !== this.socket) return;
        this.clearWriteDrain("completed");
        while (
          this.writeQueue.length > 0 &&
          !this.writeDrain &&
          socket === this.socket &&
          !socket.destroyed &&
          !this.stopping
        ) {
          const queued = this.writeQueue.shift();
          this.writeQueueBytes -= Buffer.byteLength(queued.encoded, "utf8");
          if (!this.writeAccepted(socket, queued.context, queued.encoded))
            break;
        }
      },
      onClose: () => this.failWrite(socket, "disconnected"),
      onError: (error) => this.failWrite(socket, "outbound_write_failed", error)
    };
    this.writeDrain = drain;
    socket.once("drain", drain.onDrain);
    socket.once("close", drain.onClose);
    socket.once("error", drain.onError);
    drain.timer = this.setTimeout(() => {
      if (this.writeDrain === drain)
        this.failWrite(socket, "outbound_drain_timeout");
    }, OUTBOUND_DRAIN_TIMEOUT_MS);
    drain.timer.unref?.();
    this.writeDrainStatus("queued", drain);
    if (this.writeDrain === drain) this.writeDrainStatus("started", drain);
  }

  writeDrainStatus(stage, drain, reason = "") {
    const context = drain.context;
    if (context.diagnostic) return;
    if (
      !context.diagnostic &&
      context.originConnectionId &&
      context.connectionEpoch
    ) {
      const event = {
        eventId: this.randomUUID(),
        stage,
        sourceTime: Math.max(0, Math.floor(this.now())),
        order: this.writeDiagnosticOrder++,
        elapsedMs: Math.max(0, this.now() - drain.startedAt),
        requestId: context.requestId,
        originConnectionId: context.originConnectionId,
        connectionEpoch: context.connectionEpoch,
        queueCount: this.writeQueue.length,
        queueBytes: this.writeQueueBytes,
        reason:
          reason || (stage === "completed" ? "drain" : "write_backpressure"),
        writeReturn: context.writeReturn
      };
      for (const key of [
        "traceId",
        "correlationId",
        "causationId",
        "jobId",
        "passId"
      ])
        if (context[key] !== undefined) event[key] = context[key];
      for (const key of ["writableLength", "writableHighWaterMark"])
        if (Number.isSafeInteger(drain.socket[key]) && drain.socket[key] >= 0)
          event[key] = drain.socket[key];
      try {
        this.onWriteDiagnostic(Object.freeze(event));
      } catch {
        this.writeDiagnosticGaps.invalid = Math.min(
          Number.MAX_SAFE_INTEGER,
          (this.writeDiagnosticGaps.invalid || 0) + 1
        );
        this.emitStatus("live", "write_diagnostics", "callback_failed");
      }
    }
    this.emitStatus(
      "live",
      "write_backpressure",
      stage,
      context.requestId,
      context.traceId || "",
      context.correlationId || "",
      context.causationId || "",
      context.jobId || "",
      context.passId || "",
      Math.max(0, this.now() - drain.startedAt),
      this.writeQueue.length,
      this.writeQueueBytes,
      reason
    );
  }

  clearWriteDrain(stage, reason) {
    const drain = this.writeDrain;
    this.writeDrain = null;
    if (drain) {
      this.clearTimeout(drain.timer);
      drain.socket.off("drain", drain.onDrain);
      drain.socket.off("close", drain.onClose);
      drain.socket.off("error", drain.onError);
      this.writeDrainStatus(stage, drain, reason);
    }
    if (stage !== "completed") {
      for (const queued of this.writeQueue)
        this.pending.delete(queued.context.requestId);
      this.writeQueue.length = 0;
      this.writeQueueBytes = 0;
    }
  }

  failWrite(socket, reason, error) {
    if (socket !== this.socket || this.failedWriteSocket === socket) return;
    this.failedWriteSocket = socket;
    this.clearWriteDrain("failed", reason);
    this.pending.clear();
    this.writeDiagnosticBatches.clear();
    if (error)
      this.emitStatus("live", "socket_error", this.listenerErrorReason(error));
    socket.destroy();
    this.listenerFailure(reason);
  }

  maxFrameBytes() {
    return Math.min(
      this.metricProtocol?.MAX_METRIC_RESULT_FRAME_BYTES || Infinity,
      this.descriptor?.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES,
      this.configuredMaxFrameBytes
    );
  }

  nextRequestId(prefix) {
    const value = `${prefix}-${this.requestSequence}`;
    this.requestSequence += 1;
    return value;
  }

  handleClose(socket) {
    if (socket !== this.socket) {
      return;
    }
    this.clearWriteDrain(
      this.stopping ? "cancelled" : "failed",
      "disconnected"
    );
    this.socket = null;
    this.failedWriteSocket = null;
    this.authenticated = false;
    this.connectionId = null;
    this.buffer = "";
    this.pending.clear();
    this.writeDiagnosticBatches.clear();
    this.stopHeartbeat();
    if (this.listenerJob) this.listenerFailure("disconnected");
    this.listenerJob = null;
    this.metricPhase = null;
    this.metricControls.clear();
    this.listenerJobControlIds.clear();
    if (!this.stopping) {
      this.emitStatus("live", "disconnected");
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.started || this.stopping || this.reconnectTimer || this.socket) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.reconnectMaxMs
    );
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  emitStatus(...items) {
    const secret =
      this.loadedSecret || this.secret || this.env[DEFAULT_SECRET_ENV];
    const bounded = items.map((item) => {
      const text = String(item);
      return boundedMessage(
        secret ? text.split(secret).join("[REDACTED]") : text
      );
    });
    const key = bounded.join("\u0000");
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    if (bounded[1] === "write_diagnostics") {
      try {
        this.onStatus(...bounded);
      } catch {
        process.emitWarning(
          "Producer write diagnostic status callback failed; observability coverage may be incomplete",
          {
            code: "ABLETON_WRITE_DIAGNOSTIC_STATUS"
          }
        );
      }
    } else this.onStatus(...bounded);
  }

  listenerFailure(reason, diagnostic) {
    this.emitStatus("live", "listener_partial", reason);
    if (this.notifyingListenerFailure) return;
    this.notifyingListenerFailure = true;
    try {
      this.onListenerFailure(
        this.listenerErrorReason({ message: reason }),
        this.listenerJob,
        diagnostic
      );
    } catch {
      this.emitStatus("live", "listener_failure_handler_error");
    } finally {
      this.notifyingListenerFailure = false;
    }
  }

  handleListenerControl(control) {
    if (!this.metricProtocol || !this.authenticated || this.stopping) {
      this.listenerFailure("invalid_metric_control");
      this.socket?.destroy();
      return;
    }
    try {
      control = parseMetricData(
        this.metricProtocol.listenerControlMetricSchema,
        control
      );
      if (
        control.listenerId !== this.producer?.producerId ||
        control.connectionId !== this.connectionId ||
        control.connectionEpoch !== this.listener.connectionEpoch ||
        control.sequence <= this.listenerControlSequence ||
        Buffer.byteLength(JSON.stringify(control), "utf8") >
          this.maxFrameBytes() ||
        (control.config &&
          (control.config.geometry.sampleRate !== this.listener.sampleRate ||
            control.config.geometry.vectorSize !== this.listener.vectorSize))
      )
        throw new Error("metric_listener_control_binding");
    } catch {
      this.listenerFailure("invalid_metric_control");
      this.socket?.destroy();
      return;
    }
    if (this.listenerControlIds.has(control.requestId)) {
      this.listenerFailure("invalid_control_bounds");
      this.socket?.destroy();
      return;
    }
    if (this.listenerControlIds.size >= 64)
      this.listenerControlIds.delete(
        this.listenerControlIds.values().next().value
      );
    this.listenerControlIds.add(control.requestId);
    this.listenerControlSequence = control.sequence;
    if (control.action === "prepare") {
      if (this.listenerJob) {
        this.sendListenerMessage(
          "listener.reply",
          control,
          { status: "failed", reason: "listener_busy" },
          false
        );
        return;
      }
      this.listenerJob = control;
      this.listenerJobControlIds.clear();
      this.metricControls.clear();
      this.metricPhase = {
        ready: null,
        armed: null,
        launched: null,
        armRequestId: null,
        cancelling: false,
        cancelRequestId: null,
        cancelledResultDelivered: false,
        emittedEpoch: null
      };
    } else if (!sameListenerOwner(control, this.listenerJob)) {
      this.sendListenerMessage(
        "listener.reply",
        control,
        { status: "failed", reason: "ownership_mismatch" },
        false
      );
      return;
    }
    if (this.listenerJobControlIds.size >= 64) {
      this.listenerFailure("listener_control_quota_exceeded");
      this.socket?.destroy();
      return;
    }
    if (control.action !== "prepare") {
      if (
        this.metricPhase.cancelling ||
        (control.action === "arm" &&
          (!this.metricPhase.ready || this.metricPhase.armRequestId !== null))
      ) {
        this.sendListenerMessage(
          "listener.reply",
          control,
          { status: "failed", reason: "invalid_metric_phase" },
          false
        );
        return;
      }
      if (control.action === "arm")
        this.metricPhase.armRequestId = control.requestId;
      if (control.action === "cancel") {
        this.metricPhase.cancelling = true;
        this.metricPhase.cancelRequestId = control.requestId;
      }
    }
    this.listenerJobControlIds.add(control.requestId);
    this.metricControls.set(control.requestId, control);
    try {
      const result = this.onListenerControl(control);
      if (result && typeof result.then === "function") {
        result.catch((error) =>
          this.sendListenerReply(control, {
            status: "failed",
            reason: this.listenerErrorReason(error)
          })
        );
      }
    } catch (error) {
      this.sendListenerReply(control, {
        status: "failed",
        reason: this.listenerErrorReason(error)
      });
    }
  }

  sendListenerReply(control, reply) {
    return this.sendListenerMessage("listener.reply", control, reply);
  }

  sendListenerResult(control, result) {
    return this.sendListenerMessage("listener.result", control, result);
  }
  sendListenerDiagnostic(control, nativeLifecycle) {
    try {
      return this.sendListenerMessage(
        "listener.result",
        control,
        { status: "progress", nativeLifecycle },
        true,
        true
      );
    } catch {
      this.emitStatus(
        "live",
        "native_diagnostic_gap",
        "listener_diagnostic_exception"
      );
      return false;
    }
  }

  listenerErrorReason(error) {
    const secret =
      this.loadedSecret || this.secret || this.env[DEFAULT_SECRET_ENV];
    const text = String(error?.message ?? "listener_callback_failed");
    return (
      boundedMessage(
        this.listener && secret ? text.split(secret).join("[REDACTED]") : text
      ) || "listener_callback_failed"
    );
  }

  sendMetricListenerMessage(
    type,
    control,
    payload,
    releaseJob,
    deliveryFailure
  ) {
    const codec = this.metricProtocol;
    const job = this.listenerJob;
    const phase = this.metricPhase;
    let message, ready, armed, launched;
    try {
      control = parseMetricData(codec.listenerControlMetricSchema, control);
      const admitted = this.metricControls.get(control.requestId);
      const owned =
        sameListenerOwner(control, job) &&
        admitted !== undefined &&
        JSON.stringify(admitted) === JSON.stringify(control);
      const detachedFailure =
        !releaseJob &&
        type === "listener.reply" &&
        payload?.status === "failed";
      if (
        this.stopping ||
        control.listenerId !== this.producer?.producerId ||
        control.connectionId !== this.connectionId ||
        (!owned && !detachedFailure)
      ) {
        this.emitStatus(
          "live",
          "listener_message_rejected",
          "invalid_listener_context"
        );
        return false;
      }
      if (
        owned &&
        phase?.cancelling &&
        ((type === "listener.reply" &&
          control.requestId !== phase.cancelRequestId) ||
          !["failed", "cancelled"].includes(payload?.status) ||
          (type === "listener.result" &&
            payload?.status === "cancelled" &&
            phase.cancelledResultDelivered))
      ) {
        this.emitStatus(
          "live",
          "listener_message_rejected",
          "cancel_in_progress"
        );
        return false;
      }
      const identity = parseMetricData(codec.listenerMetricWireIdentitySchema, {
        protocolVersion: PROTOCOL_VERSION,
        listenerVersion: codec.LISTENER_VERSION_METRIC,
        mode: control.mode,
        listenerId: control.listenerId,
        connectionId: control.connectionId,
        connectionEpoch: control.connectionEpoch,
        generation: control.generation,
        jobId: control.jobId,
        passId: control.passId,
        traceId: control.traceId,
        correlationId: control.correlationId,
        causationId: control.causationId,
        requestId:
          type === "listener.reply"
            ? control.requestId
            : this.nextRequestId("listener"),
        sequence: this.listenerSequence
      });
      message = parseMetricData(
        type === "listener.reply"
          ? codec.listenerReplyMetricSchema
          : codec.listenerResultMetricSchema,
        { ...payload, ...identity, type }
      );
      if (
        !["listener.reply", "listener.result"].includes(type) ||
        (type === "listener.reply" &&
          message.status !== "failed" &&
          message.status !==
            { prepare: "ready", arm: "armed", cancel: "cancelled" }[
              control.action
            ])
      )
        throw new Error("invalid_metric_phase");
      const expected = (nativeEpoch) =>
        codec.snapshotNativeMetricListeningExpectation({
          listenerId: job.listenerId,
          passId: job.passId,
          connectionId: job.connectionId,
          connectionEpoch: job.connectionEpoch,
          generation: job.generation,
          traceId: job.traceId,
          correlationId: job.correlationId,
          causationId: job.causationId,
          config: job.config,
          nativeEpoch
        });
      if (message.nativeReady) {
        if (phase.ready || phase.armRequestId !== null)
          throw new Error("metric_ready_already_delivered");
        ready = codec.assertNativeMetricReadyProof(
          message.nativeReady,
          expected(message.nativeReady.ownership.nativeEpoch)
        );
        if (
          phase.emittedEpoch !== null &&
          phase.emittedEpoch !== ready.ownership.nativeEpoch
        )
          throw new Error("metric_ready_reservation_mismatch");
      }
      if (message.nativeArm) {
        if (
          !phase.ready ||
          phase.armed ||
          phase.armRequestId !== control.requestId
        )
          throw new Error("metric_arm_without_ready");
        armed = codec.assertNativeMetricArmProof(
          message.nativeArm,
          expected(phase.ready.ownership.nativeEpoch)
        );
      }
      if (message.nativeLaunch) {
        if (!phase.armed || phase.launched)
          throw new Error("metric_launch_without_arm");
        codec.nativeMetricLaunchCoordinates(
          phase.armed,
          message.nativeLaunch,
          expected(phase.ready.ownership.nativeEpoch)
        );
        launched = message.nativeLaunch;
      }
      if (message.nativeLifecycle) {
        const nativeEpoch =
          phase.ready?.ownership.nativeEpoch ?? phase.emittedEpoch;
        if (
          nativeEpoch !== null &&
          message.nativeLifecycle.nativeEpoch !== nativeEpoch
        )
          throw new Error("metric_lifecycle_reservation_mismatch");
      }
      if (message.nativeSourceCoverage) {
        if (
          !phase.armed ||
          !phase.launched ||
          JSON.stringify(message.nativeSourceCoverage.armed) !==
            JSON.stringify(phase.armed) ||
          JSON.stringify(message.nativeSourceCoverage.launched) !==
            JSON.stringify(phase.launched)
        )
          throw new Error("metric_source_without_pinned_arm_launch");
        codec.assertNativeMetricObservationSource(
          message.nativeSourceCoverage,
          message.observation,
          expected(phase.ready.ownership.nativeEpoch)
        );
      }
    } catch {
      deliveryFailure("invalid_metric_listener_payload");
      return false;
    }
    const socket = this.socket;
    const encoded = `${JSON.stringify(message)}\n`;
    if (encodedFrameBytes(encoded) > this.maxFrameBytes()) {
      deliveryFailure("listener_frame_too_large", encodedFrameBytes(encoded));
      return false;
    }
    const sent = this.writeEncoded(message, encoded);
    if (
      !sent ||
      socket !== this.socket ||
      socket.destroyed ||
      this.failedWriteSocket === socket
    ) {
      deliveryFailure("listener_delivery_failed", encodedFrameBytes(encoded));
      return false;
    }
    this.listenerSequence += 1;
    if (
      job === this.listenerJob &&
      phase === this.metricPhase &&
      phase &&
      socket === this.socket &&
      !socket.destroyed
    ) {
      if (ready) phase.ready = ready;
      if (armed) phase.armed = armed;
      if (launched) phase.launched = launched;
      if (message.nativeLifecycle)
        phase.emittedEpoch = message.nativeLifecycle.nativeEpoch;
      const awaitingCancelReply =
        phase.cancelling &&
        type === "listener.result" &&
        message.status === "cancelled";
      if (awaitingCancelReply) phase.cancelledResultDelivered = true;
      if (
        releaseJob &&
        !awaitingCancelReply &&
        ((type === "listener.reply" &&
          ["cancelled", "failed"].includes(message.status)) ||
          (type === "listener.result" && message.status !== "progress"))
      ) {
        this.listenerJob = null;
        this.metricPhase = null;
        this.metricControls.clear();
        this.listenerJobControlIds.clear();
      }
    }
    return true;
  }

  sendListenerMessage(
    type,
    control,
    payload,
    releaseJob = true,
    diagnosticOnly = false
  ) {
    if (!this.metricProtocol) {
      this.listenerFailure("metric_listener_required");
      return false;
    }
    try {
      assertMetricData(control);
      assertMetricData(payload);
    } catch {
      this.listenerFailure("invalid_metric_listener_payload");
      return false;
    }
    if (
      control?.listenerVersion !== this.listenerVersion ||
      control?.listenerId !== this.producer?.producerId ||
      control?.connectionId !== this.connectionId ||
      control?.connectionEpoch !== this.listener.connectionEpoch
    ) {
      this.emitStatus(
        "live",
        "listener_message_rejected",
        "invalid_listener_context"
      );
      return false;
    }
    const deliveryFailure = (reason, encodedBytes = null) => {
      if (diagnosticOnly)
        return this.emitStatus("live", "native_diagnostic_gap", reason);
      let armGeometry;
      if (payload?.status === "armed") {
        const actual = payload.nativeArm?.config?.geometry?.totalSamples;
        const expected = this.listenerJob?.config?.geometry?.totalSamples;
        armGeometry = {
          field: "totalSamples",
          actual: Number.isFinite(actual) ? actual : null,
          expected: Number.isFinite(expected) ? expected : null
        };
      }
      this.listenerFailure(reason, {
        check: reason,
        messageType: ["listener.reply", "listener.result"].includes(type)
          ? type
          : "unknown",
        payloadStatus: [
          "ready",
          "armed",
          "cancelled",
          "failed",
          "progress",
          "completed",
          "partial"
        ].includes(payload?.status)
          ? payload.status
          : "unknown",
        connected: this.authenticated === true && !!this.socket,
        ownerMatches: !!control && sameListenerOwner(control, this.listenerJob),
        authenticated: this.authenticated === true,
        listenerPresent: !!this.listener,
        socketPresent: !!this.socket,
        epochMatches: control.connectionEpoch === this.listener.connectionEpoch,
        sequence: this.listenerSequence,
        encodedBytes,
        frameLimit: this.maxFrameBytes(),
        ...(armGeometry ? { armGeometry } : {})
      });
    };
    if (
      !this.authenticated ||
      !this.socket ||
      this.listenerSequence >= Number.MAX_SAFE_INTEGER
    ) {
      deliveryFailure("listener_not_connected");
      return false;
    }
    return this.sendMetricListenerMessage(
      type,
      control,
      payload,
      releaseJob,
      deliveryFailure
    );
  }

  stop() {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer) {
      this.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.clearWriteDrain("cancelled", "stopped");
    if (this.listenerJob) this.listenerFailure("stopped");
    this.listenerJob = null;
    this.metricPhase = null;
    this.metricControls.clear();
    this.listenerJobControlIds.clear();
    const socket = this.socket;
    if (socket && this.authenticated && !socket.destroyed) {
      this.writeMessage({
        type: "producer.disconnect",
        protocolVersion: PROTOCOL_VERSION,
        requestId: this.nextRequestId("disconnect")
      });
      socket.end();
    } else {
      socket?.destroy();
    }
    this.socket = null;
    this.failedWriteSocket = null;
    this.authenticated = false;
    this.connectionId = null;
    this.pending.clear();
    this.writeDiagnosticBatches.clear();
    this.writeDiagnosticEvents.length = 0;
    this.offlineQueue.length = 0;
    this.emitStatus("live", "stopped");
  }
}

module.exports = {
  AgentSignalClient,
  installedDiscoveryPaths,
  DEFAULT_DESCRIPTOR_ENV,
  DEFAULT_DESCRIPTOR_PATH,
  DEFAULT_SECRET_ENV,
  DEFAULT_SECRET_PATH,
  DEFAULT_SECRET_PATH_ENV,
  PROTOCOL_VERSION,
  producerIdForCanonicalPath,
  validateDescriptor,
  validateProducerIdentity
};
