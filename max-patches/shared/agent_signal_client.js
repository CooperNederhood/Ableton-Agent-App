/* global Buffer, clearInterval, clearTimeout, module, process, require, setInterval, setTimeout */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PROTOCOL_VERSION = 1;
const DEFAULT_MAX_FRAME_BYTES = 128 * 1024;
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

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function validDescriptiveConfig(config) {
  if (!hasExactKeys(config, ["geometry", "timingPolicy"])) return false;
  const geometry = config.geometry;
  const policy = config.timingPolicy;
  if (
    !hasExactKeys(geometry, [
      "sampleRate",
      "vectorSize",
      "tempoBpm",
      "startBeat",
      "endBeat",
      "hopSamples",
      "totalSamples"
    ]) ||
    !hasExactKeys(policy, ["mode", "maxClockDisagreementSamples"])
  )
    return false;
  return (
    [44100, 48000].includes(geometry.sampleRate) &&
    Number.isInteger(geometry.vectorSize) &&
    geometry.vectorSize >= 1 &&
    geometry.vectorSize <= 1024 &&
    (geometry.vectorSize & (geometry.vectorSize - 1)) === 0 &&
    Number.isFinite(geometry.tempoBpm) &&
    geometry.tempoBpm >= 20 &&
    geometry.tempoBpm <= 999 &&
    Number.isFinite(geometry.startBeat) &&
    geometry.startBeat >= 0 &&
    Number.isFinite(geometry.endBeat) &&
    geometry.endBeat > geometry.startBeat &&
    geometry.endBeat <= 1576800 &&
    geometry.hopSamples === Math.round(geometry.sampleRate / 10) &&
    Number.isSafeInteger(geometry.totalSamples) &&
    geometry.totalSamples >= geometry.hopSamples &&
    geometry.totalSamples <= geometry.sampleRate * 30 &&
    geometry.totalSamples ===
      Math.round(
        ((geometry.endBeat - geometry.startBeat) * geometry.sampleRate * 60) /
          geometry.tempoBpm
      ) &&
    Number.isInteger(policy.maxClockDisagreementSamples) &&
    policy.maxClockDisagreementSamples >= 0 &&
    policy.maxClockDisagreementSamples <= 480 &&
    (policy.mode === "descriptive" ||
      (policy.mode === "strict" && policy.maxClockDisagreementSamples === 0))
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
    this.schemaVersion =
      options.schemaVersion ||
      (this.signalKind === "audio"
        ? options.listener
          ? "audio-observation/v1"
          : "audio-reference/v1"
        : "midi-sample/v1");
    this.producerIdPrefix =
      options.producerIdPrefix ||
      (this.signalKind === "audio"
        ? "ableton-audio-listener"
        : "ableton-midi-capture");
    this.listener = options.listener || null;
    this.listenerVersion = this.listener?.version;
    this.onListenerControl = options.onListenerControl || (() => {});
    this.onListenerFailure = options.onListenerFailure || (() => {});
    this.listenerSequence = 0;
    this.listenerJob = null;
    this.listenerControlIds = new Set();
    this.notifyingListenerFailure = false;
    if (
      this.listener &&
      (this.signalKind !== "audio" ||
        ![1, 2].includes(this.listenerVersion) ||
        this.schemaVersion !== `audio-observation/v${this.listenerVersion}` ||
        !Array.isArray(this.listener.capabilities) ||
        this.listener.capabilities.length !== 1 ||
        this.listener.capabilities[0] !==
          `audio-listener/v${this.listenerVersion}`)
    ) {
      throw new Error(
        "listener capability requires matching audio-observation version"
      );
    }
    this.producer = null;
    this.maxOfflineSamples = options.maxOfflineSamples || 32;
    this.maxPendingRequests = options.maxPendingRequests || 64;
    this.heartbeatMs = options.heartbeatMs || 5000;
    this.reconnectInitialMs = options.reconnectInitialMs || 250;
    this.reconnectMaxMs = options.reconnectMaxMs || 10000;
    this.configuredMaxFrameBytes =
      options.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES;
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
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectDelay = this.reconnectInitialMs;
    this.lastStatus = null;
  }

  configureProducer(identity) {
    if (this.started || this.stopping) {
      throw new Error("producer identity cannot change after startup");
    }
    const normalized = validateProducerIdentity(identity);
    this.producer = {
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
    if (this.listener) {
      this.listener = { ...this.listener, connectionEpoch: this.randomUUID() };
      this.listenerSequence = 0;
      this.listenerJob = null;
      this.listenerControlIds.clear();
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
      (!descriptor.listenerVersions?.includes(this.listenerVersion) ||
        !descriptor.listenerCapabilities?.includes(
          `audio-listener/v${this.listenerVersion}`
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
      if (this.signalKind === "audio") this.listenerFailure(response.code);
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
    if (response.action === "hello") {
      if (
        pendingAction !== "hello" ||
        typeof response.connectionId !== "string" ||
        response.connectionId.length === 0
      ) {
        this.emitStatus("live", "invalid_response", "invalid_hello_ack");
        this.socket?.destroy();
        return;
      }
      this.authenticated = true;
      this.connectionId = response.connectionId;
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
      this.writeMessage({
        type: "producer.heartbeat",
        protocolVersion: PROTOCOL_VERSION,
        requestId: this.nextRequestId("heartbeat")
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
      this.socket.destroy();
      return false;
    }
    this.pending.set(message.requestId, message.type.replace("producer.", ""));
    try {
      const writable = this.socket.write(encoded);
      if (!writable && this.signalKind === "audio") {
        this.listenerFailure("backpressure");
        this.socket.destroy();
        return false;
      }
      return true;
    } catch (error) {
      this.pending.delete(message.requestId);
      this.emitStatus("live", "socket_error", boundedMessage(error.message));
      this.socket.destroy();
      return false;
    }
  }

  maxFrameBytes() {
    return Math.min(
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
    this.socket = null;
    this.authenticated = false;
    this.connectionId = null;
    this.buffer = "";
    this.pending.clear();
    this.stopHeartbeat();
    if (this.listenerJob) this.listenerFailure("disconnected");
    this.listenerJob = null;
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
    this.onStatus(...bounded);
  }

  listenerFailure(reason) {
    this.emitStatus("live", "listener_partial", reason);
    if (this.notifyingListenerFailure) return;
    this.notifyingListenerFailure = true;
    try {
      this.onListenerFailure(boundedMessage(reason), this.listenerJob);
    } catch {
      this.emitStatus("live", "listener_failure_handler_error");
    } finally {
      this.notifyingListenerFailure = false;
    }
  }

  handleListenerControl(control) {
    const keys = [
      "requestId",
      "connectionEpoch",
      "jobId",
      "passId",
      "traceId",
      "correlationId",
      "causationId"
    ];
    if (
      !this.authenticated ||
      !this.listener ||
      control.protocolVersion !== PROTOCOL_VERSION ||
      control.listenerVersion !== this.listenerVersion ||
      control.connectionEpoch !== this.listener.connectionEpoch ||
      !keys.every(
        (key) =>
          typeof control[key] === "string" &&
          control[key].length > 0 &&
          control[key].length <= 128
      ) ||
      !["prepare", "arm", "cancel"].includes(control.action)
    ) {
      this.listenerFailure("invalid_control");
      this.socket?.destroy();
      return;
    }
    if (
      this.listenerControlIds.has(control.requestId) ||
      (this.listenerVersion === 2 &&
        (control.action === "prepare"
          ? !validDescriptiveConfig(control.config)
          : control.config !== undefined)) ||
      (control.action === "prepare" &&
        this.listenerVersion === 1 &&
        (!control.config ||
          !Number.isInteger(control.config.durationMs) ||
          control.config.durationMs < 1 ||
          control.config.durationMs > 120000 ||
          !Number.isInteger(control.config.maxWindows) ||
          control.config.maxWindows < 1 ||
          control.config.maxWindows > 512 ||
          !control.config.source ||
          !["session", "arrangement"].includes(control.config.source.mode) ||
          !Number.isFinite(control.config.source.startBeat) ||
          control.config.source.startBeat < 0 ||
          !Number.isFinite(control.config.source.endBeat) ||
          control.config.source.endBeat <= control.config.source.startBeat))
    ) {
      this.listenerFailure("invalid_control_bounds");
      this.socket?.destroy();
      return;
    }
    if (this.listenerControlIds.size >= 64)
      this.listenerControlIds.delete(
        this.listenerControlIds.values().next().value
      );
    this.listenerControlIds.add(control.requestId);
    if (control.action === "prepare") {
      if (this.listenerJob) {
        this.sendListenerReply(control, {
          status: "failed",
          reason: "listener_busy"
        });
        return;
      }
      this.listenerJob = control;
    } else if (
      !this.listenerJob ||
      control.jobId !== this.listenerJob.jobId ||
      control.passId !== this.listenerJob.passId
    ) {
      this.sendListenerReply(control, {
        status: "failed",
        reason: "ownership_mismatch"
      });
      return;
    }
    try {
      const result = this.onListenerControl(control);
      if (result && typeof result.then === "function") {
        result.catch((error) =>
          this.sendListenerReply(control, {
            status: "failed",
            reason: boundedMessage(error.message)
          })
        );
      }
    } catch (error) {
      this.sendListenerReply(control, {
        status: "failed",
        reason: boundedMessage(error.message)
      });
    }
  }

  sendListenerReply(control, reply) {
    return this.sendListenerMessage("listener.reply", control, reply);
  }

  sendListenerResult(control, result) {
    return this.sendListenerMessage("listener.result", control, result);
  }

  sendListenerMessage(type, control, payload) {
    if (
      !this.authenticated ||
      !this.listener ||
      !this.socket ||
      control.connectionEpoch !== this.listener.connectionEpoch ||
      this.listenerSequence >= Number.MAX_SAFE_INTEGER
    ) {
      this.listenerFailure("listener_not_connected");
      return false;
    }
    const message = {
      ...payload,
      type,
      protocolVersion: PROTOCOL_VERSION,
      listenerVersion: this.listenerVersion,
      requestId:
        type === "listener.reply"
          ? control.requestId
          : this.nextRequestId("listener"),
      connectionEpoch: control.connectionEpoch,
      jobId: control.jobId,
      passId: control.passId,
      traceId: control.traceId,
      correlationId: control.correlationId,
      causationId: control.causationId,
      sequence: this.listenerSequence
    };
    const sent = this.writeMessage(message);
    if (sent) this.listenerSequence += 1;
    else this.listenerFailure("listener_delivery_failed");
    if (
      (type === "listener.reply" &&
        ["cancelled", "failed"].includes(payload.status)) ||
      (type === "listener.result" && payload.status !== "progress")
    ) {
      this.listenerJob = null;
    }
    return sent;
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
    if (this.listenerJob) this.listenerFailure("stopped");
    this.listenerJob = null;
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
    this.authenticated = false;
    this.connectionId = null;
    this.pending.clear();
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
