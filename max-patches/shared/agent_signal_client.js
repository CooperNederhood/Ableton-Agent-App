/* global Buffer, clearInterval, clearTimeout, module, process, require, setInterval, setTimeout */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PROTOCOL_VERSION = 1;
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

function sameListenerOwner(control, job) {
  return (
    !!job &&
    ["connectionEpoch", "jobId", "passId", "traceId", "correlationId"].every(
      (key) => control[key] === job[key]
    )
  );
}

function snapshotDescriptiveControl(control) {
  return Object.freeze({
    ...control,
    ...(control.config
      ? {
          config: Object.freeze({
            geometry: Object.freeze({ ...control.config.geometry }),
            timingPolicy: Object.freeze({ ...control.config.timingPolicy })
          })
        }
      : {})
  });
}

function matchingDescriptiveArm(arm, job) {
  const config = { geometry: arm?.geometry, timingPolicy: arm?.policy };
  return (
    arm?.scope === "arrangement-descriptive/v2" &&
    !!job?.config &&
    validDescriptiveConfig(config) &&
    ["geometry", "timingPolicy"].every((part) =>
      Object.keys(config[part]).every(
        (key) => config[part][key] === job.config[part][key]
      )
    )
  );
}

function matchingDescriptiveLaunch(launch, job) {
  const geometry = job?.config?.geometry;
  return (
    !!geometry &&
    hasExactKeys(launch, [
      "nativeEpoch",
      "armCounter",
      "launchClock",
      "launchPhaseSamples",
      "rejected",
      "active",
      "host"
    ]) &&
    Number.isInteger(launch.nativeEpoch) &&
    launch.nativeEpoch >= 1 &&
    launch.nativeEpoch <= 1000000 &&
    Number.isSafeInteger(launch.armCounter) &&
    launch.armCounter >= 0 &&
    launch.armCounter + geometry.totalSamples < 2 ** 44 &&
    Number.isInteger(launch.launchPhaseSamples) &&
    launch.launchPhaseSamples >= 0 &&
    launch.launchPhaseSamples <= geometry.vectorSize &&
    Number.isInteger(launch.launchClock) &&
    launch.launchClock >= launch.launchPhaseSamples &&
    launch.launchClock <= geometry.sampleRate * 10 &&
    launch.rejected === 0 &&
    launch.active === 1 &&
    hasExactKeys(launch.host, ["sample", "beat", "flags", "playing"]) &&
    Number.isSafeInteger(launch.host.sample) &&
    launch.host.sample >= 0 &&
    Number.isFinite(launch.host.beat) &&
    launch.host.beat >= 0 &&
    launch.host.beat <= 1576800 &&
    Number.isInteger(launch.host.flags) &&
    launch.host.flags >= 0 &&
    launch.host.flags <= 0x7fffffff &&
    (launch.host.flags & 19) === 19 &&
    launch.host.playing === true
  );
}

function validNativeFailureDiagnostic(value) {
  const tuple = (values, length) =>
    Array.isArray(values) &&
    values.length === length &&
    Array.from(values).every(Number.isFinite);
  return (
    hasExactKeys(value, [
      "scope",
      "generation",
      "check",
      "packet",
      "fftDiagnostics",
      "metadata"
    ]) &&
    value.scope === "native-spectrum-rejection/v1" &&
    typeof value.generation === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.generation
    ) &&
    [
      "end",
      "start",
      "frame",
      "centroid",
      "energy",
      "silence_centroid",
      "invalid_frames",
      "bracket"
    ].includes(value.check) &&
    tuple(value.packet, 6) &&
    (value.fftDiagnostics === null || tuple(value.fftDiagnostics, 5)) &&
    hasExactKeys(value.metadata, [
      "dsp",
      "fftInfo",
      "clockAbi",
      "envelopeAbi",
      "spectrumAbi"
    ]) &&
    (value.metadata.dsp === null || tuple(value.metadata.dsp, 3)) &&
    (value.metadata.fftInfo === null || tuple(value.metadata.fftInfo, 4)) &&
    ["clockAbi", "envelopeAbi", "spectrumAbi"].every(
      (key) =>
        value.metadata[key] === null || Number.isFinite(value.metadata[key])
    )
  );
}

// Wire pairing/stage guards; ingress independently validates complete native proof.
function validDescriptivePayload(type, payload, job, producerId) {
  if (
    !["listener.reply", "listener.result"].includes(type) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    return false;
  const reply = type === "listener.reply";
  const keys = reply
    ? ["status", "reason", "nativeArm", "nativeFailureDiagnostic"]
    : [
        "status",
        "reason",
        "observation",
        "nativeLaunch",
        "nativeCapture",
        "nativeLifecycle",
        "nativeFailureDiagnostic"
      ];
  if (
    Object.keys(payload).some((key) => !keys.includes(key)) ||
    (payload.reason !== undefined &&
      (typeof payload.reason !== "string" ||
        !payload.reason.length ||
        payload.reason.length > 512)) ||
    (payload.nativeFailureDiagnostic !== undefined &&
      (payload.status !== "failed" ||
        !validNativeFailureDiagnostic(payload.nativeFailureDiagnostic)))
  )
    return false;
  if (reply)
    return (
      ["ready", "armed", "cancelled", "failed"].includes(payload.status) &&
      (payload.status === "armed") === (payload.nativeArm !== undefined) &&
      (!payload.nativeArm || matchingDescriptiveArm(payload.nativeArm, job)) &&
      (payload.status !== "failed" || payload.reason !== undefined)
    );
  if (
    !["progress", "completed", "partial", "failed"].includes(payload.status) ||
    (["partial", "failed"].includes(payload.status) &&
      payload.reason === undefined) ||
    (payload.status === "completed"
      ? !payload.observation ||
        !matchingDescriptiveArm(payload.nativeCapture?.armed, job) ||
        !matchingDescriptiveLaunch(payload.nativeCapture?.launched, job) ||
        payload.nativeCapture.launched.nativeEpoch !==
          payload.nativeCapture.armed.nativeEpoch ||
        payload.nativeCapture.launched.armCounter !==
          payload.nativeCapture.armed.armCounter
      : payload.nativeCapture !== undefined) ||
    (payload.status !== "progress" &&
      (payload.nativeLaunch || payload.nativeLifecycle))
  )
    return false;
  const observation = payload.observation;
  if (
    observation &&
    (observation.schema !== "audio-observation/v2" ||
      observation.algorithm?.version !== "2.0.0" ||
      observation.listenerId !== producerId ||
      observation.passId !== job?.passId ||
      observation.complete !== (payload.status === "completed"))
  )
    return false;
  if (
    payload.nativeLaunch &&
    !matchingDescriptiveLaunch(payload.nativeLaunch, job)
  )
    return false;
  const event = payload.nativeLifecycle;
  return (
    !event ||
    (event.scope === "arrangement-descriptive/v2" &&
      Number.isInteger(event.frames) &&
      event.frames >= 0 &&
      event.frames <= 300 &&
      [
        "queued",
        "started",
        "progress",
        "completed",
        "failed",
        "cancelled"
      ].includes(event.stage) &&
      (!event.phase ||
        ["preflight", "reset", "capture", "alignment"].includes(event.phase)) &&
      (!["failed", "cancelled"].includes(event.stage) ||
        (typeof event.reason === "string" &&
          event.reason.length > 0 &&
          event.reason.length <= 512)))
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
    this.listenerJobControlIds = new Set();
    this.notifyingListenerFailure = false;
    if (
      (!this.listener && this.schemaVersion === "audio-observation/v2") ||
      (this.listener &&
        (this.signalKind !== "audio" ||
          ![1, 2].includes(this.listenerVersion) ||
          this.schemaVersion !== `audio-observation/v${this.listenerVersion}` ||
          !Array.isArray(this.listener.capabilities) ||
          this.listener.capabilities.length !== 1 ||
          this.listener.capabilities[0] !==
            `audio-listener/v${this.listenerVersion}`))
    ) {
      throw new Error(
        "listener capability requires matching audio-observation version"
      );
    }
    if (this.listenerVersion === 2) {
      const listener = this.listener;
      const status = listener.nativeStatus;
      if (
        !Number.isInteger(listener.sampleRate) ||
        listener.sampleRate < 8000 ||
        listener.sampleRate > 384000 ||
        !Number.isInteger(listener.vectorSize) ||
        listener.vectorSize < 1 ||
        listener.vectorSize > 65536 ||
        listener.algorithmVersion !== "2.0.0" ||
        !status ||
        status.version !== 2 ||
        status.scope !== "arrangement-descriptive/v2" ||
        !["READY", "BLOCKED"].includes(status.readiness) ||
        (status?.readiness === "READY" &&
          (!Array.isArray(status.acceptedSampleRates) ||
            !status.acceptedSampleRates.includes(listener.sampleRate) ||
            !Array.isArray(status.acceptedVectorSizes) ||
            !status.acceptedVectorSizes.includes(listener.vectorSize)))
      )
        throw new Error("invalid native v2 listener registration");
      this.listener = Object.freeze({
        ...listener,
        capabilities: Object.freeze([...listener.capabilities]),
        ...(status
          ? {
              nativeStatus: Object.freeze(
                Object.fromEntries(
                  Object.entries(status).map(([key, value]) => [
                    key,
                    Array.isArray(value) ? Object.freeze([...value]) : value
                  ])
                )
              )
            }
          : {})
      });
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
    if (this.listenerVersion === 2 && this.authenticated) {
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
      this.listener = { ...this.listener, connectionEpoch: this.randomUUID() };
      if (this.listenerVersion === 2)
        this.listener = Object.freeze(this.listener);
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
      ((this.listenerVersion === 2 &&
        (!Array.isArray(descriptor.listenerVersions) ||
          !Array.isArray(descriptor.listenerCapabilities))) ||
        !descriptor.listenerVersions?.includes(this.listenerVersion) ||
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
        response.connectionId.length === 0
      ) {
        this.emitStatus("live", "invalid_response", "invalid_hello_ack");
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
      this.listenerVersion === 2 ? DEFAULT_MAX_FRAME_BYTES : Infinity,
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

  listenerFailure(reason) {
    this.emitStatus("live", "listener_partial", reason);
    if (this.notifyingListenerFailure) return;
    this.notifyingListenerFailure = true;
    try {
      this.onListenerFailure(
        this.listenerErrorReason({ message: reason }),
        this.listenerJob
      );
    } catch {
      this.emitStatus("live", "listener_failure_handler_error");
    } finally {
      this.notifyingListenerFailure = false;
    }
  }

  handleListenerControl(control) {
    if (
      this.listenerVersion === 2 &&
      (!control || typeof control !== "object" || Array.isArray(control))
    ) {
      this.listenerFailure("invalid_control");
      this.socket?.destroy();
      return;
    }
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
      (this.listenerVersion === 2 && this.stopping) ||
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
        (!hasExactKeys(control, [
          "type",
          "protocolVersion",
          "listenerVersion",
          "action",
          ...keys,
          ...(control.action === "prepare" ? ["config"] : [])
        ]) ||
          control.type !== "listener.control" ||
          (control.action === "prepare"
            ? !validDescriptiveConfig(control.config) ||
              control.config.geometry.sampleRate !== this.listener.sampleRate ||
              control.config.geometry.vectorSize !== this.listener.vectorSize
            : control.config !== undefined))) ||
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
        this.sendListenerMessage(
          "listener.reply",
          control,
          {
            status: "failed",
            reason: "listener_busy"
          },
          this.listenerVersion !== 2
        );
        return;
      }
      if (this.listenerVersion === 2) {
        control = snapshotDescriptiveControl(control);
        this.listenerJobControlIds.clear();
      }
      this.listenerJob = control;
    } else if (
      !this.listenerJob ||
      control.jobId !== this.listenerJob.jobId ||
      control.passId !== this.listenerJob.passId ||
      (this.listenerVersion === 2 &&
        !sameListenerOwner(control, this.listenerJob))
    ) {
      this.sendListenerMessage(
        "listener.reply",
        control,
        {
          status: "failed",
          reason: "ownership_mismatch"
        },
        this.listenerVersion !== 2
      );
      return;
    }
    if (this.listenerVersion === 2) {
      if (this.listenerJobControlIds.size >= 64) {
        this.listenerFailure("listener_control_quota_exceeded");
        this.socket?.destroy();
        return;
      }
      this.listenerJobControlIds.add(control.requestId);
      if (control.action !== "prepare")
        control = snapshotDescriptiveControl(control);
    }
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

  listenerErrorReason(error) {
    const secret =
      this.loadedSecret || this.secret || this.env[DEFAULT_SECRET_ENV];
    const text = String(error?.message ?? "listener_callback_failed");
    return (
      boundedMessage(
        this.listenerVersion === 2 && secret
          ? text.split(secret).join("[REDACTED]")
          : text
      ) || "listener_callback_failed"
    );
  }

  sendListenerMessage(type, control, payload, releaseJob = true) {
    if (
      !this.authenticated ||
      !this.listener ||
      !this.socket ||
      control?.connectionEpoch !== this.listener.connectionEpoch ||
      this.listenerSequence >= Number.MAX_SAFE_INTEGER
    ) {
      this.listenerFailure("listener_not_connected");
      return false;
    }
    const job = this.listenerJob;
    if (
      this.listenerVersion === 2 &&
      (control.protocolVersion !== PROTOCOL_VERSION ||
        control.listenerVersion !== 2 ||
        (releaseJob &&
          (!sameListenerOwner(control, job) ||
            !this.listenerJobControlIds.has(control.requestId))))
    ) {
      this.emitStatus(
        "live",
        "listener_message_rejected",
        "invalid_listener_context"
      );
      return false;
    }
    if (
      this.listenerVersion === 2 &&
      !validDescriptivePayload(type, payload, job, this.producer?.producerId)
    ) {
      this.listenerFailure("invalid_listener_payload");
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
    if (this.listenerVersion === 2) {
      let encoded;
      try {
        encoded = JSON.stringify(message);
      } catch {
        this.listenerFailure("listener_encoding_failed");
        return false;
      }
      if (Buffer.byteLength(encoded, "utf8") > this.maxFrameBytes()) {
        this.listenerFailure("listener_frame_too_large");
        return false;
      }
    }
    const sent = this.writeMessage(message);
    if (sent) this.listenerSequence += 1;
    else this.listenerFailure("listener_delivery_failed");
    if (
      (this.listenerVersion !== 2 ||
        (releaseJob &&
          this.listenerJob === job &&
          sameListenerOwner(control, job))) &&
      ((type === "listener.reply" &&
        ["cancelled", "failed"].includes(payload.status)) ||
        (type === "listener.result" && payload.status !== "progress"))
    ) {
      this.listenerJob = null;
      if (this.listenerVersion === 2) this.listenerJobControlIds.clear();
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
    this.clearWriteDrain("cancelled", "stopped");
    if (this.listenerJob) this.listenerFailure("stopped");
    this.listenerJob = null;
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
