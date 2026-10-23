import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { tracksOperationResultSchema } from "@ableton-agent/protocol";
import {
  nativeSourceTransitions,
  nativeSourceOverrideRefusal,
  prepareNativeSourceTransition,
  verifyNativeSourceRefusal,
} from "./native-listening-runner-source.mjs";
import { reviewNativeScenario } from "./native-listening-runner.mjs";

const load = async (id) =>
  JSON.parse(await readFile(`integration/live-scenarios/${id}.json`, "utf8"));
const recording = {
  recordMode: false,
  sessionRecord: false,
  arrangementOverdub: false,
  sessionAutomationRecord: false,
};
const clone = (value) => globalThis.structuredClone(value);
const trackReference = "00000000-0000-4000-8000-000000000001";

function fixture({ transition = "baseline", broken, signal } = {}) {
  const binding = {
    track: {
      kind: "regular",
      index: 1,
      expectedReference: trackReference,
      expectedName: "Pinned fixture",
    },
    expectedDeviceReference: "listener",
  };
  const target = {
    binding,
    canonicalPath: "live_set tracks 1 devices 0",
    enabled: true,
    clipsTruncated: false,
    dependenciesTruncated: false,
  };
  let override = false;
  let playing = false;
  const labels = [];
  const sessionSource = {
    trackReference,
    trackIndex: 1,
    sceneIndex: 2,
    reference: "session-clip",
    length: 4,
  };
  const original = {
    trackReference,
    reference: "arrangement-original",
    startTime: 4,
    endTime: 12,
  };
  let clips = [original];
  const ableton = {
    inspectSession: vi.fn(async () => ({ clips: [sessionSource] })),
    inspectArrangement: vi.fn(async () => ({
      clips: clone(clips),
      total: clips.length,
    })),
    duplicateClipToArrangement: vi.fn(async () => {
      const clip = {
        trackReference,
        reference: "arrangement-new",
        startTime: 128,
        endTime: 132,
      };
      clips.push(clip);
      if (broken === "edit-override") override = true;
      return { verified: true, clip };
    }),
    deleteArrangementClip: vi.fn(async () => {
      if (broken !== "delete") clips = [original];
      return { verified: true };
    }),
    launchSessionClip: vi.fn(async () => {
      override = true;
      playing = true;
      return { verified: true };
    }),
    executeTracksOperation: vi.fn(async () => {
      const before = {
        kind: "regular",
        index: 1,
        reference: trackReference,
        name: "Pinned fixture",
        trackType: "midi",
        colorIndex: null,
        isGroup: false,
        isFolded: null,
        monitoringState: null,
        canBeArmed: true,
        isArmed: false,
        isMuted: false,
        isSoloed: false,
        backToArrangement: override,
      };
      if (broken !== "return") override = false;
      return tracksOperationResultSchema.parse({
        action: "back-to-arrangement",
        result: {
          before,
          after: { ...before, backToArrangement: override },
          verified: true,
        },
      });
    }),
    setPlaying: vi.fn(async () => {
      playing = false;
      return { verified: true };
    }),
  };
  const inspect = vi.fn(async (bindingQueryId) => ({
    bindingQueryId: broken === "stale-query" ? "stale" : bindingQueryId,
    transport: {
      playing,
      safeToStart: !playing,
      recording: {
        ...recording,
        ...(broken === "recording" ? { recordMode: null } : {}),
      },
    },
    listeners: [
      {
        ...target,
        ...(broken === "binding"
          ? { binding: { ...binding, expectedDeviceReference: "foreign" } }
          : {}),
        sessionOverride: broken === "unknown" ? null : override,
        sourceEvidence: {
          schemaVersion: 1,
          state: override ? "session-override" : "arrangement",
          reason: override ? "track-override" : "track-clear",
          trackBackToArranger: override,
          songBackToArranger: override,
          playingSlotIndex: override ? 2 : -1,
          firedSlotIndex: -1,
        },
      },
    ],
  }));
  const validateOwnership = vi.fn(async () => {
    signal?.throwIfAborted();
    if (broken === "owner") throw new Error("owner changed");
  });
  const evidence = { reads: [], mutations: [] };
  const run = () =>
    prepareNativeSourceTransition({
      transition,
      ableton,
      inspect,
      target,
      runId: "synthetic-only",
      validateOwnership,
      stage: async (name, operation) => {
        labels.push(name);
        return operation();
      },
      evidence,
    });
  return { run, ableton, inspect, evidence, labels, validateOwnership };
}

describe("reviewed independent source matrix", () => {
  it("registers four separate owned scenarios and keeps 4-12 startup unchanged", async () => {
    const suite = await load("suite");
    expect(
      suite.groups.find(
        ({ id }) => id === "native-listening-source-investigation",
      ).scenarios,
    ).toEqual(Object.keys(nativeSourceTransitions));
    for (const [id, transition] of Object.entries(nativeSourceTransitions)) {
      const manifest = await load(id);
      expect(reviewNativeScenario(manifest)).toMatchObject({
        nativeVersion: 2,
        capture: { startBeat: 4, endBeat: 12, maximumDurationMs: 8000 },
      });
      expect(manifest.sourceTransition).toBe(transition);
      expect(manifest.maxMutations).toBe(1);
      expect(manifest.allowedTools).toEqual([
        "ableton_listening",
        "ableton_context",
      ]);
      expect(manifest.setupContract.reviewStatus).toContain("11.3.42");
    }
    expect(
      reviewNativeScenario(await load("native-descriptive-startup-4-12"))
        .capture,
    ).toEqual({ startBeat: 4, endBeat: 12, maximumDurationMs: 8000 });
  });
  it.each([
    ["sourceTransition", "explicit-return"],
    ["maxMutations", 2],
    ["prompt", "repair and retry"],
    ["group", "native-listening-descriptive"],
    ["sourceSetupActions", ["session-launch", "global-return", "retry"]],
  ])("rejects a changed reviewed %s", async (key, value) => {
    const manifest = await load("native-source-session-override");
    manifest[key] = value;
    expect(() => reviewNativeScenario(manifest)).toThrow("Unreviewed");
  });
});

describe("source transitions use typed setup, never actor repair or receipts as proof", () => {
  it("independently reads a baseline and fresh pre-capture state without mutation", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.evidence.reads.map(({ label }) => label)).toEqual([
      "baseline",
      "before-explicit-pass",
    ]);
    expect(new Set(f.inspect.mock.calls.map(([id]) => id)).size).toBe(2);
    expect(f.ableton.launchSessionClip).not.toHaveBeenCalled();
    expect(f.ableton.setPlaying).not.toHaveBeenCalled();
  });
  it("refreshes source again at the actor request and rejects an intervening transport change", async () => {
    const f = fixture();
    const result = await f.run();
    await result.beforePass();
    expect(result.evidence.reads.at(-1).label).toBe(
      "immediately-before-actor-request",
    );
    f.inspect.mockImplementationOnce(async (bindingQueryId) => ({
      ...clone(result.inspected),
      bindingQueryId,
      transport: {
        ...clone(result.inspected.transport),
        playing: true,
        safeToStart: false,
      },
    }));
    await expect(result.beforePass()).rejects.toThrow("no retry");
    expect(f.ableton.setPlaying).not.toHaveBeenCalled();
  });
  it("separates exact Arrangement duplication/deletion from Session takeover", async () => {
    const f = fixture({ transition: "arrangement-duplicate-delete" });
    const result = await f.run();
    expect(result.evidence.reads.map(({ label }) => label)).toEqual([
      "baseline",
      "arrangement-duplicate",
      "arrangement-delete",
      "before-explicit-pass",
    ]);
    expect(f.ableton.duplicateClipToArrangement).toHaveBeenCalledWith({
      index: 1,
      expectedReference: trackReference,
      expectedName: "Pinned fixture",
      sceneIndex: 2,
      expectedClipReference: "session-clip",
      destinationTime: 128,
    });
    expect(f.ableton.deleteArrangementClip).toHaveBeenCalledWith({
      index: 1,
      expectedReference: trackReference,
      expectedName: "Pinned fixture",
      expectedClipReference: "arrangement-new",
      expectedStartTime: 128,
    });
    expect(f.ableton.launchSessionClip).not.toHaveBeenCalled();
    expect(f.ableton.executeTracksOperation).not.toHaveBeenCalled();
  });
  it("leaves intentional Session takeover unchanged for its one refusal request", async () => {
    const f = fixture({ transition: "session-override" });
    const result = await f.run();
    expect(result.inspected.listeners[0].sessionOverride).toBe(true);
    expect(result.evidence.reads.map(({ label }) => label)).toEqual([
      "baseline",
      "session-launch",
      "explicit-stop-before-new-pass",
      "before-explicit-pass",
    ]);
    expect(f.ableton.launchSessionClip).toHaveBeenCalledOnce();
    expect(f.ableton.executeTracksOperation).not.toHaveBeenCalled();
    expect(f.ableton.setPlaying).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("requires explicit exact-track return and stopped preparation before a new pass", async () => {
    const f = fixture({ transition: "explicit-return" });
    const result = await f.run();
    expect(
      result.evidence.reads.map(({ sessionOverride }) => sessionOverride),
    ).toEqual([false, true, false, false, false]);
    expect(f.ableton.executeTracksOperation).toHaveBeenCalledExactlyOnceWith({
      action: "back-to-arrangement",
      target: {
        kind: "regular",
        index: 1,
        expectedReference: trackReference,
        expectedName: "Pinned fixture",
      },
    });
    expect(f.ableton.setPlaying).toHaveBeenCalledExactlyOnceWith(false);
    expect(result.inspected.transport.playing).toBe(false);
  });
  it.each([
    null,
    { verified: true },
    { action: "back-to-arrangement" },
    { action: "back-to-arrangement", result: { verified: false } },
    { action: "stop-clips", result: { verified: true } },
  ])(
    "rejects an invalid explicit-return receipt %j before continuing",
    async (receipt) => {
      const f = fixture({ transition: "explicit-return" });
      f.ableton.executeTracksOperation.mockResolvedValue(receipt);
      await expect(f.run()).rejects.toThrow(
        "Unverified source explicit-track-return",
      );
      expect(f.evidence.mutations.at(-1)).toEqual({
        name: "explicit-track-return",
        receipt,
      });
      expect(f.evidence.reads.map(({ label }) => label)).toEqual([
        "baseline",
        "session-launch",
      ]);
      expect(f.ableton.setPlaying).not.toHaveBeenCalled();
    },
  );
  it.each(["stale-query", "owner", "unknown", "binding", "recording"])(
    "rejects %s before mutations or source attribution",
    async (broken) => {
      const f = fixture({ transition: "explicit-return", broken });
      await expect(f.run()).rejects.toThrow();
      expect(f.ableton.launchSessionClip).not.toHaveBeenCalled();
    },
  );
  it("retains partial mutation/source evidence and never repairs an unexpected edit override", async () => {
    const f = fixture({
      transition: "arrangement-duplicate-delete",
      broken: "edit-override",
    });
    await expect(f.run()).rejects.toThrow("no automatic repair");
    expect(f.evidence.mutations).toHaveLength(1);
    expect(f.evidence.reads.at(-1).sessionOverride).toBe(true);
    expect(f.ableton.deleteArrangementClip).not.toHaveBeenCalled();
    expect(f.ableton.executeTracksOperation).not.toHaveBeenCalled();
  });
  it.each([
    ["arrangement-duplicate-delete", "delete"],
    ["explicit-return", "return"],
  ])(
    "fails closed after unsuccessful %s/%s without retry",
    async (transition, broken) => {
      const f = fixture({ transition, broken });
      await expect(f.run()).rejects.toThrow();
      expect(f.ableton.setPlaying).not.toHaveBeenCalled();
    },
  );
  it("does not launch a source after cancellation", async () => {
    const controller = new globalThis.AbortController();
    controller.abort();
    const f = fixture({
      transition: "explicit-return",
      signal: controller.signal,
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.ableton.launchSessionClip).not.toHaveBeenCalled();
  });
  it("rejects ambiguous fixture Session sources instead of provisioning or choosing one", async () => {
    const f = fixture({ transition: "session-override" });
    f.ableton.inspectSession.mockResolvedValue({ clips: [] });
    await expect(f.run()).rejects.toThrow("exactly one");
    expect(f.ableton.launchSessionClip).not.toHaveBeenCalled();
  });
});

function refusal() {
  const listener = {
    phase: "idle",
    connectionId: "owned",
    registration: { connectionEpoch: "epoch" },
    binding: { trackId: "track", deviceId: "listener" },
  };
  const before = {
    listeners: [{ sessionOverride: true }],
    transport: { playing: true, recording },
  };
  return {
    job: {
      stage: "failed",
      error: nativeSourceOverrideRefusal,
      contextIds: [],
    },
    pass: undefined,
    entries: [],
    links: [],
    received: [],
    before: clone(before),
    after: clone(before),
    listener: clone(listener),
    finalListener: clone(listener),
    baselineSnapshot: { trackCount: 1, isPlaying: true },
    finalSnapshot: { trackCount: 1, isPlaying: true },
  };
}

describe("exact refusal no-publication/cleanup verifier", () => {
  it("accepts only the legitimate unchanged takeover refusal", () => {
    expect(verifyNativeSourceRefusal(refusal())).toMatchObject({
      noPublication: true,
      listenerReleased: true,
      unchangedSetAndSource: true,
    });
  });
  it.each([
    (f) => {
      f.job.error = "arrangement_source_unknown";
    },
    (f) => {
      f.job.error = "capture_failed: arrangement_session_override";
    },
    (f) => {
      f.job.error = "arrangement_session_override";
    },
    (f) => {
      f.job.error += "; Context quota release failed";
    },
    (f) => {
      f.job.stage = "cancelled";
    },
    (f) => {
      f.job.contextIds = ["foreign"];
    },
    (f) => {
      f.pass = { id: "persisted" };
    },
    (f) => {
      f.entries = [{}];
    },
    (f) => {
      f.links = [{}];
    },
    (f) => {
      f.received = [{}];
    },
    (f) => {
      f.finalListener.passId = "leaked";
    },
    (f) => {
      f.finalListener.jobId = "leaked";
    },
    (f) => {
      f.finalListener.phase = "armed";
    },
    (f) => {
      f.finalListener.registration.connectionEpoch = "stale";
    },
    (f) => {
      f.finalListener.binding.deviceId = "foreign";
    },
    (f) => {
      f.after.listeners[0].sessionOverride = false;
    },
    (f) => {
      f.after.transport.playing = false;
    },
    (f) => {
      f.after.transport.recording.recordMode = true;
    },
    (f) => {
      f.finalSnapshot.trackCount = 2;
    },
  ])("rejects mutated refusal evidence %#", (mutate) => {
    const f = refusal();
    mutate(f);
    expect(() => verifyNativeSourceRefusal(f)).toThrow();
  });
});
