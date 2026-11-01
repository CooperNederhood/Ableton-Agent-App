import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  reviewNativeScenario,
  nativeRepeatedSessionSteps,
  admitNativeScenarios,
} from "./native-listening-runner.mjs";
import {
  verifySwitchingSessionReset,
  verifySwitchingNativeMetricPasses,
  switchingSessionStopParams,
} from "./native-metric-scenario.mjs";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";
import { createRepeatedSessionApprovals } from "./native-session-listening-scenario.mjs";
import { createNativeScenarioApproval } from "./native-listening-verification.mjs";

const load = async () =>
  JSON.parse(
    await readFile(
      "integration/live-scenarios/native-metric-session-midi-audio-midi.json",
      "utf8",
    ),
  );
const target = (index) => ({
  view: "session",
  track: {
    kind: "regular",
    index: index === 0 ? 0 : 2,
    expectedReference: `track-${index}`,
  },
  sceneIndex: 0,
  expectedClipReference: `clip-${index}`,
});
const sources = (playing = false) =>
  [0, 1].map((index) => {
    const sourceTarget = target(index);
    const state = {
      targetPlaying: playing && index === 0,
      targetTriggered: false,
      targetRecording: false,
      playingSlotIndex: playing && index === 0 ? 0 : -1,
      firedSlotIndex: -1,
      selectedClipReference: sourceTarget.expectedClipReference,
      transportPlaying: playing,
      globalBeat: playing ? 4 : 0,
    };
    return { target: sourceTarget, before: { ...state }, after: { ...state } };
  });
const passes = () =>
  [0, 1, 0].map((index, position) => ({
    job: { stage: "completed", passId: `pass-${position}` },
    sessionTarget: target(index),
    sourceKind: index === 0 ? "midi" : "warped-audio",
    nativeEpoch: position === 2 ? 2 : 1,
    producerIdentity: {
      producer: {
        producerId: `listener-${index}`,
        instanceId: `instance-${index}`,
      },
      connectionId: `connection-${index}`,
      binding: { trackId: `track-${index}` },
      registration: { version: 5, connectionEpoch: `epoch-${index}` },
    },
    evidence: {
      passId: `pass-${position}`,
      contextId: `context-${position}`,
      listenerId: `listener-${index}`,
      nativeEpoch: position === 2 ? 2 : 1,
      savedAndReopened: true,
      nativeCleanup: "confirmed-before-terminal-result",
      spectrumPhase: { synthetic: true },
      spectrumCleanup: { status: "completed" },
      spectrum: { status: "complete", expectedRecords: 1, records: [[1]] },
    },
  }));
const plan = () =>
  passes()
    .slice(0, 2)
    .map((pass) => ({
      sourceKind: pass.sourceKind,
      sessionTarget: pass.sessionTarget,
      producerIdentity: pass.producerIdentity,
    }));

it("admits only the fixed two-listener MIDI/audio/MIDI wire5 reviewed contract", async () => {
  const manifest = await load();
  expect(reviewNativeScenario(manifest)).toMatchObject({
    nativeVersion: 5,
    switchingSession: true,
    repeatedSession: true,
    sequence: [0, 1, 0],
    sourceSequence: ["midi", "warped-audio", "midi"],
    capture: { durationBeats: 1 },
  });
  for (const change of [
    { nativeVersion: 4 },
    { sequence: [0, 0, 0] },
    { sourceSequence: ["midi", "midi", "midi"] },
    { epochPolicy: "globally-increasing" },
    { maxToolCalls: 25 },
    { maxMutations: 4 },
    { timeoutMs: 270001 },
    { instancePolicy: "rebind-per-pass" },
    { betweenPasses: { ...manifest.betweenPasses, count: 3 } },
    {
      allowedActions: {
        ...manifest.allowedActions,
        ableton_listening: ["stop", "seek"],
      },
    },
  ])
    expect(() => reviewNativeScenario({ ...manifest, ...change })).toThrow(
      /Unreviewed/,
    );
  await expect(
    admitNativeScenarios({
      manifests: [manifest],
      skipInstall: true,
      computerUse: false,
      approveAll: false,
      inputV4: "wrong-version.json",
    }),
  ).rejects.toThrow("Explicit native-v5 fixture input required");
});

it("requires both tracks stopped/unqueued independently; transport stop/seek alone is insufficient", () => {
  expect(() =>
    verifySwitchingSessionReset(sources(true), target(0)),
  ).not.toThrow();
  expect(() =>
    verifySwitchingSessionReset(sources(), target(0), { stoppedZero: true }),
  ).not.toThrow();
  for (const mutate of [
    (s) => {
      s[0].after.targetPlaying = true;
      s[0].after.playingSlotIndex = 0;
    },
    (s) => {
      s[1].before.targetPlaying = true;
      s[1].before.playingSlotIndex = 0;
    },
    (s) => {
      s[1].after.targetTriggered = true;
    },
    (s) => {
      s[1].before.firedSlotIndex = 0;
    },
    (s) => {
      s[1].after.targetRecording = true;
    },
    (s) => {
      s[0].before.globalBeat = 1;
    },
    (s) => {
      s[1].after.transportPlaying = true;
    },
  ]) {
    const changed = sources();
    mutate(changed);
    expect(() =>
      verifySwitchingSessionReset(changed, target(0), { stoppedZero: true }),
    ).toThrow(/Switching baseline/);
  }
});

it("accepts native epochs 1,1,2 only with unique passes and stable per-producer binding/source", () => {
  expect(verifySwitchingNativeMetricPasses(passes(), plan()).epochPolicy).toBe(
    "increasing-per-producer",
  );
  for (const mutate of [
    (p) => {
      p[2].nativeEpoch = 1;
      p[2].evidence.nativeEpoch = 1;
    },
    (p) => {
      p[2].producerIdentity.producer.instanceId = "reloaded";
    },
    (p) => {
      p[2].producerIdentity.connectionId = "reconnected";
    },
    (p) => {
      p[2].producerIdentity.registration.connectionEpoch = "changed";
    },
    (p) => {
      p[1].sessionTarget = target(0);
    },
    (p) => {
      p[1].sourceKind = "midi";
    },
    (p) => {
      p[1].evidence.contextId = p[0].evidence.contextId;
    },
    (p) => {
      p[1].job.stage = "failed";
    },
    (p) => {
      p[1].evidence.spectrumCleanup.status = "failed";
    },
  ]) {
    const changed = globalThis.structuredClone(passes());
    mutate(changed);
    expect(() => verifySwitchingNativeMetricPasses(changed, plan())).toThrow(
      /Switching metric/,
    );
  }
});

it("stops only the previous exact owned track, unquantized, never unrelated tracks", () => {
  expect(switchingSessionStopParams(target(0), plan())).toEqual({
    action: "stop-clips",
    target: target(0).track,
    quantized: false,
  });
  expect(switchingSessionStopParams(target(1), plan()).target).toEqual(
    target(1).track,
  );
  expect(() =>
    switchingSessionStopParams(
      { ...target(0), track: { ...target(0).track, index: 1 } },
      plan(),
    ),
  ).toThrow(/exact previous owned/);
});

it.each([undefined, "stop-unapplied", "second-capture-failed"])(
  "attributes bounded reset/capture stages and never repairs or runs a third capture after %s",
  async (failure) => {
    const telemetry = [];
    const trace = {
      traceId: "switching-trace",
      correlationId: "reviewed-sequence",
      causationId: "owned-run",
    };
    const lifecycle = createNativeRunnerLifecycle({
      telemetry: {
        enqueue: (event) => {
          telemetry.push(event);
          return true;
        },
      },
      sanitize: (value) => value,
      trace,
    });
    const completed = [passes()[0]];
    let state = sources(true);
    const operations = [];
    const run = async () => {
      try {
        for (const index of nativeRepeatedSessionSteps(completed)) {
          const previous = target([0, 1, 0][index - 1]);
          const next = target([0, 1, 0][index]);
          const metadata = {
            beforeSubpass: index + 1,
            previousTarget: previous,
            nextTarget: next,
          };
          await lifecycle.stage(
            `switch-${index}-baseline`,
            async () => {
              verifySwitchingSessionReset(state, previous);
              const params = switchingSessionStopParams(previous, plan());
              operations.push(`stop-track-${params.target.index}`);
              if (failure !== "stop-unapplied")
                state = state.map((source) => ({
                  ...source,
                  before: {
                    ...source.before,
                    targetPlaying: false,
                    playingSlotIndex: -1,
                  },
                  after: {
                    ...source.after,
                    targetPlaying: false,
                    playingSlotIndex: -1,
                  },
                }));
              verifySwitchingSessionReset(state, previous, { inactive: true });
              operations.push("transport-stop", "seek-zero");
              state = sources();
              verifySwitchingSessionReset(state, previous, {
                stoppedZero: true,
              });
            },
            metadata,
          );
          await lifecycle.stage(
            `switch-${index}-capture`,
            async () => {
              operations.push(`capture-track-${next.track.index}`);
              if (failure === "second-capture-failed") throw new Error(failure);
              completed.push(passes()[index]);
              state = sources().map((source) => {
                const active = source.target.track.index === next.track.index;
                return {
                  ...source,
                  before: {
                    ...source.before,
                    transportPlaying: true,
                    globalBeat: 4,
                    targetPlaying: active,
                    playingSlotIndex: active ? 0 : -1,
                  },
                  after: {
                    ...source.after,
                    transportPlaying: true,
                    globalBeat: 4,
                    targetPlaying: active,
                    playingSlotIndex: active ? 0 : -1,
                  },
                };
              });
            },
            metadata,
          );
        }
      } finally {
        operations.push("cleanup-owned-services");
      }
    };
    if (failure) await expect(run()).rejects.toThrow();
    else {
      await run();
      expect(
        verifySwitchingNativeMetricPasses(completed, plan()).passes,
      ).toHaveLength(3);
      expect(operations).toEqual([
        "stop-track-0",
        "transport-stop",
        "seek-zero",
        "capture-track-2",
        "stop-track-2",
        "transport-stop",
        "seek-zero",
        "capture-track-0",
        "cleanup-owned-services",
      ]);
    }
    if (failure === "stop-unapplied")
      expect(operations).toEqual(["stop-track-0", "cleanup-owned-services"]);
    if (failure === "second-capture-failed")
      expect(operations).toEqual([
        "stop-track-0",
        "transport-stop",
        "seek-zero",
        "capture-track-2",
        "cleanup-owned-services",
      ]);
    expect(telemetry.length).toBeGreaterThan(0);
    for (const [index, event] of telemetry.entries()) {
      expect(event.attributes.beforeSubpass).toBeGreaterThanOrEqual(2);
      if (event.stage === "queued")
        expect(event.causationId).toBe(trace.causationId);
      else {
        expect(event.causationId).toBe(telemetry[index - 1].id);
        expect(event.durationMs).toBeGreaterThanOrEqual(
          telemetry[index - 1].durationMs,
        );
      }
    }
    expect(
      telemetry.every(
        (event) =>
          event.trace.traceId === trace.traceId &&
          event.correlationId === trace.correlationId &&
          event.durationMs >= 0,
      ),
    ).toBe(true);
    expect(
      telemetry.some((event) =>
        event.name.endsWith(failure ? ".failed" : ".completed"),
      ),
    ).toBe(true);
  },
);

it("freezes independent one-pass listener/source approvals without giving the actor reset authority", async () => {
  const manifest = await load();
  const approvals = createRepeatedSessionApprovals(
    manifest,
    createNativeScenarioApproval,
  );
  for (const [index, producer] of [0, 1, 0].entries()) {
    const binding = {
      listenerId: `listener-${producer}`,
      sessionTarget: target(producer),
    };
    approvals.begin(binding);
    expect(
      await approvals.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      }),
    ).toBe(true);
    expect(
      await approvals.request({
        toolName: "ableton_listening",
        risk: "reversible",
        arguments: {
          action: "play-session-and-listen",
          listenerIds: [binding.listenerId],
          target: binding.sessionTarget,
          durationBeats: 1,
          maximumDurationMs: 30000,
        },
      }),
    ).toBe(true);
    approvals.registerJob({
      stage: "completed",
      passId: `pass-${index}`,
      contextIds: [`context-${index}`],
    });
    expect(
      await approvals.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "get-pass", passId: `pass-${index}` },
      }),
    ).toBe(true);
  }
  expect(approvals.mutationCount).toBe(3);
  expect(
    await approvals.request({
      toolName: "ableton_listening",
      risk: "reversible",
      arguments: { action: "stop", target: target(1) },
    }),
  ).toBe(false);
});

it.each(["baseline-failed", "second-capture-failed", "prior-context-changed"])(
  "stops after %s with no third capture, later reset, or repair",
  async (message) => {
    const completed = [passes()[0]];
    const error = new Error(message);
    const cleanup = vi.fn();
    const baseline = vi.fn(async () => {
      if (message === "baseline-failed") throw error;
    });
    const capture = vi.fn(async () => {
      throw error;
    });
    const run = async () => {
      try {
        for (const index of nativeRepeatedSessionSteps(completed)) {
          await baseline(index);
          await capture(index);
        }
      } finally {
        cleanup();
      }
    };
    await expect(run()).rejects.toBe(error);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(
      message === "baseline-failed" ? 0 : 1,
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(completed).toHaveLength(1);
  },
);
