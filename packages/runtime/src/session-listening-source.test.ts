import { describe, expect, it } from "vitest";
import {
  inspectSessionListeningSourceResultSchema,
  createNativeListeningGeometry,
  createMetricListeningGeometry,
  readListeningFailureEvidence,
  listeningFailureFactSchema,
} from "@ableton-agent/protocol";
import {
  freezeSessionSourceExpectation,
  assertSessionSourceUnchanged,
  assertTransportCoupledSessionOrigin,
  assertSessionFirstIterationCoverage,
  attributeSessionRejection,
  assertSessionSignal,
} from "./session-listening-source.js";
import { ListeningRuntimeRejection } from "./listening-failure.js";

const target = {
  view: "session" as const,
  track: {
    kind: "regular" as const,
    index: 0,
    expectedReference: "00000000-0000-4000-8000-000000000001",
    expectedName: "Track",
  },
  sceneIndex: 0,
  expectedClipReference: "00000000-0000-4000-8000-000000000002",
  expectedClipName: "Clip",
};
function source() {
  const state = {
    transportPlaying: false,
    globalBeat: 0,
    startTimeBeats: -8,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: null,
  };
  return inspectSessionListeningSourceResultSchema.parse({
    schemaVersion: 1,
    queryId: "00000000-0000-4000-8000-000000000003",
    target,
    projectRevision: 1,
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    sourceKind: "midi",
    positionUnit: "beats",
    before: state,
    after: state,
    settings: {
      tempoBpm: 120,
      signatureNumerator: 4,
      signatureDenominator: 4,
      globalQuantization: 0,
      launchQuantization: 0,
      launchMode: 0,
      legato: false,
      followActionEnabled: null,
      startMarker: 0,
      endMarker: 8,
      loopStart: 0,
      loopEnd: 8,
      looping: true,
    },
  });
}
const origin = {
  clipReference: target.expectedClipReference,
  playingSlotIndex: 0,
  clipStartTimeBeats: 0,
  observedAtGlobalBeat: 0.2,
};
const pass = {
  passId: "source-pass",
  owner: { sessionId: "session", liveSetId: "set", agentId: "agent" },
  trace: {
    traceId: "00000000-0000-4000-8000-000000000004",
    correlationId: "source-correlation",
    causationId: "source-cause",
  },
};

function rejection(operation: () => unknown): ListeningRuntimeRejection {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ListeningRuntimeRejection);
    const rejected = error as ListeningRuntimeRejection;
    expect(rejected.rejectionFacts.length).toBeGreaterThan(0);
    for (const fact of rejected.rejectionFacts)
      expect(listeningFailureFactSchema.safeParse(fact).success).toBe(true);
    return rejected;
  }
  throw new Error("Expected a guarded Session rejection");
}

describe("Session source admission and independent transport join", () => {
  it.each([
    [
      "identity",
      {
        target: {
          ...target,
          expectedClipReference: "00000000-0000-4000-8000-000000000099",
        },
      },
      "stale_session_target",
      "source.target.expectedClipReference",
      "00000000-0000-4000-8000-000000000099",
      target.expectedClipReference,
    ],
    [
      "kind",
      { sourceKind: "unwarped-audio", positionUnit: "seconds" },
      "unsupported_session_source",
      "source.kind",
      "unwarped-audio",
      "midi|warped-audio",
    ],
    [
      "recording",
      { after: { ...source().after, targetRecording: true } },
      "session_launch_state_unknown_or_active",
      "source.after.targetRecording",
      true,
      false,
    ],
    [
      "transport continuity",
      { after: { ...source().after, globalBeat: 2 } },
      "session_transport_changed",
      "source.after.globalBeat",
      2,
      0,
    ],
    [
      "launch settings",
      { settings: { ...source().settings, launchMode: 1 } },
      "unsupported_session_launch_settings",
      "source.settings.launchMode",
      1,
      0,
    ],
    [
      "follow actions",
      { settings: { ...source().settings, followActionEnabled: true } },
      "session_follow_actions_enabled",
      "source.settings.followActionEnabled",
      true,
      "false|unknown",
    ],
    [
      "qualified anchor",
      {
        before: { ...source().before, globalBeat: 1 },
        after: { ...source().after, globalBeat: 1 },
      },
      "session_launch_case_unqualified",
      "source.startBeat",
      1,
      0,
    ],
    [
      "first iteration",
      { settings: { ...source().settings, loopEnd: 3 } },
      "session_first_iteration_exceeded",
      "request.durationBeats",
      4,
      3,
    ],
    [
      "quota",
      { settings: { ...source().settings, tempoBpm: 4 } },
      "native_capture_quota",
      "capture.durationMs",
      60_000,
      30_000,
    ],
  ] as const)(
    "records exact %s rejection operands at admission",
    (_name, changes, code, field, actual, expected) => {
      const error = rejection(() =>
        freezeSessionSourceExpectation({ ...source(), ...changes }, target, 4),
      );
      expect(error.code).toBe(code);
      expect(error.rejectionFacts).toContainEqual(
        expect.objectContaining({
          field,
          actual: { state: "observed", value: actual },
          expected: { state: "observed", value: expected },
        }),
      );
    },
  );

  it("does not invent zero for unavailable state or nonfinite durations", () => {
    const unknown = source();
    unknown.after.playingSlotIndex = null;
    expect(
      rejection(() => freezeSessionSourceExpectation(unknown, target, 4))
        .rejectionFacts,
    ).toContainEqual(
      expect.objectContaining({
        field: "source.after.playingSlotIndex",
        actual: { state: "unavailable", reason: "not-reported" },
      }),
    );
    expect(
      rejection(() => freezeSessionSourceExpectation(source(), target, NaN))
        .rejectionFacts,
    ).toContainEqual(
      expect.objectContaining({
        field: "request.durationBeats",
        actual: { state: "unavailable", reason: "nonfinite" },
      }),
    );
  });

  it("retains schema exception identity and attributes its typed predicate without retaining the raw snapshot", () => {
    let error: unknown;
    try {
      freezeSessionSourceExpectation(
        { ...source(), schemaVersion: 7 } as unknown as ReturnType<
          typeof source
        >,
        target,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor.name).toBe("ZodError");
    attributeSessionRejection(error, pass, "validation");
    expect(readListeningFailureEvidence(error)).toMatchObject({
      status: "present",
      evidence: {
        code: "session.source.schema",
        phase: "validation",
        component: "session-source",
        reference: { ...pass.trace, passId: pass.passId },
        facts: expect.arrayContaining([
          {
            field: "schema.valid",
            actual: { state: "observed", value: false },
            expected: { state: "observed", value: true },
          },
          {
            field: "schema.issue.0.value",
            actual: { state: "observed", value: 7 },
            expected: { state: "observed", value: 1 },
          },
        ]) as unknown,
      },
    });
  });

  it("records changed settings, rounded geometry operands and origin tolerance instead of opaque error codes", () => {
    const expected = freezeSessionSourceExpectation(source(), target, 4);
    const edited = source();
    edited.settings.loopEnd = 5;
    expect(
      rejection(() => assertSessionSourceUnchanged(expected, edited))
        .rejectionFacts,
    ).toContainEqual(
      expect.objectContaining({
        field: "source.settings.loopEnd",
        actual: { state: "observed", value: 5 },
        expected: { state: "observed", value: 8 },
      }),
    );
    const geometry = createNativeListeningGeometry({
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 120,
      startBeat: 0,
      endBeat: 4,
    });
    const rounded = rejection(() =>
      assertSessionFirstIterationCoverage(
        { ...expected, firstIterationEndBeat: 3.5 },
        geometry,
      ),
    );
    expect(rounded.rejectionFacts).toContainEqual(
      expect.objectContaining({
        field: "geometry.iterationExcessBeats",
        actual: { state: "observed", value: 0.5 },
        expected: { state: "observed", value: 120 / (120 * 48_000) + 1e-10 },
        unit: "beats",
        comparison: "at-most",
      }),
    );
    expect(
      rejection(() =>
        assertTransportCoupledSessionOrigin(expected, {
          ...origin,
          clipStartTimeBeats: 1,
        }),
      ).rejectionFacts,
    ).toContainEqual(
      expect.objectContaining({
        field: "origin.anchorToleranceBeats",
        actual: { state: "observed", value: 1e-8 },
      }),
    );
  });

  it("latches immutable primary attribution before cleanup and does not bless malformed or foreign evidence", () => {
    const primary = rejection(() =>
      freezeSessionSourceExpectation(source(), target, -1),
    );
    attributeSessionRejection(primary, pass, "validation");
    const first = readListeningFailureEvidence(primary);
    expect(first.status).toBe("present");
    const aggregate = new AggregateError(
      [primary, new Error("release failed")],
      "cleanup failed",
    );
    attributeSessionRejection(aggregate, pass, "cleanup");
    expect(readListeningFailureEvidence(aggregate)).toEqual(first);
    const evidence = Object.getOwnPropertyDescriptor(
      primary,
      "failureEvidence",
    )!.value as object;
    expect(Object.isFrozen(evidence)).toBe(true);
    for (const supplied of [
      { schema: "invalid" },
      {
        ...(first.status === "present" ? first.evidence : {}),
        reference: { ...pass.trace, passId: "foreign-pass" },
      },
    ]) {
      const rejected = rejection(() =>
        freezeSessionSourceExpectation(source(), target, -1),
      );
      Object.defineProperty(rejected, "failureEvidence", { value: supplied });
      attributeSessionRejection(rejected, pass, "validation");
      expect(
        Object.getOwnPropertyDescriptor(rejected, "failureEvidence")!.value,
      ).toBe(supplied);
    }
  });

  it("keeps cancellation reason identity and exact signal facts", () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    expect(() => assertSessionSignal(controller.signal, "source-test")).toThrow(
      reason,
    );
    attributeSessionRejection(reason, pass, "launch");
    expect(readListeningFailureEvidence(reason)).toMatchObject({
      status: "present",
      evidence: {
        code: "cancelled",
        phase: "launch",
        facts: [
          {
            field: "signal.aborted",
            actual: { state: "observed", value: true },
            expected: { state: "observed", value: false },
          },
          {
            field: "signal.check",
            actual: { state: "observed", value: "source-test" },
          },
        ],
      },
    });
  });

  it.each(["midi", "warped-audio"] as const)(
    "freezes %s metadata without attributing historical start_time",
    (kind) => {
      const snapshot = source();
      snapshot.sourceKind = kind;
      const expected = freezeSessionSourceExpectation(snapshot, target, 4);
      expect(expected).toMatchObject({
        startBeat: 0,
        endBeat: 4,
        followActions: "unknown",
      });
      expect(expected.limitations.join(" ")).toContain("message-rate");
      snapshot.settings.loopEnd = 1;
      expect(expected.source.settings.loopEnd).toBe(8);
      expect(Object.isFrozen(expected.source.target.track)).toBe(true);
      expect(() =>
        assertTransportCoupledSessionOrigin(expected, origin),
      ).not.toThrow();
    },
  );

  it.each([
    { sourceKind: "unwarped-audio" as const, positionUnit: "seconds" as const },
    { sourceKind: "unknown" as const, positionUnit: null },
    { after: { ...source().after, transportPlaying: true } },
    { before: { ...source().before, firedSlotIndex: 0 } },
    { after: { ...source().after, targetTriggered: true } },
    { settings: { ...source().settings, launchQuantization: 5 } },
    { settings: { ...source().settings, globalQuantization: 8 } },
    { settings: { ...source().settings, launchMode: 1 } },
    { settings: { ...source().settings, legato: true } },
    { settings: { ...source().settings, followActionEnabled: true } },
    {
      settings: {
        ...source().settings,
        followActionEnabled: null,
        looping: null,
      },
    },
    { settings: { ...source().settings, loopStart: 1 } },
    { settings: { ...source().settings, startMarker: 1 } },
    { settings: { ...source().settings, loopEnd: 3 } },
    { settings: { ...source().settings, tempoBpm: null } },
    { settings: { ...source().settings, signatureNumerator: 3 } },
    {
      before: { ...source().before, globalBeat: 12.2 },
      after: { ...source().after, globalBeat: 12.2 },
    },
    { after: { ...source().after, globalBeat: 16 } },
    { target: { ...target, expectedClipName: "Replacement" } },
  ])("refuses unsupported or unknown admission metadata: %j", (change) => {
    expect(() =>
      freezeSessionSourceExpectation({ ...source(), ...change }, target, 4),
    ).toThrow();
  });

  it.each([
    [0, 4],
    [4, 0],
    [12, 0],
    [0.25, 0],
    [12, 4],
    [12.25, 4],
  ])(
    "refuses the unqualified stopped anchor %s with global quantization %s",
    (globalBeat, globalQuantization) => {
      const snapshot = source();
      snapshot.before.globalBeat = snapshot.after.globalBeat = globalBeat;
      snapshot.settings.globalQuantization = globalQuantization;
      expect(() => freezeSessionSourceExpectation(snapshot, target, 4)).toThrow(
        "session_launch_case_unqualified",
      );
    },
  );

  it("retains known-disabled follow state for the qualified launch case", () => {
    const snapshot = source();
    snapshot.settings.followActionEnabled = false;
    expect(freezeSessionSourceExpectation(snapshot, target, 4)).toMatchObject({
      startBeat: 0,
      followActions: "disabled",
    });
  });

  it.each([true, false])(
    "captures the exact active boundary with looping=%s",
    (looping) => {
      const snapshot = source();
      snapshot.settings.looping = looping;
      snapshot.settings[looping ? "loopEnd" : "endMarker"] = 4;
      expect(
        freezeSessionSourceExpectation(snapshot, target, 4).durationBeats,
      ).toBe(4);
    },
  );

  it("defaults to the active loop, not underlying file end, and permits an explicit shorter region", () => {
    const snapshot = source();
    snapshot.sourceKind = "warped-audio";
    snapshot.settings.endMarker = 200;
    snapshot.settings.loopEnd = 8.125;
    expect(freezeSessionSourceExpectation(snapshot, target).durationBeats).toBe(
      8.125,
    );
    expect(
      freezeSessionSourceExpectation(snapshot, target, 2.25).durationBeats,
    ).toBe(2.25);
    snapshot.settings.looping = false;
    expect(() => freezeSessionSourceExpectation(snapshot, target)).toThrow(
      "native_capture_quota",
    );
    snapshot.settings.endMarker = 6.25;
    snapshot.settings.loopEnd = 1;
    expect(freezeSessionSourceExpectation(snapshot, target).durationBeats).toBe(
      6.25,
    );
  });

  it("rejects oversized full loops rather than silently truncating", () => {
    const snapshot = source();
    snapshot.settings.loopEnd = 60.01;
    expect(() => freezeSessionSourceExpectation(snapshot, target)).toThrow(
      "native_capture_quota",
    );
    expect(
      freezeSessionSourceExpectation(snapshot, target, 4).durationBeats,
    ).toBe(4);
  });

  it.each([
    { clipReference: "other" },
    { playingSlotIndex: 1 },
    { clipStartTimeBeats: 16 },
    { clipStartTimeBeats: -4 },
    { observedAtGlobalBeat: 11 },
    { observedAtGlobalBeat: 20 },
  ])(
    "does not join another epoch or a delayed/wrapped origin: %j",
    (change) => {
      const expected = freezeSessionSourceExpectation(source(), target, 4);
      expect(() =>
        assertTransportCoupledSessionOrigin(expected, { ...origin, ...change }),
      ).toThrow();
    },
  );

  it("rechecks the settings/identity fingerprint without confusing dynamic launch changes with edits", () => {
    const expected = freezeSessionSourceExpectation(source(), target, 4);
    const latest = source();
    latest.after.transportPlaying = true;
    latest.after.globalBeat = 1;
    latest.after.startTimeBeats = 0;
    latest.after.targetPlaying = true;
    expect(() => assertSessionSourceUnchanged(expected, latest)).not.toThrow();
    latest.settings.loopEnd = 16;
    expect(() => assertSessionSourceUnchanged(expected, latest)).toThrow(
      "session_source_changed",
    );
  });

  it.each([
    ["legacy", 44_100],
    ["legacy", 48_000],
    ["metric", 44_100],
    ["metric", 48_000],
  ] as const)(
    "permits only the half-sample rounding tail for %s at %s Hz",
    (kind, sampleRate) => {
      const snapshot = source();
      snapshot.settings.tempoBpm = 128;
      snapshot.settings.loopEnd = 4.00001;
      const expected = freezeSessionSourceExpectation(snapshot, target, 4);
      const input = {
        sampleRate,
        vectorSize: 64,
        tempoBpm: 128,
        startBeat: 0,
        endBeat: 4,
      };
      const geometry =
        kind === "metric"
          ? createMetricListeningGeometry({ ...input, startSample: 0 })
          : createNativeListeningGeometry(input);
      expect(() =>
        assertSessionFirstIterationCoverage(expected, geometry),
      ).not.toThrow();
      expect(() =>
        assertSessionFirstIterationCoverage(
          { ...expected, firstIterationEndBeat: 3.9999 },
          geometry,
        ),
      ).toThrow("session_first_iteration_exceeded");
      snapshot.settings.loopEnd = 8;
      expect(() =>
        assertSessionFirstIterationCoverage(
          freezeSessionSourceExpectation(snapshot, target, 4),
          geometry,
        ),
      ).not.toThrow();
    },
  );
});
