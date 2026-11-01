import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCorrelationContext } from "@ableton-agent/correlation";
import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  PROTOCOL_VERSION,
  type CapabilityDocument,
  type InspectSessionListeningSourceResult,
  type SessionListeningPassParams,
  type SessionListeningPassResult,
  readListeningFailureEvidence,
  type ListeningFailureEvidence,
} from "@ableton-agent/protocol";
import { createSessionSourceDriver } from "./session-listening-driver.js";
import { ListeningRuntimeRejection } from "./listening-failure.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  view: "session" as const,
  track: {
    kind: "regular" as const,
    index: 0,
    expectedReference: uuid(1),
    expectedName: "Track",
  },
  sceneIndex: 0,
  expectedClipReference: uuid(2),
  expectedClipName: "Clip",
};
const state = {
  transportPlaying: true,
  globalBeat: 12.2,
  startTimeBeats: 12,
  playingPosition: 0.2,
  targetPlaying: true,
  targetTriggered: false,
  targetRecording: false,
  playingSlotIndex: 0,
  firedSlotIndex: -1,
  selectedClipReference: target.expectedClipReference,
};
const source: InspectSessionListeningSourceResult = {
  schemaVersion: 1,
  queryId: uuid(9),
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
};
const commands = ["prepare", "launch", "inspect", "release"].map(
  (action) => `listening.${action}_session_pass`,
);

function fixture() {
  const controller = new AbortController();
  const pass = {
    passId: uuid(3),
    owner: { sessionId: "session", agentId: "agent", liveSetId: "set" },
    trace: {
      traceId: uuid(4),
      correlationId: "correlation",
      causationId: "cause",
    },
    signal: controller.signal,
  };
  const capabilities: CapabilityDocument = {
    selectedProtocolVersion: PROTOCOL_VERSION,
    liveVersion: "11.3.43",
    remoteScriptVersion: "test",
    liveSetId: "set",
    liveSetName: "Set",
    saved: true,
    diagnostics: [],
    capabilities: Object.fromEntries(
      [...commands, "listening.inspect_session_source"].map((name) => [
        name,
        true,
      ]),
    ),
    limits: { maxFrameBytes: 1_048_576, maxBatchItems: 128 },
  };
  let playing = false;
  const receipt = (
    params: SessionListeningPassParams,
  ): SessionListeningPassResult => ({
    schemaVersion: 1,
    ownerId: params.ownerId,
    passId: params.passId,
    status:
      params.action === "release"
        ? "released"
        : playing
          ? "playing"
          : "prepared",
    mutationState: playing ? "observed-playing" : "not-attempted",
    reason: null,
    cleanupPolicy: "leave-running",
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    lastObservedSource: structuredClone(state),
    sourceEpoch: playing
      ? {
          startTimeBeats: 12,
          clipReference: target.expectedClipReference,
          observedGlobalBeat: 12.2,
        }
      : null,
    followActionState: "unknown",
    limitations: ["Message-rate source evidence", "Unknown follow settings"],
    durationBeats: 4,
    expiresInMs: 39_000,
  });
  const sessionListeningPass = vi.fn<
    NonNullable<AbletonService["sessionListeningPass"]>
  >(async (params) => {
    if (params.action === "launch") playing = true;
    return receipt(params);
  });
  const inspectSessionListeningSource = vi.fn(async () => source);
  const ableton = {
    getCapabilities: vi.fn(async () => capabilities),
    sessionListeningPass,
    inspectSessionListeningSource,
  };
  const driver = createSessionSourceDriver(ableton);
  const prepare = () =>
    driver.prepare({
      pass,
      target,
      durationBeats: 4,
      expectedProjectRevision: 1,
      binding: {
        track: target.track,
        deviceIndex: 1,
        expectedDeviceReference: uuid(5),
        expectedDeviceName: "Listener",
        expectedClassName: "MxDeviceAudioEffect",
      },
      startBeat: 12,
    });
  return { controller, pass, capabilities, receipt, ableton, driver, prepare };
}

afterEach(() => vi.useRealTimers());

async function failure(promise: Promise<unknown>): Promise<{
  error: Error;
  evidence: ListeningFailureEvidence;
}> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  const result = readListeningFailureEvidence(error);
  expect(result.status).toBe("present");
  if (result.status !== "present")
    throw new Error("Session failure evidence missing");
  return { error: error as Error, evidence: result.evidence };
}

describe("guarded Session source driver", () => {
  it("reports exact missing capability and Live version operands before acquiring a lease", async () => {
    const f = fixture();
    f.capabilities.capabilities["listening.inspect_session_pass"] = false;
    const error = (await f.driver
      .assertAvailable()
      .catch((cause: unknown) => cause)) as ListeningRuntimeRejection;
    expect(error).toBeInstanceOf(ListeningRuntimeRejection);
    expect(error.rejectionFacts).toContainEqual({
      field: "capability.listening.inspect_session_pass",
      actual: { state: "observed", value: false },
      expected: { state: "observed", value: true },
    });
    expect(error.rejectionFacts).toContainEqual(
      expect.objectContaining({
        field: "driver.liveVersion",
        actual: { state: "observed", value: "11.3.43" },
        expected: { state: "observed", value: "11.x" },
      }),
    );
    expect(f.ableton.sessionListeningPass).not.toHaveBeenCalled();
  });

  it.each([
    ["ownerId", uuid(99), "receipt.ownerId"],
    ["passId", uuid(98), "receipt.passId"],
    ["durationBeats", 8, "receipt.durationBeats"],
  ] as const)(
    "attributes rejected %s receipts before cleanup with exact expected identity",
    async (key, value, field) => {
      const f = fixture();
      f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => ({
        ...f.receipt(params),
        [key]: value,
      }));
      const result = await failure(f.prepare());
      const prepare = f.ableton.sessionListeningPass.mock.calls[0]![0];
      const expected = key === "durationBeats" ? 4 : prepare[key];
      expect(result.error).toBeInstanceOf(ListeningRuntimeRejection);
      expect(result.evidence).toMatchObject({
        code: "session_source_receipt_mismatch",
        phase: "preparation",
        component: "session-source",
        reference: { ...f.pass.trace, passId: f.pass.passId },
        facts: expect.arrayContaining([
          {
            field,
            actual: { state: "observed", value },
            expected: { state: "observed", value: expected },
            ...(key === "durationBeats" ? { unit: "beats" } : {}),
          },
        ]) as unknown,
      });
      expect(
        f.ableton.sessionListeningPass.mock.calls.map(
          ([params]) => params.action,
        ),
      ).toEqual(["prepare", "release"]);
      await expect(f.prepare()).resolves.toBeDefined();
    },
  );

  it.each([
    ["invalidated", 1000, "session_source_invalid"],
    ["prepared", 0, "session_source_invalid"],
    ["accepted", 1000, "session_source_prepare_failed"],
  ] as const)(
    "records refused prepare status=%s and lease remaining=%s",
    async (status, expiresInMs, code) => {
      const f = fixture();
      f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => ({
        ...f.receipt(params),
        status,
        expiresInMs,
        reason: "token=private-value",
      }));
      const { evidence } = await failure(f.prepare());
      expect(evidence).toMatchObject({ code, phase: "preparation" });
      expect(evidence.facts).toContainEqual(
        expect.objectContaining({
          field: "receipt.status",
          actual: { state: "observed", value: status },
        }),
      );
      if (code === "session_source_invalid")
        expect(evidence.facts).toContainEqual(
          expect.objectContaining({
            field: "receipt.expiresInMs",
            actual: { state: "observed", value: expiresInMs },
            unit: "ms",
          }),
        );
      expect(JSON.stringify(evidence)).not.toContain("private-value");
    },
  );

  it("preserves schema exception identity with a typed bounded receipt predicate", async () => {
    const f = fixture();
    f.ableton.sessionListeningPass.mockImplementationOnce(
      async () => ({ status: "playing" }) as SessionListeningPassResult,
    );
    const { error, evidence } = await failure(f.prepare());
    expect(error.constructor.name).toBe("ZodError");
    expect(evidence).toMatchObject({
      code: "session.driver.receipt.schema",
      phase: "preparation",
      facts: expect.arrayContaining([
        {
          field: "schema.valid",
          actual: { state: "observed", value: false },
          expected: { state: "observed", value: true },
        },
      ]) as unknown,
    });
    expect(
      f.ableton.sessionListeningPass.mock.calls.map(
        ([params]) => params.action,
      ),
    ).toEqual(["prepare", "release"]);
  });

  it("retains immutable initiating evidence when release also rejects", async () => {
    const f = fixture();
    f.ableton.sessionListeningPass.mockImplementation(async (params) => ({
      ...f.receipt(params),
      status: params.action === "prepare" ? "invalidated" : "prepared",
      reason: "primary denied",
    }));
    const { error, evidence } = await failure(f.prepare());
    expect(error).toBeInstanceOf(AggregateError);
    expect(evidence.code).toBe("session_source_invalid");
    const errors = (error as AggregateError).errors as Error[];
    expect(readListeningFailureEvidence(errors[1])).toMatchObject({
      status: "present",
      evidence: {
        code: "session_source_release_unconfirmed",
        phase: "cleanup",
      },
    });
    expect(
      Object.isFrozen(
        Object.getOwnPropertyDescriptor(errors[0], "failureEvidence")!.value,
      ),
    ).toBe(true);
  });

  it("reports the exact five-second launch deadline without replaying or stopping the accepted launch", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const lease = await f.prepare();
    f.ableton.sessionListeningPass.mockImplementation(async (params) => ({
      ...f.receipt(params),
      status: params.action === "release" ? "released" : "queued",
    }));
    const pending = failure(lease.launch(f.controller.signal));
    await vi.advanceTimersByTimeAsync(5_001);
    const { evidence } = await pending;
    expect(evidence).toMatchObject({
      code: "session_launch_unverified",
      phase: "launch",
    });
    expect(evidence.facts).toContainEqual({
      field: "launch.elapsedMs",
      actual: { state: "observed", value: 5_001 },
      expected: { state: "observed", value: 5_000 },
      comparison: "at-most",
      unit: "ms",
    });
    expect(evidence.facts).toContainEqual(
      expect.objectContaining({
        field: "receipt.sourceEpoch.present",
        actual: { state: "observed", value: false },
      }),
    );
    await lease.release();
    expect(
      f.ableton.sessionListeningPass.mock.calls.filter(
        ([params]) => params.action === "launch",
      ),
    ).toHaveLength(1);
  });

  it("reports an independently bounded release timeout after cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const lease = await f.prepare();
    f.controller.abort();
    f.ableton.sessionListeningPass.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const pending = failure(lease.release());
    await vi.advanceTimersByTimeAsync(10_001);
    const { evidence } = await pending;
    expect(evidence).toMatchObject({
      code: "cleanup_timeout",
      phase: "cleanup",
    });
    expect(evidence.facts).toContainEqual(
      expect.objectContaining({
        field: "cleanup.elapsedMs",
        actual: { state: "observed", value: 10_000 },
        expected: { state: "observed", value: 10_000 },
        unit: "ms",
      }),
    );
    expect(evidence.facts).toContainEqual(
      expect.objectContaining({
        field: "cleanup.cancelled",
        actual: { state: "observed", value: true },
      }),
    );
  });

  it("distinguishes seal-before-launch and release-before-launch predicates without mutations", async () => {
    const f = fixture();
    const lease = await f.prepare();
    expect(
      (await failure(lease.seal(f.controller.signal))).evidence,
    ).toMatchObject({
      code: "session_launch_required",
      facts: [
        {
          field: "launch.requested",
          actual: { state: "observed", value: false },
          expected: { state: "observed", value: true },
        },
      ],
    });
    await lease.release();
    expect(
      (await failure(lease.launch(f.controller.signal))).evidence,
    ).toMatchObject({
      code: "session_source_released",
      facts: expect.arrayContaining([
        {
          field: "launch.dispatched",
          actual: { state: "observed", value: false },
        },
      ]) as unknown,
    });
    expect(
      f.ableton.sessionListeningPass.mock.calls.map(
        ([params]) => params.action,
      ),
    ).toEqual(["prepare", "release"]);
  });

  it("distinguishes absent epochs from changed epoch values during continuity", async () => {
    const f = fixture();
    const lease = await f.prepare();
    await lease.launch(f.controller.signal);
    f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => ({
      ...f.receipt(params),
      status: "accepted",
      mutationState: "indeterminate",
      sourceEpoch: null,
    }));
    const { evidence } = await failure(
      lease.assertCurrent(f.controller.signal),
    );
    expect(evidence).toMatchObject({
      code: "session_source_epoch_changed",
      coverage: "partial",
      coverageReasons: ["missing-operands"],
    });
    expect(evidence.facts).toContainEqual({
      field: "receipt.sourceEpoch.startTimeBeats",
      actual: { state: "unavailable", reason: "not-reported" },
      expected: { state: "observed", value: 12 },
      unit: "beats",
    });
    await lease.release();
  });

  it("records exact mismatched playing witness without publishing or relaunching", async () => {
    const f = fixture();
    const lease = await f.prepare();
    f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => ({
      ...f.receipt(params),
      status: "playing",
      mutationState: "observed-playing",
      sourceEpoch: {
        clipReference: target.expectedClipReference,
        startTimeBeats: 12,
        observedGlobalBeat: 12.2,
      },
      lastObservedSource: { ...state, playingSlotIndex: 1 },
    }));
    const { evidence } = await failure(lease.launch(f.controller.signal));
    expect(evidence.facts).toContainEqual({
      field: "receipt.witness.playingSlotIndex",
      actual: { state: "observed", value: 1 },
      expected: { state: "observed", value: 0 },
    });
    await lease.release();
  });

  it("requires every real Live 11 capability without simulator fallback", async () => {
    const f = fixture();
    await f.driver.assertAvailable();
    f.capabilities.capabilities["listening.inspect_session_pass"] = false;
    await expect(f.driver.assertAvailable()).rejects.toThrow("all guarded");
    f.capabilities.capabilities["listening.inspect_session_pass"] = true;
    f.capabilities.liveVersion = "12.1";
    await expect(f.driver.assertAvailable()).rejects.toThrow("Live 11");
  });

  it("launches once, retains the original epoch, seals independently and releases once with attribution", async () => {
    const f = fixture();
    const contexts: unknown[] = [];
    f.ableton.sessionListeningPass.mockImplementation(async (params) => {
      contexts.push(currentCorrelationContext());
      const result = f.receipt(params);
      if (params.action !== "prepare") {
        result.status = params.action === "release" ? "released" : "playing";
        result.mutationState = "observed-playing";
        result.sourceEpoch = {
          startTimeBeats: 12,
          clipReference: target.expectedClipReference,
          observedGlobalBeat: 12.2,
        };
      }
      return result;
    });
    const lease = await f.prepare();
    const a = lease.launch(f.controller.signal);
    expect(lease.launch(f.controller.signal)).toBe(a);
    await expect(a).resolves.toMatchObject({
      clipStartTimeBeats: 12,
      observedAtGlobalBeat: 12.2,
    });
    await lease.assertCurrent(f.controller.signal);
    await expect(lease.seal(f.controller.signal)).resolves.toMatchObject({
      source,
      origin: { clipStartTimeBeats: 12 },
    });
    await Promise.all([lease.release(), lease.release()]);
    expect(
      f.ableton.sessionListeningPass.mock.calls.filter(
        ([params]) => params.action === "launch",
      ),
    ).toHaveLength(1);
    expect(
      f.ableton.sessionListeningPass.mock.calls.filter(
        ([params]) => params.action === "release",
      ),
    ).toHaveLength(1);
    for (const context of contexts)
      expect(context).toMatchObject({
        ...f.pass.trace,
        sessionId: "session",
        liveSetId: "set",
        activeAgentId: "agent",
      });
    expect(f.ableton.inspectSessionListeningSource).toHaveBeenCalledOnce();
  });

  it("never dispatches a launch cancelled before dispatch and cleans up independently", async () => {
    const f = fixture();
    const lease = await f.prepare();
    f.controller.abort();
    await expect(lease.launch(f.controller.signal)).rejects.toThrow();
    await lease.release();
    expect(
      f.ableton.sessionListeningPass.mock.calls.map(
        ([params]) => params.action,
      ),
    ).toEqual(["prepare", "release"]);
    const [params, options] = f.ableton.sessionListeningPass.mock.calls.at(-1)!;
    expect(params).toMatchObject({ action: "release", reason: "cancelled" });
    expect(options?.signal?.aborted).toBe(false);
  });

  it("release fences a later launch without stopping or relaunching", async () => {
    const f = fixture();
    const lease = await f.prepare();
    await lease.release();
    await expect(lease.launch(f.controller.signal)).rejects.toThrow(
      "No launch",
    );
    expect(
      f.ableton.sessionListeningPass.mock.calls.map(
        ([params]) => params.action,
      ),
    ).toEqual(["prepare", "release"]);
  });

  it("rejects a latched invalidation and changed epoch before publication", async () => {
    const f = fixture();
    const lease = await f.prepare();
    await lease.launch(f.controller.signal);
    f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => ({
      ...f.receipt(params),
      status: "invalidated",
      reason: "Clip was replaced",
    }));
    await expect(lease.assertCurrent(f.controller.signal)).rejects.toThrow(
      "Clip was replaced",
    );
    f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => {
      const result = f.receipt(params);
      if (result.sourceEpoch) {
        result.sourceEpoch.startTimeBeats = 13;
        result.sourceEpoch.observedGlobalBeat = 13.2;
      }
      result.lastObservedSource.globalBeat = 14;
      return result;
    });
    await expect(lease.seal(f.controller.signal)).rejects.toThrow(
      "epoch changed",
    );
    await lease.release();
  });

  it("rejects another owner's receipt and compensates a denied prepare", async () => {
    const f = fixture();
    f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => ({
      ...f.receipt(params),
      status: "invalidated",
      reason: "Missing public listener",
    }));
    await expect(f.prepare()).rejects.toThrow("Missing public listener");
    expect(f.ableton.sessionListeningPass.mock.calls.at(-1)?.[0].action).toBe(
      "release",
    );
    f.ableton.sessionListeningPass.mockImplementationOnce(async (params) => ({
      ...f.receipt(params),
      ownerId: uuid(100),
    }));
    await expect(f.prepare()).rejects.toThrow("ownership");
  });

  it("bounds unconfirmed cleanup independently after cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const lease = await f.prepare();
    f.controller.abort();
    f.ableton.sessionListeningPass.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const rejected = expect(lease.release()).rejects.toThrow("not confirmed");
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
  });

  it("awaits the existing launch receipt when native completion arrives first", async () => {
    const f = fixture();
    const lease = await f.prepare();
    let resolve!: (value: SessionListeningPassResult) => void;
    f.ableton.sessionListeningPass.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const launched = lease.launch(f.controller.signal);
    const sealed = lease.seal(f.controller.signal);
    expect(f.ableton.inspectSessionListeningSource).not.toHaveBeenCalled();
    const params = f.ableton.sessionListeningPass.mock.calls.at(-1)![0];
    f.ableton.sessionListeningPass.mockImplementation(async (request) => ({
      ...f.receipt(request),
      status: request.action === "release" ? "released" : "playing",
      mutationState: "observed-playing",
      sourceEpoch: {
        startTimeBeats: 12,
        clipReference: target.expectedClipReference,
        observedGlobalBeat: 12.2,
      },
    }));
    resolve(await f.ableton.sessionListeningPass(params));
    await launched;
    await sealed;
    await lease.release();
  });
});
