import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCorrelationContext } from "@ableton-agent/correlation";
import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  PROTOCOL_VERSION,
  type CapabilityDocument,
  type InspectSessionListeningSourceResult,
  type SessionListeningPassParams,
  type SessionListeningPassResult,
} from "@ableton-agent/protocol";
import { createSessionSourceDriver } from "./session-listening-driver.js";

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

describe("guarded Session source driver", () => {
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
