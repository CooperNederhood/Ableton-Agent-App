import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertNativeMetricReadyProof,
  assertNativeMetricSourceCoverage,
  createMetricListeningGeometry,
  metricAudioObservationSchema,
  nativeMetricListeningConfigSchema,
  nativeMetricReadyProofSchema,
  nativeMetricSourceCoverageProofSchema,
} from "@ableton-agent/protocol";
import {
  listenerControlMetricSchema,
  listenerMetricWireIdentitySchema,
  listenerRegistrationMetricSchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
} from "./listener-metric-contracts.js";
import {
  bindMetricFixtureToControl,
  createSyntheticMetricWireFixture,
  type NativeHostClockRow,
  type SyntheticMetricWireFixture,
} from "./listener-metric-test-support.js";

const ownershipKeys = [
  "listenerId",
  "passId",
  "connectionId",
  "connectionEpoch",
  "generation",
  "traceId",
  "correlationId",
  "causationId",
] as const;

function prepare(fixture: SyntheticMetricWireFixture) {
  return listenerControlMetricSchema.parse({
    ...fixture.wire,
    type: "listener.control",
    action: "prepare",
    listenerId: "actual-host-listener",
    passId: "actual-host-pass",
    connectionId: randomUUID(),
    connectionEpoch: randomUUID(),
    generation: randomUUID(),
    traceId: randomUUID(),
    correlationId: "actual-host-correlation",
    causationId: "actual-host-causation",
    requestId: "actual-host-request",
    jobId: "actual-host-job",
    sequence: 41,
    config: fixture.config,
  });
}

function owners(fixture: SyntheticMetricWireFixture) {
  return [
    fixture.wire,
    fixture.ready.ownership,
    fixture.proof.armed.ownership,
    fixture.proof.launched.ownership,
    fixture.observation.ownership,
    fixture.registration.nativeStatus.executedGen.ownership,
  ];
}

describe("source-only SYNTHETIC metric wire fixture", () => {
  it.each(["arrangement", "session"] as const)(
    "constructs canonical %s DTOs without a loader facade or physical proof claim",
    (mode) => {
      for (const partial of [false, true]) {
        const fixture = createSyntheticMetricWireFixture(mode, partial);
        expect(listenerMetricWireIdentitySchema.parse(fixture.wire)).toEqual(
          fixture.wire,
        );
        expect(nativeMetricListeningConfigSchema.parse(fixture.config)).toEqual(
          fixture.config,
        );
        expect(nativeMetricReadyProofSchema.parse(fixture.ready)).toEqual(
          fixture.ready,
        );
        expect(
          nativeMetricSourceCoverageProofSchema.parse(fixture.proof),
        ).toEqual(fixture.proof);
        expect(metricAudioObservationSchema.parse(fixture.observation)).toEqual(
          fixture.observation,
        );
        expect(
          listenerRegistrationMetricSchema.parse(fixture.registration),
        ).toEqual(fixture.registration);
        expect(
          listenerResultMetricSchema.parse({
            ...fixture.wire,
            type: "listener.result",
            status: partial ? "partial" : "completed",
            observation: fixture.observation,
            nativeSourceCoverage: fixture.proof,
          }).observation,
        ).toEqual(fixture.observation);
        expect(fixture.observation.limitations).toContain(
          "Synthetic contract fixture; not actual audio evidence",
        );
        expect(fixture.observation.outcome).toBe(
          partial ? "partial" : "complete",
        );
        expect(fixture.ready.configurationEvidence).toBe(
          "admitted-not-executed",
        );
        expect(fixture.ready.phase).toBe("idle-preflight");
      }
    },
  );

  it("preserves the original constructor's large geometry, epoch and clock-counter constants", () => {
    const fixture = createSyntheticMetricWireFixture(
      "arrangement",
      false,
      true,
    );
    expect(fixture.config.geometry.startSample).toBe(0);
    expect(fixture.config.geometry.tempoBpm).toBe(999);
    expect(fixture.config.geometry.endBeat).toBe(80);
    expect(fixture.observation.geometry.startSample).toBe(200_000);
    expect(fixture.proof.armed.ownership.nativeEpoch).toBe(1);
    expect(fixture.proof.armed.receipt.timing[5]).toBe(199_000);
    expect(fixture.proof.launched.timing[6]).toBe(200_000);
    const row: NativeHostClockRow = fixture.proof.armed.before.frames[0]!;
    expect(row).toEqual([
      0, 0, 982_616, 31, 182_616, 0.618, 182_616, 0, 0, 982_616, 31,
    ]);
  });

  it.each(["arrangement", "session"] as const)(
    "clones and binds all %s ownership locations without mutating either argument",
    (mode) => {
      for (const partial of [false, true]) {
        const fixture = createSyntheticMetricWireFixture(mode, partial);
        const control = prepare(fixture);
        const original = structuredClone(fixture);
        const actualControl = structuredClone(control);
        const bound = bindMetricFixtureToControl(fixture, control);
        expect(fixture).toEqual(original);
        expect(control).toEqual(actualControl);
        expect(bound).not.toBe(fixture);
        for (const owner of owners(bound)) {
          for (const key of ownershipKeys)
            expect(owner[key]).toBe(control[key]);
        }
        expect(bound.registration.connectionEpoch).toBe(
          control.connectionEpoch,
        );
        expect(
          listenerRegistrationMetricSchema.parse(bound.registration),
        ).toEqual(bound.registration);
        expect(bound.observation.outcome).toBe(
          partial ? "partial" : "complete",
        );
        expect(bound.observation.source).toEqual(original.observation.source);
        for (const [status, key] of [
          ["ready", "nativeReady"],
          ["armed", "nativeArm"],
        ] as const) {
          expect(
            listenerReplyMetricSchema.safeParse({
              ...bound.wire,
              type: "listener.reply",
              status,
              [key]: status === "ready" ? bound.ready : bound.proof.armed,
            }).success,
          ).toBe(true);
        }
        expect(
          listenerResultMetricSchema.safeParse({
            ...bound.wire,
            type: "listener.result",
            status: partial ? "partial" : "completed",
            observation: bound.observation,
            nativeSourceCoverage: bound.proof,
          }).success,
        ).toBe(true);
      }
    },
  );

  it("changes no values outside the explicit owner whitelist, including all 32-row numeric clock arrays", () => {
    const fixture = createSyntheticMetricWireFixture();
    const control = prepare(fixture);
    const bound = bindMetricFixtureToControl(fixture, control);
    expect(bound.wire.requestId).toBe(fixture.wire.requestId);
    expect(bound.wire.jobId).toBe(fixture.wire.jobId);
    expect(bound.wire.sequence).toBe(fixture.wire.sequence);
    expect(bound.wire.requestId).not.toBe(control.requestId);
    expect(bound.wire.jobId).not.toBe(control.jobId);
    expect(bound.wire.sequence).not.toBe(control.sequence);
    expect(bound.proof.armed.before.frames).toHaveLength(32);
    expect(bound.proof.after.frames).toHaveLength(32);
    expect(bound.ready.before.frames).toHaveLength(32);
    for (const rows of [
      bound.proof.armed.before.frames,
      bound.proof.after.frames,
      bound.ready.before.frames,
    ]) {
      expect(
        rows.every(
          (row) =>
            row.length === 11 &&
            row.every(
              (value) => typeof value === "number" && Number.isFinite(value),
            ),
        ),
      ).toBe(true);
    }
    expect(bound.proof.armed.before).toEqual(fixture.proof.armed.before);
    expect(bound.proof.after).toEqual(fixture.proof.after);
    expect(bound.proof.completion).toEqual(fixture.proof.completion);
    expect(bound.proof.timingWitnesses).toEqual(fixture.proof.timingWitnesses);
    expect(bound.proof.armed.ownership.nativeEpoch).toBe(
      fixture.proof.armed.ownership.nativeEpoch,
    );
    expect(bound.proof.launched.ownership.nativeEpoch).toBe(
      fixture.proof.launched.ownership.nativeEpoch,
    );
    expect(bound.ready.ownership.nativeEpoch).toBe(
      fixture.ready.ownership.nativeEpoch,
    );
    expect(bound.observation.ownership.nativeEpoch).toBe(
      fixture.observation.ownership.nativeEpoch,
    );
    for (const owner of owners(bound)) {
      for (const key of ownershipKeys) owner[key] = fixture.wire[key];
    }
    bound.registration.connectionEpoch = fixture.registration.connectionEpoch;
    expect(bound).toEqual(fixture);
  });

  it("retains a self-consistent WRONG capture range so the actual job expectation denies it", () => {
    const fixture = createSyntheticMetricWireFixture();
    const control = prepare(fixture);
    if (!control.config) throw new Error("Synthetic prepare requires config");
    control.config.geometry = createMetricListeningGeometry({
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 120,
      startBeat: 0,
      endBeat: 2,
      startSample: 0,
    });
    const bound = bindMetricFixtureToControl(fixture, control);
    expect(bound.config).toEqual(fixture.config);
    expect(bound.proof.armed.config).toEqual(fixture.proof.armed.config);
    expect(bound.ready.config).toEqual(fixture.ready.config);
    expect(bound.observation.geometry).toEqual(fixture.observation.geometry);
    expect(bound.config.geometry.endBeat).toBe(1);
    expect(
      nativeMetricSourceCoverageProofSchema.safeParse(bound.proof).success,
    ).toBe(true);
    const expected = { ...bound.proof.armed.ownership, config: control.config };
    expect(() => assertNativeMetricReadyProof(bound.ready, expected)).toThrow(
      "native_metric_owner_or_config_mismatch",
    );
    expect(() =>
      assertNativeMetricSourceCoverage(bound.proof, expected),
    ).toThrow("native_metric_owner_or_config_mismatch");
  });

  it("does not fit frozen detector settings to a different admitted job", () => {
    const fixture = createSyntheticMetricWireFixture();
    const control = prepare(fixture);
    if (!control.config?.attacks)
      throw new Error("Synthetic prepare requires attack settings");
    control.config.attacks.thresholdDb++;
    const bound = bindMetricFixtureToControl(fixture, control);
    expect(bound.config.attacks).toEqual(fixture.config.attacks);
    expect(bound.observation.metrics.attacks.algorithm).toEqual(
      fixture.observation.metrics.attacks.algorithm,
    );
    expect(() =>
      assertNativeMetricSourceCoverage(bound.proof, {
        ...bound.proof.armed.ownership,
        config: control.config!,
      }),
    ).toThrow("native_metric_owner_or_config_mismatch");
  });

  it("preserves Session target/references even when UUIDs resemble ownership or the job requests a different target", () => {
    const fixture = createSyntheticMetricWireFixture("session", true);
    const control = prepare(fixture);
    if (control.config?.mode !== "session" || fixture.config.mode !== "session")
      throw new Error("Synthetic Session config required");
    control.config.source.target.expectedClipReference = randomUUID();
    const bound = bindMetricFixtureToControl(fixture, control);
    expect(bound.config).toEqual(fixture.config);
    expect(bound.observation.source).toEqual(fixture.observation.source);
    expect(bound.proof.armed.config).toEqual(fixture.proof.armed.config);
    if (bound.config.mode !== "session")
      throw new Error("Session mode must be retained");
    expect(bound.config.source.target.expectedClipReference).toBe(
      fixture.config.source.target.expectedClipReference,
    );
    expect(bound.config.source.target.expectedClipReference).not.toBe(
      bound.wire.connectionId,
    );
    expect(() =>
      assertNativeMetricSourceCoverage(bound.proof, {
        ...bound.proof.armed.ownership,
        config: control.config!,
      }),
    ).toThrow("native_metric_owner_or_config_mismatch");
  });

  it("does not repair a fixture mode mismatch against a valid different-mode control", () => {
    const fixture = createSyntheticMetricWireFixture();
    const control = prepare(createSyntheticMetricWireFixture("session"));
    const bound = bindMetricFixtureToControl(fixture, control);
    expect(bound.wire.mode).toBe("arrangement");
    expect(bound.config.mode).toBe("arrangement");
    expect(bound.observation.source.view).toBe("arrangement");
    expect(() =>
      assertNativeMetricReadyProof(bound.ready, {
        ...bound.ready.ownership,
        config: control.config!,
      }),
    ).toThrow("native_metric_owner_or_config_mismatch");
  });

  it("validates the actual control canonically instead of accepting an untyped loader facade", () => {
    const fixture = createSyntheticMetricWireFixture();
    const control = prepare(fixture);
    for (const patch of [
      { generation: "not-a-uuid" },
      { listenerVersion: 4 },
      { type: "other.control" },
      { config: undefined },
    ]) {
      expect(() => {
        Reflect.apply(bindMetricFixtureToControl, undefined, [
          fixture,
          { ...control, ...patch },
        ]);
      }).toThrow();
    }
  });
});
