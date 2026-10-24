import { describe, expect, it } from "vitest";
import {
  listenerNativeStatusV2Schema,
  listenerNativeSessionStatusSchema,
  NATIVE_SESSION_LISTENER_SCOPE,
  type InspectListeningContextResult,
} from "@ableton-agent/protocol";
import {
  resolveListenerBinding,
  readConnectedListenerBinding,
  type ConnectedListenerBinding,
  type ListenerBindingDescriptor,
  type ListenerBindingSelection,
} from "./listener-binding.js";

const queryId = "10000000-0000-4000-8000-000000000001";
const trackReference = "20000000-0000-4000-8000-000000000001";
const deviceReference = "30000000-0000-4000-8000-000000000001";
const blocked = {
  version: 1 as const,
  timing: "UNVERIFIED" as const,
  readiness: "BLOCKED" as const,
  reason: "real_live_timing_validation_required",
};
const connected: ConnectedListenerBinding = {
  connectionId: "connection",
  producerId: "path-hash-not-certificate",
  instanceId: "instance",
  connectionEpoch: "epoch",
  canonicalPath: "live_set tracks 0 devices 1",
  canonicalTrackPath: "live_set tracks 0",
  nativeStatus: blocked,
  signalKind: "audio",
  schemaVersion: "audio-observation/v1",
  status: "connected",
};
const selected: ListenerBindingSelection = {
  connectionId: connected.connectionId,
  producerId: connected.producerId,
  instanceId: connected.instanceId,
  connectionEpoch: connected.connectionEpoch,
  canonicalPath: connected.canonicalPath,
};
const target = {
  track: {
    kind: "regular" as const,
    index: 0,
    expectedReference: trackReference,
    expectedName: "Track",
  },
  deviceIndex: 1,
  expectedDeviceReference: deviceReference,
  expectedDeviceName: "Audio Listener",
  expectedClassName: "MxDeviceAudioEffect",
};
function inspection(): InspectListeningContextResult {
  return {
    schemaVersion: 1,
    bindingQueryId: queryId,
    projectRevision: 0,
    bindingScope: "live-connection",
    transport: {
      playing: false,
      currentBeat: 0,
      tempo: 120,
      recording: {
        recordMode: false,
        sessionRecord: false,
        arrangementOverdub: false,
        sessionAutomationRecord: false,
      },
      safeToStart: true,
    },
    listeners: [
      {
        binding: structuredClone(target),
        verified: true,
        canonicalPath: connected.canonicalPath,
        pathAttestation: {
          schemaVersion: 1,
          source: "remote-script-lom",
          canonicalDevicePath: connected.canonicalPath,
          canonicalTrackPath: "live_set tracks 0",
          deviceReference,
          trackReference,
          placement: { kind: "track-device", deviceIndex: 1 },
        },
        enabled: true,
        sessionOverride: false,
        clips: [],
        clipsTruncated: false,
        trackEvidence: [],
        upstreamDevices: [],
        dependenciesTruncated: false,
        fingerprint: {
          algorithm: "sha256",
          scope: "available-live-fields/v1",
          digest: "a".repeat(64),
          completeness: "unknown",
          unknownReasons: ["unverified-routing"],
        },
        attribution: "nonexclusive",
        unknownReasons: ["unverified-routing"],
      },
    ],
  };
}
function resolve(
  change: Partial<Parameters<typeof resolveListenerBinding>[0]> = {},
) {
  return resolveListenerBinding({
    selected,
    connected: [connected],
    inspection: inspection(),
    queryId,
    ...change,
  });
}

function descriptor(
  metadata?: Readonly<Record<string, unknown>>,
  capabilities?: Readonly<Record<string, unknown>>,
): ListenerBindingDescriptor {
  const raw = {
    connectionId: connected.connectionId,
    producer: {
      producerId: connected.producerId,
      instanceId: connected.instanceId,
      signalKind: "audio" as const,
      schemaVersion: "audio-observation/v1",
      track: { id: "123", name: "Claimed Name" },
      device: { id: "456", name: "Claimed Device Name" },
      ...(capabilities === undefined ? {} : { capabilities }),
    },
    registration: { connectionEpoch: connected.connectionEpoch, ...metadata },
    binding: { trackId: "123", deviceId: "456" },
  };
  return raw;
}

describe("independent canonical listener binding", () => {
  it("joins explicitly negotiated wire3 Session status to raw v2 measurements without certifying readiness", () => {
    const nativeStatus = listenerNativeSessionStatusSchema.parse({
      version: 3,
      scope: NATIVE_SESSION_LISTENER_SCOPE,
      readiness: "BLOCKED",
      reason: "fresh_per_pass_native_validation_required",
      alignment: "approximate",
      verifiedAbsoluteErrorBoundSamples: null,
      acceptedSampleRates: [44100, 48000],
      acceptedVectorSizes: [64],
      timingModes: ["descriptive", "strict"],
      maxClockDisagreementSamples: 480,
      maxAudioDurationMs: 30000,
      maxWindows: 300,
      abiVersion: 2,
      sourceEvidence: "expected-context-only",
      synchronization: "transport-coupled-first-iteration",
      maxDurationBeats: 4,
    });
    const report: ListenerBindingDescriptor = {
      ...descriptor(),
      producer: {
        ...descriptor().producer,
        schemaVersion: "audio-observation/v2",
      },
      registration: {
        version: 3,
        capabilities: ["audio-listener/session-v1"],
        connectionEpoch: connected.connectionEpoch,
        deviceCanonicalPath: connected.canonicalPath,
        trackCanonicalPath: connected.canonicalTrackPath,
        nativeStatus,
      },
    };
    const candidate = readConnectedListenerBinding(report);
    expect(candidate).toEqual({
      ok: true,
      connection: {
        ...connected,
        schemaVersion: "audio-observation/v2",
        nativeStatus,
      },
    });
    const joined = resolve({ connected: [report] });
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error(joined.reason);
    expect(joined.connection.nativeStatus).toEqual(nativeStatus);
    expect(joined.target.expectedDeviceReference).toBe(deviceReference);
    expect(joined.attestation.deviceReference).not.toBe("456");
    for (const change of [
      { version: undefined },
      { version: 2 },
      { capabilities: undefined },
      { capabilities: ["audio-listener/v2"] },
      { capabilities: ["audio-listener/session-v1", "audio-listener/v2"] },
      {
        nativeStatus: { ...nativeStatus, scope: "arrangement-descriptive/v2" },
      },
      { nativeStatus: { ...nativeStatus, abiVersion: 3 } },
    ]) {
      const invalid = { ...report, registration: { ...report.registration } };
      Object.assign(invalid.registration, change);
      expect(readConnectedListenerBinding(invalid)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
    for (const schemaVersion of [
      "audio-observation/v1",
      "audio-observation/v3",
      "session-audio-observation/v1",
    ])
      expect(
        readConnectedListenerBinding({
          ...report,
          producer: { ...report.producer, schemaVersion },
        }),
      ).toEqual({ ok: false, reason: "invalid-input" });
    const inherited = { ...report.registration };
    delete inherited.version;
    Object.setPrototypeOf(inherited, { version: 3 });
    expect(
      readConnectedListenerBinding({ ...report, registration: inherited }),
    ).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });
  it("joins explicit v2 capabilities without upgrading approximate timing or accepting mixed versions", () => {
    const nativeStatus = listenerNativeStatusV2Schema.parse({
      version: 2,
      scope: "arrangement-descriptive/v2",
      readiness: "READY",
      alignment: "approximate",
      verifiedAbsoluteErrorBoundSamples: null,
      acceptedSampleRates: [44_100, 48_000],
      acceptedVectorSizes: [64],
      timingModes: ["descriptive", "strict"],
      maxClockDisagreementSamples: 480,
      maxAudioDurationMs: 30_000,
      maxWindows: 300,
      abiVersion: 2,
    });
    const v2 = {
      ...connected,
      schemaVersion: "audio-observation/v2",
      nativeStatus,
    };
    const report: ListenerBindingDescriptor = {
      ...descriptor(),
      producer: {
        ...descriptor().producer,
        schemaVersion: "audio-observation/v2",
      },
      registration: {
        connectionEpoch: connected.connectionEpoch,
        deviceCanonicalPath: connected.canonicalPath,
        trackCanonicalPath: connected.canonicalTrackPath,
        nativeStatus,
      },
    };
    expect(readConnectedListenerBinding(report)).toEqual({
      ok: true,
      connection: v2,
    });
    const joined = resolve({ connected: [v2] });
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error(joined.reason);
    expect(joined.connection.nativeStatus).toEqual(nativeStatus);
    expect(resolve({ connected: [{ ...v2, nativeStatus: blocked }] })).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(
      resolve({
        connected: [{ ...v2, schemaVersion: "audio-observation/v1" }],
      }),
    ).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });
  it("requires explicit registration keys rather than inherited path values", () => {
    const report = descriptor();
    Object.setPrototypeOf(report.registration, {
      deviceCanonicalPath: connected.canonicalPath,
      trackCanonicalPath: connected.canonicalTrackPath,
      nativeStatus: blocked,
    });
    expect(readConnectedListenerBinding(report)).toEqual({
      ok: false,
      reason: "missing-canonical-path",
    });
  });
  it("consumes actual registration paths without treating BLOCKED as readiness", () => {
    const report = descriptor(
      {
        deviceCanonicalPath: connected.canonicalPath,
        trackCanonicalPath: connected.canonicalTrackPath,
        nativeStatus: blocked,
      },
      {
        get timingCertificate() {
          throw new Error("Timing claims are not binding evidence");
        },
      },
    );
    expect(readConnectedListenerBinding(report)).toEqual({
      ok: true,
      connection: connected,
    });
    const result = resolve({ connected: [report] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.target.expectedDeviceReference).toBe(deviceReference);
    expect(result.attestation.deviceReference).not.toBe("456");
    expect(result.basis).toBe("canonical-path-join");
  });
  it.each([
    undefined,
    { canonicalPath: connected.canonicalPath },
    { deviceCanonicalPath: connected.canonicalPath },
    { trackCanonicalPath: connected.canonicalTrackPath },
  ])(
    "rejects missing registration paths without ID/hash fallback %j",
    (capabilities) => {
      expect(readConnectedListenerBinding(descriptor(capabilities))).toEqual({
        ok: false,
        reason: "missing-canonical-path",
      });
      expect(resolve({ connected: [descriptor(capabilities)] })).toEqual({
        ok: false,
        reason: "missing-canonical-path",
      });
    },
  );
  it("rejects non-string registration IDs and mismatched reported track ownership", () => {
    expect(
      readConnectedListenerBinding(
        descriptor({
          deviceCanonicalPath: 456,
          trackCanonicalPath: 123,
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-input" });
    expect(
      readConnectedListenerBinding(
        descriptor({
          deviceCanonicalPath: connected.canonicalPath,
          trackCanonicalPath: "live_set master_track",
          nativeStatus: blocked,
        }),
      ),
    ).toEqual({ ok: false, reason: "unattested-path" });
    expect(
      resolve({
        connected: [
          { ...connected, canonicalTrackPath: "live_set master_track" },
        ],
      }),
    ).toEqual({ ok: false, reason: "unattested-path" });
  });
  it("rejects capability aliases and missing native status rather than upgrading legacy evidence", () => {
    const paths = {
      deviceCanonicalPath: connected.canonicalPath,
      trackCanonicalPath: connected.canonicalTrackPath,
    };
    expect(readConnectedListenerBinding(descriptor(undefined, paths))).toEqual({
      ok: false,
      reason: "missing-canonical-path",
    });
    expect(readConnectedListenerBinding(descriptor(paths))).toEqual({
      ok: false,
      reason: "missing-native-status",
    });
  });
  it("joins canonical paths to bridge UUIDs without requiring numeric-ID equality", () => {
    const result = resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.target).toEqual(target);
    expect(result.basis).toBe("canonical-path-join");
    expect(result.connection.producerId).not.toBe(deviceReference);
    expect(resolve({ selected: connected }).ok).toBe(true);
  });
  it("requires independent attestation rather than canonical hashes or names", () => {
    const state = inspection();
    delete state.listeners[0]!.pathAttestation;
    expect(resolve({ inspection: state })).toEqual({
      ok: false,
      reason: "unattested-path",
    });
  });
  it.each(["master", "return"] as const)(
    "supports independently attested %s paths",
    (kind) => {
      const path =
        kind === "master"
          ? "live_set master_track"
          : "live_set return_tracks 0";
      const state = inspection();
      state.listeners[0]!.binding.track = {
        kind,
        ...(kind === "return" ? { index: 0 } : {}),
        expectedReference: trackReference,
        expectedName: "Mix",
      };
      state.listeners[0]!.canonicalPath = `${path} devices 1`;
      state.listeners[0]!.pathAttestation!.canonicalTrackPath = path;
      state.listeners[0]!.pathAttestation!.canonicalDevicePath = `${path} devices 1`;
      expect(
        resolve({
          selected: { ...selected, canonicalPath: `${path} devices 1` },
          connected: [
            {
              ...connected,
              canonicalPath: `${path} devices 1`,
              canonicalTrackPath: path,
            },
          ],
          inspection: state,
        }).ok,
      ).toBe(true);
    },
  );
  it.each([{ status: "disconnected" as const }, { status: "stale" as const }])(
    "rejects unavailable producer %j",
    (change) => {
      expect(resolve({ connected: [{ ...connected, ...change }] })).toEqual({
        ok: false,
        reason: "unavailable",
      });
    },
  );
  it.each([
    { instanceId: "replacement" },
    { connectionEpoch: "reconnected" },
    { producerId: "other" },
    { canonicalPath: "live_set tracks 0 devices 0" },
  ])("rejects stale captured identity %j", (change) => {
    expect(resolve({ connected: [{ ...connected, ...change }] })).toEqual({
      ok: false,
      reason: "stale-connection",
    });
  });
  it("rejects unsupported nesting and malformed/arbitrary LOM paths", () => {
    const path = "live_set tracks 0 devices 1 chains 0 devices 0";
    expect(
      resolve({
        selected: { ...selected, canonicalPath: path },
        connected: [{ ...connected, canonicalPath: path }],
      }),
    ).toEqual({ ok: false, reason: "unsupported-placement" });
    expect(
      resolve({
        selected: { ...selected, canonicalPath: "live_set this_device" },
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });
  it.each([
    { canonicalPath: connected.canonicalPath },
    { instanceId: connected.instanceId },
    { producerId: connected.producerId },
  ])("rejects colliding connected producer %j", (change) => {
    const other = {
      ...connected,
      connectionId: "other",
      producerId: "other",
      instanceId: "other",
      canonicalPath: "live_set tracks 0 devices 0",
      ...change,
    };
    expect(resolve({ connected: [connected, other] })).toEqual({
      ok: false,
      reason: "collision",
    });
  });
  it("rejects duplicate connections and ambiguous independent attestations", () => {
    expect(resolve({ connected: [connected, connected] })).toEqual({
      ok: false,
      reason: "ambiguous",
    });
    const state = inspection();
    state.listeners.push(structuredClone(state.listeners[0]!));
    expect(resolve({ inspection: state })).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });
  it("fails closed on inactive/unknown enabled state and wrong device class", () => {
    for (const enabled of [false, null]) {
      const state = inspection();
      state.listeners[0]!.enabled = enabled;
      expect(resolve({ inspection: state })).toEqual({
        ok: false,
        reason: "inactive",
      });
    }
    const state = inspection();
    state.listeners[0]!.binding.expectedClassName = "MxDeviceInstrument";
    expect(resolve({ inspection: state })).toEqual({
      ok: false,
      reason: "non-audio-effect",
    });
    expect(
      resolve({
        connected: [
          {
            ...connected,
            signalKind: "midi" as const,
            schemaVersion: "midi-sample/v1",
          },
        ],
      }),
    ).toEqual({ ok: false, reason: "non-audio-producer" });
  });
  it("rejects replayed queries, moved/reloaded UUID bindings and never uses names as proof", () => {
    const state = inspection();
    delete state.bindingQueryId;
    expect(resolve({ inspection: state })).toEqual({
      ok: false,
      reason: "stale-inspection",
    });
    expect(
      resolve({ queryId: "10000000-0000-4000-8000-000000000002" }),
    ).toEqual({ ok: false, reason: "stale-inspection" });
    expect(
      resolve({
        selected: {
          ...selected,
          expectedTarget: {
            ...target,
            expectedDeviceReference: trackReference,
          },
        },
      }),
    ).toEqual({ ok: false, reason: "stale-target" });
    expect(
      resolve({
        selected: {
          ...selected,
          expectedTarget: { ...target, expectedDeviceName: "Renamed" },
        },
      }).ok,
    ).toBe(true);
  });
  it("rejects forged mismatched attestations and bounds registry inspection", () => {
    const state = inspection();
    state.listeners[0]!.pathAttestation!.deviceReference = trackReference;
    expect(resolve({ inspection: state })).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(
      resolve({ connected: Array.from({ length: 129 }, () => connected) }),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });
});
