import { describe, expect, it, vi } from "vitest";
import { createSyntheticAnalyzerReadiness } from "@ableton-agent/protocol/testing";
import {
  listenerNativeMetricStatusSchema,
  type InspectListeningContextResult,
  type NativeMetricArmProof,
  type NativeMetricReadyProof,
} from "@ableton-agent/protocol";
import {
  resolveListenerBinding,
  readConnectedListenerBinding,
  type ConnectedListenerBinding,
  type ListenerBindingDescriptor,
  type ListenerBindingSelection,
} from "./listener-binding.js";
const { createSyntheticMetricWireFixture } = await vi.importActual<{
  createSyntheticMetricWireFixture(this: void): {
    wire: Pick<
      NativeMetricArmProof["ownership"],
      "connectionId" | "listenerId"
    >;
    registration: ListenerBindingDescriptor["registration"];
    ready: NativeMetricReadyProof;
    proof: { armed: NativeMetricArmProof };
  };
}>("../../signal-routing/src/listener-metric-test-support.js");
const { listenerRegistrationMetricSchema } = await vi.importActual<{
  listenerRegistrationMetricSchema: {
    parse(input: unknown): ListenerBindingDescriptor["registration"];
    safeParse(input: unknown): { success: boolean };
  };
}>("../../signal-routing/src/listener-metric-contracts.js");

const queryId = "10000000-0000-4000-8000-000000000001";
const trackReference = "20000000-0000-4000-8000-000000000001";
const deviceReference = "30000000-0000-4000-8000-000000000001";
const synthetic = createSyntheticMetricWireFixture();
const blocked = listenerNativeMetricStatusSchema.parse({
  ...synthetic.registration.nativeStatus,
  readiness: "BLOCKED",
  reason: "fresh_per_pass_native_validation_required",
  executedGen: null,
});
const connected: ConnectedListenerBinding = {
  connectionId: synthetic.wire.connectionId,
  producerId: "path-hash-not-certificate",
  instanceId: "instance",
  connectionEpoch: synthetic.registration.connectionEpoch,
  canonicalPath: "live_set tracks 0 devices 1",
  canonicalTrackPath: "live_set tracks 0",
  nativeStatus: blocked,
  signalKind: "audio",
  schemaVersion: "metric-audio-observation/v1",
  status: "connected",
  capabilities: [
    "audio-listener/independent-metric-timelines-v1",
    "audio-listener/mel-band-timelines-v1",
  ],
  algorithmVersion: "3.0.0",
  sampleRate: 48_000,
  vectorSize: 64,
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
      schemaVersion: "metric-audio-observation/v1" as const,
      track: { id: "123", name: "Claimed Name" },
      device: { id: "456", name: "Claimed Device Name" },
      ...(capabilities === undefined ? {} : { capabilities }),
    },
    registration: {
      version: 5 as const,
      connectionEpoch: connected.connectionEpoch,
      capabilities: connected.capabilities,
      algorithmVersion: connected.algorithmVersion,
      sampleRate: connected.sampleRate,
      vectorSize: connected.vectorSize,
      ...metadata,
    },
    binding: { trackId: "123", deviceId: "456" },
  };
  return raw;
}

describe("authenticated v5 metric listener binding metadata", () => {
  function analyzerDescriptor(): ListenerBindingDescriptor {
    const report = metricDescriptor();
    return {
      ...report,
      registration: listenerRegistrationMetricSchema.parse({
        ...report.registration,
        capabilities: [
          ...report.registration.capabilities!,
          "audio-listener/analyzer-timelines-v1",
        ],
        analyzerReadiness: createSyntheticAnalyzerReadiness(),
      }),
    };
  }
  it("keeps a canonically registered ABI3 analyzer discoverable and retains its actual readiness through binding", () => {
    const report = analyzerDescriptor();
    const before = structuredClone(report);
    const candidate = readConnectedListenerBinding(report);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) throw new Error(candidate.reason);
    expect(candidate.connection).toHaveProperty(
      "analyzerReadiness",
      createSyntheticAnalyzerReadiness(),
    );
    expect(candidate.connection.capabilities).toEqual(
      report.registration.capabilities,
    );
    const resolved = join(report);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.connection).toHaveProperty(
      "analyzerReadiness",
      createSyntheticAnalyzerReadiness(),
    );
    expect(
      resolve({
        selected: { ...resolved.connection, expectedTarget: target },
        connected: [candidate.connection],
      }).ok,
    ).toBe(true);
    expect(report).toEqual(before);
  });
  it.each(["missing", "abi", "sample-rate", "unadvertised", "token"] as const)(
    "denies %s analyzer readiness consistently with the actual registration schema",
    (failure) => {
      const report = analyzerDescriptor();
      const receipt = createSyntheticAnalyzerReadiness();
      Object.assign(
        report.registration,
        failure === "unadvertised"
          ? {
              capabilities: connected.capabilities,
            }
          : {
              analyzerReadiness:
                failure === "missing"
                  ? undefined
                  : {
                      ...receipt,
                      ...(failure === "abi" ? { producerAbi: 2 } : {}),
                      ...(failure === "sample-rate"
                        ? { sampleRate: 44100 }
                        : {}),
                      ...(failure === "token" ? { probeToken: 0 } : {}),
                    },
            },
      );
      expect(
        listenerRegistrationMetricSchema.safeParse(report.registration).success,
      ).toBe(false);
      expect(readConnectedListenerBinding(report)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      expect(join(report)).toEqual({ ok: false, reason: "invalid-input" });
    },
  );
  function metricDescriptor(cold = true): ListenerBindingDescriptor {
    const fixture = createSyntheticMetricWireFixture();
    return {
      connectionId: fixture.wire.connectionId,
      producer: {
        producerId: fixture.wire.listenerId,
        instanceId: "synthetic-metric-instance",
        signalKind: "audio",
        schemaVersion: "metric-audio-observation/v1",
      },
      registration: {
        ...fixture.registration,
        version: 5,
        deviceCanonicalPath: connected.canonicalPath,
        trackCanonicalPath: connected.canonicalTrackPath,
        nativeStatus: listenerNativeMetricStatusSchema.parse({
          ...fixture.registration.nativeStatus,
          ...(cold
            ? {
                readiness: "BLOCKED",
                reason: "fresh_per_pass_native_validation_required",
                executedGen: null,
              }
            : {}),
        }),
      },
    };
  }

  function join(report: ListenerBindingDescriptor) {
    return resolve({
      selected: {
        ...selected,
        connectionId: report.connectionId,
        producerId: report.producer.producerId,
        instanceId: report.producer.instanceId,
        connectionEpoch: report.registration.connectionEpoch,
      },
      connected: [report],
    });
  }

  it.each([true, false])(
    "binds cold=%s metadata without promoting approximate timing or ownership to DSP proof",
    (cold) => {
      const report = metricDescriptor(cold);
      const before = structuredClone(report);
      const candidate = readConnectedListenerBinding(report);
      expect(candidate.ok).toBe(true);
      if (!candidate.ok) throw new Error(candidate.reason);
      expect(candidate.connection.nativeStatus).toEqual(
        report.registration.nativeStatus,
      );
      expect(candidate.connection.capabilities).toEqual(
        report.registration.capabilities,
      );
      const result = join(report);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.target).toEqual(target);
      expect(result.connection.nativeStatus.readiness).toBe(
        cold ? "BLOCKED" : "READY",
      );
      expect(report).toEqual(before);
      expect(
        resolve({
          selected: {
            ...result.connection,
            expectedTarget: target,
          },
          connected: [candidate.connection],
        }).ok,
      ).toBe(true);
    },
  );

  it.each([
    { version: undefined },
    { version: 4 },
    { version: 6 },
    { capabilities: undefined },
    { capabilities: [] },
    { capabilities: ["audio-listener/dual-mode-v1"] },
    {
      capabilities: [
        "audio-listener/independent-metric-timelines-v1",
        "audio-listener/independent-metric-timelines-v1",
      ],
    },
    {
      capabilities: ["audio-listener/independent-metric-timelines-v1"],
    },
    {
      capabilities: [
        "audio-listener/independent-metric-timelines-v1",
        "unknown",
      ],
    },
    { algorithmVersion: undefined },
    { algorithmVersion: "2.0.0" },
    { sampleRate: undefined },
    { vectorSize: undefined },
    { nativeStatus: undefined },
    { nativeStatus: { version: 4 } },
    { connectionEpoch: "not-an-authenticated-uuid" },
  ])("rejects missing, unknown or mismatched registration %j", (change) => {
    const report = metricDescriptor();
    Object.assign(report.registration, change);
    expect(readConnectedListenerBinding(report).ok).toBe(false);
  });

  it.each([
    "audio-observation/v1",
    "audio-observation/v2",
    "metric-audio-observation/v2",
    "session-audio-observation/v1",
  ])("rejects v5 paired with producer schema %s", (schemaVersion) => {
    const report = metricDescriptor();
    expect(
      readConnectedListenerBinding({
        ...report,
        producer: { ...report.producer, schemaVersion },
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it.each([1, 2, 3, 4, 6])(
    "rejects superseded or unknown native version %s without fallback",
    (version) => {
      const report = descriptor({
        deviceCanonicalPath: connected.canonicalPath,
        trackCanonicalPath: connected.canonicalTrackPath,
        nativeStatus: { ...blocked, version },
      });
      expect(
        readConnectedListenerBinding({
          ...report,
          producer: {
            ...report.producer,
            schemaVersion: "metric-audio-observation/v1",
          },
        }),
      ).toEqual({ ok: false, reason: "invalid-input" });
    },
  );

  it.each([
    "version",
    "connectionEpoch",
    "capabilities",
    "algorithmVersion",
    "sampleRate",
    "vectorSize",
    "nativeStatus",
    "deviceCanonicalPath",
    "trackCanonicalPath",
  ] as const)("rejects inherited %s claims", (key) => {
    const report = metricDescriptor();
    const inherited = { [key]: report.registration[key] };
    const registration = { ...report.registration };
    delete registration[key];
    Object.setPrototypeOf(registration, inherited);
    expect(readConnectedListenerBinding({ ...report, registration }).ok).toBe(
      false,
    );
  });

  it.each([
    { sampleRate: 44_100 },
    { sampleRate: 96_000 },
    { vectorSize: 128 },
    { connectionEpoch: "11111111-1111-4111-8111-111111111111" },
  ])("rejects READY metadata inconsistent with executed Gen %j", (change) => {
    const report = metricDescriptor(false);
    Object.assign(report.registration, change);
    expect(readConnectedListenerBinding(report)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("rejects READY evidence from a different authenticated connection", () => {
    const report = metricDescriptor(false);
    expect(
      readConnectedListenerBinding({
        ...report,
        connectionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("does not mistake idle readiness or forged epoch for executed DSP", () => {
    const report = metricDescriptor(false);
    const proof = createSyntheticMetricWireFixture();
    for (const executedGen of [
      proof.ready,
      {
        ...proof.proof.armed,
        ownership: { ...proof.proof.armed.ownership, nativeEpoch: 2 },
      },
    ]) {
      Object.assign(report.registration, {
        nativeStatus: {
          ...report.registration.nativeStatus,
          executedGen,
        },
      });
      expect(readConnectedListenerBinding(report)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("keeps stale inspection, source identity and placement guards strict", () => {
    const report = metricDescriptor();
    const candidate = readConnectedListenerBinding(report);
    if (!candidate.ok) throw new Error(candidate.reason);
    expect(
      resolve({
        selected: candidate.connection,
        connected: [report],
        queryId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ ok: false, reason: "stale-inspection" });
    expect(
      resolve({
        selected: {
          ...candidate.connection,
          instanceId: "stale-instance",
        },
        connected: [report],
      }),
    ).toEqual({ ok: false, reason: "stale-connection" });
    expect(
      resolve({
        selected: {
          ...candidate.connection,
          expectedTarget: {
            ...target,
            expectedDeviceReference: "11111111-1111-4111-8111-111111111111",
          },
        },
        connected: [report],
      }),
    ).toEqual({ ok: false, reason: "stale-target" });
    const stale = inspection();
    stale.listeners[0]!.enabled = false;
    expect(
      resolve({
        selected: candidate.connection,
        connected: [report],
        inspection: stale,
      }),
    ).toEqual({ ok: false, reason: "inactive" });
    expect(
      readConnectedListenerBinding({
        ...report,
        registration: {
          ...report.registration,
          trackCanonicalPath: "live_set tracks 1",
        },
      }),
    ).toEqual({ ok: false, reason: "unattested-path" });
  });

  it("requires the same metric capability on flattened binding metadata", () => {
    const candidate = readConnectedListenerBinding(metricDescriptor());
    if (!candidate.ok) throw new Error(candidate.reason);
    const invalid = structuredClone(candidate.connection);
    Object.assign(invalid, { capabilities: undefined });
    expect(
      resolve({
        selected: candidate.connection,
        connected: [invalid],
      }),
    ).toEqual({ ok: false, reason: "invalid-input" });
  });
});

describe("independent canonical listener binding", () => {
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
  it("rejects capability aliases and missing native status without fallback", () => {
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
    { connectionEpoch: "11111111-1111-4111-8111-111111111111" },
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
      connectionId: "11111111-1111-4111-8111-111111111111",
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
    const nonAudio = structuredClone(connected);
    Object.assign(nonAudio, {
      signalKind: "midi",
      schemaVersion: "midi-sample/v1",
    });
    expect(resolve({ connected: [nonAudio] })).toEqual({
      ok: false,
      reason: "invalid-input",
    });
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
