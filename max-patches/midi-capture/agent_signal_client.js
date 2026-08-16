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
  "signal-ingress.json",
);
const DEFAULT_SECRET_PATH = path.join(
  DEFAULT_SIGNAL_DIRECTORY,
  "signal-ingress.secret",
);

function defaultReadText(filePath) {
  return fs.promises.readFile(filePath, "utf8");
}

function boundedMessage(value, maxLength = 240) {
  return String(value).replace(/\s+/g, " ").slice(0, maxLength);
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
    "canonicalPath",
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
    name: boundedRequiredString(track.name, "track.name"),
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
      name: boundedRequiredString(device.name, "device.name"),
    },
  };
}

function producerIdForCanonicalPath(canonicalPath) {
  const normalized = boundedRequiredString(canonicalPath, "canonicalPath");
  const digest = crypto
    .createHash("sha256")
    .update(`live-path-v1:${normalized}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `ableton-midi-capture:path:${digest}`;
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
  return value;
}

class AgentSignalClient {
  constructor(options = {}) {
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
      DEFAULT_DESCRIPTOR_PATH;
    this.secret = options.secret || null;
    this.secretPath =
      options.secretPath ||
      this.env[DEFAULT_SECRET_PATH_ENV] ||
      DEFAULT_SECRET_PATH;
    this.instanceId = options.instanceId || this.randomUUID();
    this.displayName = options.displayName || "Midi-Capture";
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
      producerId: producerIdForCanonicalPath(normalized.canonicalPath),
      instanceId: this.instanceId,
      displayName: this.displayName,
      signalKind: "midi",
      schemaVersion: "midi-sample/v1",
      track: normalized.track,
      device: normalized.device,
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
      secret = await this.loadSecret();
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
        port: descriptor.port,
      });
    } catch (error) {
      this.emitStatus("live", "socket_error", boundedMessage(error.message));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
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
    return validateDescriptor(JSON.parse(text));
  }

  async loadSecret() {
    const secret =
      this.secret ||
      this.env[DEFAULT_SECRET_ENV] ||
      (this.secretPath ? (await this.readText(this.secretPath)).trim() : "");
    if (typeof secret !== "string" || secret.length < 32) {
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
      this.emitStatus(
        "live",
        "server_error",
        boundedMessage(response.code),
        response.fatal ? "fatal" : "recoverable",
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
      payload: item.sample,
    };
    const encoded = `${JSON.stringify(message)}\n`;
    if (encodedFrameBytes(encoded) > this.maxFrameBytes()) {
      this.emitStatus("live", "sample_dropped", "frame_too_large");
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
        requestId: this.nextRequestId("heartbeat"),
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
      this.socket.write(encoded);
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
      this.configuredMaxFrameBytes,
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
      this.reconnectMaxMs,
    );
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  emitStatus(...items) {
    const bounded = items.map((item) => boundedMessage(item));
    const key = bounded.join("\u0000");
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.onStatus(...bounded);
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
    const socket = this.socket;
    if (socket && this.authenticated && !socket.destroyed) {
      this.writeMessage({
        type: "producer.disconnect",
        protocolVersion: PROTOCOL_VERSION,
        requestId: this.nextRequestId("disconnect"),
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
  DEFAULT_DESCRIPTOR_ENV,
  DEFAULT_DESCRIPTOR_PATH,
  DEFAULT_SECRET_ENV,
  DEFAULT_SECRET_PATH,
  DEFAULT_SECRET_PATH_ENV,
  PROTOCOL_VERSION,
  producerIdForCanonicalPath,
  validateDescriptor,
  validateProducerIdentity,
};
