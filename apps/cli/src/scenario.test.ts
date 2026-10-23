import { describe, expect, it, vi } from "vitest";

import type { HeadlessApplication } from "@ableton-agent/application";
import type { SessionSnapshot } from "@ableton-agent/protocol";
import type { AppEvent } from "@ableton-agent/shared";
import { telemetryEventEnvelopeSchema } from "@ableton-agent/observability";
import { resolveAbletonToolMetadata } from "@ableton-agent/tools";
import type { ToolApprovalRequest } from "@ableton-agent/tools";

import {
  createScenarioRunContext,
  captureTransportStopFailure,
  loadScenarioManifest,
  prepareTransportStopScenario,
  sanitizeTraceValue,
  scenarioManifestSchema,
  scenarioPrompt,
  scenarioStage,
  verifyScenario,
} from "./scenario.js";

function request(
  name: string,
  risk: ToolApprovalRequest["metadata"]["risk"],
  arguments_: Record<string, unknown>,
): ToolApprovalRequest {
  const metadata = resolveAbletonToolMetadata(name, arguments_);
  if (!metadata) {
    throw new Error(`Unknown tool metadata: ${name}`);
  }
  if (metadata.risk !== risk) {
    throw new Error(`Unexpected risk for ${name}`);
  }
  return {
    metadata,
    arguments: arguments_,
  };
}

describe("transport stop scenario", () => {
  const owner = { pid: 1234, runId: "11111111-1111-4111-8111-111111111111" };
  const stop = { action: "set-playing", isPlaying: false };
  function fixture() {
    const state = {
      isPlaying: false,
      currentSongTime: 0,
      tempo: 120,
      recording: false,
      totalCues: 0,
    };
    const calls: string[] = [];
    const application = {
      executeRecordingOperation: vi.fn(async () => {
        calls.push("recording");
        return {
          action: "inspect",
          state: {
            arrangementRecord: state.recording,
            sessionRecord: false,
            sessionAutomationRecord: false,
            overdub: false,
            punchIn: false,
            punchOut: false,
          },
        };
      }),
      executeTransportOperation: vi.fn(async () => {
        calls.push("transport");
        return {
          action: "get",
          transport: {
            currentSongTime: state.currentSongTime,
            isPlaying: state.isPlaying,
            tempo: state.tempo,
            timeSignature: { numerator: 4, denominator: 4 },
            metronome: false,
            launchQuantization: 4,
            recordQuantization: 0,
            linkEnabled: false,
            backToArrangement: false,
          },
          cuePoints: [],
          totalCuePoints: state.totalCues,
          offset: 0,
          limit: 32,
        };
      }),
      inspectSession: vi.fn(async (): Promise<SessionSnapshot> => {
        calls.push("session");
        return {
          tempo: state.tempo,
          isPlaying: state.isPlaying,
          timeSignature: { numerator: 4, denominator: 4 },
          trackCount: 0,
          tracks: [],
          clips: [],
        };
      }),
      inspectArrangementTransport: vi.fn(async () => {
        calls.push("loop-cues");
        return {
          loop: { enabled: false, start: 0, length: 4 },
          cuePoints: [],
          totalCuePoints: 0,
          offset: 0,
          limit: 32,
        };
      }),
      inspectArrangement: vi.fn(async () => {
        calls.push("arrangement");
        return { clips: [], total: 0, offset: 0, limit: 256 };
      }),
      setPlaying: vi.fn(async (isPlaying: boolean) => {
        calls.push("setup-play");
        const beforeIsPlaying = state.isPlaying;
        state.isPlaying = isPlaying;
        return { beforeIsPlaying, afterIsPlaying: isPlaying, verified: true };
      }),
    };
    return {
      state,
      calls,
      application: application as unknown as HeadlessApplication,
      mocks: application,
    };
  }
  function operations(
    result: unknown = {
      beforeIsPlaying: true,
      afterIsPlaying: false,
      verified: true,
    },
  ): AppEvent[] {
    return [
      {
        type: "operation.started",
        operationId: "actor-stop",
        label: "Stop",
        toolName: "ableton_transport",
        arguments: stop,
      },
      {
        type: "operation.completed",
        operationId: "actor-stop",
        summary: "Stopped",
        toolName: "ableton_transport",
        arguments: stop,
        result,
      },
    ];
  }

  it("admits only the reviewed natural-language policy with no action hint", async () => {
    const manifest = await loadScenarioManifest("transport-stop");
    const context = createScenarioRunContext(manifest);
    expect(scenarioPrompt("untrusted alternative action hint", context)).toBe(
      "Stop playback. Do not change anything else.",
    );
    expect(manifest.maxMutations).toBe(1);
    expect(manifest.allowedTools).toEqual(["ableton_transport"]);
  });

  it.each([
    { maxMutations: 2 },
    { maxToolCalls: 5 },
    { allowedTools: ["ableton_transport", "ableton_tracks"] },
    { prompt: "Use set-playing to stop." },
    { assertions: [{ type: "session-unchanged" as const }] },
    { allowedRisks: ["read" as const, "destructive" as const] },
    { allowedActions: { ableton_transport: ["set-playing", "set-tempo"] } },
  ])(
    "rejects broadened or misleading manifest admission %j",
    async (override) => {
      const manifest = await loadScenarioManifest("transport-stop");
      expect(() =>
        createScenarioRunContext({ ...manifest, ...override }),
      ).toThrow("exact reviewed scenario policy");
    },
  );

  it.each([
    { action: "set-playing", isPlaying: true },
    { action: "set-playing", isPlaying: false, unexpected: true },
    { action: "set-playing" },
    { action: "set-tempo", tempo: 100 },
    { action: "get", limit: 33 },
    { action: "get", offset: 1 },
    { action: "inspect-arrangement", limit: 0 },
    { action: "get", unexpected: true },
  ])("denies unsafe or unexpected actor arguments %j", async (args) => {
    const context = createScenarioRunContext(
      await loadScenarioManifest("transport-stop"),
    );
    const approval = request(
      "ableton_transport",
      args.action === "get" || args.action === "inspect-arrangement"
        ? "read"
        : "reversible",
      args,
    );
    expect(await context.approvals.request(approval)).toBe(false);
  });

  it("allows bounded inspection and only one exact stop", async () => {
    const context = createScenarioRunContext(
      await loadScenarioManifest("transport-stop"),
    );
    expect(
      await context.approvals.request(
        request("ableton_transport", "read", { action: "get", limit: 32 }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_transport", "reversible", stop),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_transport", "reversible", stop),
      ),
    ).toBe(false);
    expect(context.approvals.decisions.at(-1)?.reason).toBe(
      "mutation_budget_exhausted",
    );
  });

  it("guards recording, starts through the service, then independently confirms playing before actor verification", async () => {
    const { application, state, calls } = fixture();
    const context = createScenarioRunContext(
      await loadScenarioManifest("transport-stop"),
    );
    await prepareTransportStopScenario(application, context, owner);
    expect(calls).toEqual([
      "recording",
      "transport",
      "session",
      "loop-cues",
      "arrangement",
      "recording",
      "setup-play",
      "recording",
      "transport",
      "session",
      "loop-cues",
      "arrangement",
    ]);
    expect(context.approvals.decisions).toEqual([]);
    expect(context.transportStop?.playing?.session.isPlaying).toBe(true);
    await context.approvals.request(
      request("ableton_transport", "reversible", stop),
    );
    state.isPlaying = false;
    state.currentSongTime = 100;
    const results = await verifyScenario(
      application,
      context,
      context.transportStop!.initial!.session,
      operations(
        JSON.stringify({
          beforeIsPlaying: true,
          afterIsPlaying: false,
          verified: true,
        }),
      ),
    );
    expect(results).toEqual([expect.objectContaining({ passed: true })]);
    expect(context.transportStop?.final?.session.isPlaying).toBe(false);
  });

  it.each([
    {
      label: "recorded SDK post-tool guidance",
      result:
        '{"beforeIsPlaying":true,"afterIsPlaying":false,"verified":true}\n\nTool "ableton_transport" succeeded. Additional guidance from postToolUse hooks:\nUse the verified tool result as observed state. Re-inspect before any dependent mutation when the project may have changed.',
      passed: true,
    },
    {
      label: "unknown trailing prose",
      result:
        '{"beforeIsPlaying":true,"afterIsPlaying":false,"verified":true}\n\nPlayback stopped.',
      passed: false,
    },
    {
      label: "different tool guidance",
      result:
        '{"beforeIsPlaying":true,"afterIsPlaying":false,"verified":true}\n\nTool "ableton_tracks" succeeded. Additional guidance from postToolUse hooks:\nUse the verified result.',
      passed: false,
    },
    {
      label: "unverified payload with SDK guidance",
      result:
        '{"beforeIsPlaying":true,"afterIsPlaying":false,"verified":false}\n\nTool "ableton_transport" succeeded. Additional guidance from postToolUse hooks:\nUse the verified result.',
      passed: false,
    },
    {
      label: "guidance without a valid result",
      result:
        'Playback stopped.\n\nTool "ableton_transport" succeeded. Additional guidance from postToolUse hooks:\nUse the verified result.',
      passed: false,
    },
  ])("validates stop result framing: $label", async ({ result, passed }) => {
    const { application, state } = fixture();
    const context = createScenarioRunContext(
      await loadScenarioManifest("transport-stop"),
    );
    await prepareTransportStopScenario(application, context, owner);
    await context.approvals.request(
      request("ableton_transport", "reversible", stop),
    );
    state.isPlaying = false;
    const assertions = await verifyScenario(
      application,
      context,
      context.transportStop!.initial!.session,
      operations(result),
    );
    expect(assertions[0]?.passed).toBe(passed);
  });

  it.each([
    "no-owner",
    "recording",
    "unknown-recording",
    "read-failure",
    "partial-cues",
    "not-playing",
    "setup-failure",
  ] as const)(
    "refuses setup without safe independent evidence: %s",
    async (failure) => {
      const { application, state, mocks } = fixture();
      const context = createScenarioRunContext(
        await loadScenarioManifest("transport-stop"),
      );
      if (failure === "recording") state.recording = true;
      if (failure === "unknown-recording")
        mocks.executeRecordingOperation.mockResolvedValue({
          action: "inspect",
          state: {},
        } as never);
      if (failure === "read-failure")
        mocks.executeTransportOperation.mockRejectedValue(
          new Error("bridge failed"),
        );
      if (failure === "partial-cues") state.totalCues = 33;
      if (failure === "not-playing")
        mocks.setPlaying.mockResolvedValue({
          beforeIsPlaying: false,
          afterIsPlaying: true,
          verified: true,
        });
      if (failure === "setup-failure")
        mocks.setPlaying.mockRejectedValue(new Error("setup failed"));
      await expect(
        prepareTransportStopScenario(
          application,
          context,
          failure === "no-owner" ? undefined : owner,
        ),
      ).rejects.toThrow();
      if (!["not-playing", "setup-failure"].includes(failure))
        expect(mocks.setPlaying).not.toHaveBeenCalled();
    },
  );

  it.each([
    "still-playing",
    "no-call",
    "denied",
    "incomplete",
    "unverified",
    "changed-settings",
    "changed-loop",
    "changed-content",
    "reversed-trace",
    "unexpected-mutation",
    "recording",
  ] as const)(
    "cannot pass from prose or invalid final evidence: %s",
    async (failure) => {
      const { application, state, mocks } = fixture();
      const context = createScenarioRunContext(
        await loadScenarioManifest("transport-stop"),
      );
      await prepareTransportStopScenario(application, context, owner);
      await context.approvals.request(
        request(
          "ableton_transport",
          "reversible",
          failure === "denied" ? { ...stop, isPlaying: true } : stop,
        ),
      );
      state.isPlaying = failure === "still-playing";
      if (failure === "changed-settings") state.tempo = 121;
      if (failure === "changed-loop")
        mocks.inspectArrangementTransport.mockResolvedValue({
          loop: { enabled: true, start: 0, length: 4 },
          cuePoints: [],
          totalCuePoints: 0,
          offset: 0,
          limit: 32,
        });
      if (failure === "changed-content")
        mocks.inspectSession.mockResolvedValue({
          ...context.transportStop!.playing!.session,
          isPlaying: false,
          clips: [
            {
              reference: owner.runId,
              trackReference: owner.runId,
              trackIndex: 0,
              sceneIndex: 0,
              name: "Unexpected clip",
              kind: "midi",
              length: 4,
              noteCount: 0,
            },
          ],
        });
      if (failure === "recording") state.recording = true;
      const trace =
        failure === "no-call"
          ? []
          : failure === "incomplete"
            ? operations().slice(0, 1)
            : operations(
                failure === "unverified" ? { verified: false } : undefined,
              );
      if (failure === "reversed-trace") trace.reverse();
      if (failure === "unexpected-mutation")
        trace.push(
          {
            type: "operation.started",
            operationId: "unexpected",
            label: "Start",
            toolName: "ableton_transport",
            arguments: { action: "set-playing", isPlaying: true },
          },
          {
            type: "operation.completed",
            operationId: "unexpected",
            summary: "Started",
          },
        );
      const results = await verifyScenario(
        application,
        context,
        context.transportStop!.initial!.session,
        trace,
      );
      expect(results[0]?.passed).toBe(false);
    },
  );

  it("retains failure state without cleanup mutations", async () => {
    const { application, mocks } = fixture();
    const context = createScenarioRunContext(
      await loadScenarioManifest("transport-stop"),
    );
    await prepareTransportStopScenario(application, context, owner);
    await captureTransportStopFailure(application, context);
    expect(context.transportStop?.final?.session.isPlaying).toBe(true);
    expect(mocks.setPlaying).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "records ordered attributed bounded redacted %s lifecycle timing",
    async (outcome) => {
      const context = createScenarioRunContext(
        await loadScenarioManifest("transport-stop"),
      );
      context.transportStop = { owner };
      const checkpoint = vi.fn();
      const action = scenarioStage(
        context,
        "setup",
        async () => {
          if (outcome !== "completed") {
            const error = new Error("token=private-secret");
            if (outcome === "cancelled") error.name = "AbortError";
            throw error;
          }
        },
        checkpoint,
      );
      if (outcome === "completed") await action;
      else await expect(action).rejects.toThrow();
      expect(checkpoint).toHaveBeenCalledTimes(2);
      expect(context.lifecycle.map((event) => event.name)).toEqual([
        "scenario.setup.started",
        `scenario.setup.${outcome}`,
      ]);
      for (const event of context.lifecycle) {
        expect(() => telemetryEventEnvelopeSchema.parse(event)).not.toThrow();
        expect(event.trace?.traceId).toBe(context.traceId);
        expect(event.causationId).toBe(owner.runId);
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
        expect(sanitizeTraceValue(event)).toMatchObject({
          name: event.name,
          attributes: { operationStage: "setup" },
        });
      }
      expect(context.lifecycle[0]?.trace?.spanId).toBe(
        context.lifecycle[1]?.trace?.spanId,
      );
      expect(JSON.stringify(context.lifecycle)).not.toContain("private-secret");
    },
  );
});

describe("integration scenarios", () => {
  it("loads reviewed manifests and injects unique artifact names", async () => {
    const manifest = await loadScenarioManifest("808-track");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(context.trackNames).toHaveLength(1);
    expect(context.trackNames[0]).toMatch(/^AA_SMOKE_808_/);
    expect(prompt).toContain(context.trackNames[0]);
  });

  it("loads every read-only inspection manifest", async () => {
    for (const id of [
      "connection-and-session",
      "transport-inspection",
      "browser-bounds",
    ]) {
      const manifest = await loadScenarioManifest(id);
      expect(manifest.group).toBe("inspection");
      expect(manifest.maxMutations).toBe(0);
    }
  });

  it("loads every agent scenario manifest with grouped action constraints", async () => {
    for (const id of [
      "connection-and-session",
      "transport-inspection",
      "browser-bounds",
      "workflow-state-inspection",
      "track-lifecycle",
      "808-track",
      "four-on-floor",
      "session-clip-lifecycle",
      "arrangement-clip-lifecycle",
      "arrangement-region-fill-lifecycle",
      "piano-and-string-bass",
      "auto-filter-audio",
      "echo-parameter-inspection",
      "tracks-core-inspection",
      "scenes-core-inspection",
      "transport-core-inspection",
      "operator-quarter-note-fixture",
    ]) {
      await expect(loadScenarioManifest(id)).resolves.toMatchObject({ id });
    }
  });

  it("states the exact reviewed MIDI pattern and identity fields", async () => {
    const manifest = await loadScenarioManifest("four-on-floor");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(prompt).toContain("exactly 4 notes and no others");
    expect(prompt).toContain("pitch 36, starts 0, 1, 2, 3");
    expect(prompt).toContain(
      `expectedName is the track name "${context.trackNames[0]}"`,
    );
  });

  it("requires an explicit region-fill inspection before identity-bound cleanup without widening approval", async () => {
    const manifest = await loadScenarioManifest(
      "arrangement-region-fill-lifecycle",
    );
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);
    const trackName = context.trackNames[0]!;
    const clipName = context.clipNames[0]!;
    expect(prompt).toContain(
      'Call ableton_arrangement action "inspect" before any deletion',
    );
    expect(prompt).toContain(
      "The fill-region result does not replace this inspection",
    );
    expect(prompt).toContain(`expectedName is the track name "${trackName}"`);
    expect(manifest.maxToolCalls).toBe(14);
    expect(manifest.maxMutations).toBe(8);

    for (const approval of [
      request("ableton_tracks", "reversible", {
        action: "create",
        kind: "midi",
        name: trackName,
      }),
      request("ableton_session_clips", "reversible", {
        action: "create-midi",
        expectedName: trackName,
        name: clipName,
        sceneIndex: 5,
        length: 4,
      }),
      request("ableton_arrangement", "reversible", {
        action: "fill-region",
        expectedName: trackName,
        sceneIndex: 5,
        regionStart: 32,
        regionEnd: 42,
      }),
    ]) {
      expect(await context.approvals.request(approval)).toBe(true);
    }
    const deletion = request("ableton_arrangement", "destructive", {
      action: "delete-clip",
      expectedName: trackName,
      expectedClipReference: "generated-tile",
      expectedStartTime: 32,
    });
    expect(await context.approvals.request(deletion)).toBe(false);
    expect(context.approvals.decisions.at(-1)?.reason).toBe(
      "ordering_requires_ableton_arrangement_inspect",
    );
    expect(
      await context.approvals.request(
        request("ableton_arrangement", "read", {
          action: "inspect",
          expectedName: trackName,
        }),
      ),
    ).toBe(true);
    expect(await context.approvals.request(deletion)).toBe(true);
  });

  it("bounds the Operator source fixture without claiming measured listening", async () => {
    const manifest = await loadScenarioManifest(
      "operator-quarter-note-fixture",
    );
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);
    expect(manifest.group).toBe("listening-fixtures");
    expect(manifest.maxMutations).toBe(5);
    expect(prompt).toContain("pitch 69, starts 0, 1, 2, 3");
    expect(prompt).toContain("duration 0.5, velocity 100");
    expect(prompt).toContain("Do not start playback");
    expect(prompt).toContain("not a verified sine waveform");
    expect(prompt).toContain('Use ableton_arrangement action "duplicate-clip"');
    expect(prompt).toContain('NOT ableton_session_clips action "duplicate"');
    expect(prompt).toContain("allowPerNoteExpressionLoss false");
    expect(prompt).toContain("destinationTime 0");
    expect(prompt).toContain("do not call ask_user");
    expect(prompt).toContain("Use only this reviewed tool/action surface:");
    expect(prompt).toContain("do not substitute an unlisted MIDI query tool");
    expect(manifest.allowedTools).not.toContain("ableton_transport");
    expect(manifest.allowedTools).not.toContain("ableton_listening");
    expect(manifest.allowedActions.ableton_arrangement).toEqual([
      "duplicate-clip",
      "inspect",
    ]);
    expect(prompt).not.toContain(
      'For ableton_arrangement with action "replace-notes"',
    );
    expect(manifest.browserLoadTargets).toEqual([
      { trackNameSuffix: "Operator Quarter Notes", itemName: "Operator" },
    ]);
    expect(
      await context.approvals.request(
        request("ableton_arrangement", "reversible", {
          action: "create-midi-clip",
          expectedName: context.trackNames[0],
          name: context.clipNames[0],
          startTime: 0,
          length: 4,
        }),
      ),
    ).toBe(false);
    expect(
      await context.approvals.request(
        request("ableton_browser", "read", {
          action: "search",
          query: "Operator",
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_tracks", "reversible", {
          action: "create",
          kind: "midi",
          name: context.trackNames[0],
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_browser", "reversible", {
          action: "load-item",
          expectedName: context.trackNames[0],
          expectedItemName: "Operator",
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_transport", "reversible", {
          action: "set-playing",
          isPlaying: true,
        }),
      ),
    ).toBe(false);
  });

  it.each(["valid", "wrong-device", "wrong-notes"] as const)(
    "verifies the Operator source from independent bridge reads: %s",
    async (result) => {
      const manifest = await loadScenarioManifest(
        "operator-quarter-note-fixture",
      );
      const context = createScenarioRunContext(manifest);
      const trackName = context.trackNames[0]!;
      const clipName = context.clipNames[0]!;
      const trackReference = "00000000-0000-4000-8000-000000000011";
      const clipReference = "00000000-0000-4000-8000-000000000012";
      const baseline: SessionSnapshot = {
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
        isPlaying: false,
        trackCount: 0,
        tracks: [],
        clips: [],
      };
      const snapshot: SessionSnapshot = {
        ...baseline,
        trackCount: 1,
        clips: [
          {
            reference: clipReference,
            trackReference,
            trackIndex: 0,
            sceneIndex: 0,
            name: clipName,
            kind: "midi",
            length: 4,
            noteCount: 4,
            isPlaying: false,
            isTriggered: false,
          },
        ],
        tracks: [
          {
            index: 0,
            reference: trackReference,
            name: trackName,
            kind: "midi",
            color: null,
            isMuted: false,
            isSoloed: false,
            isArmed: false,
            volume: 0.85,
            pan: 0,
          },
        ],
      };
      const clip = {
        reference: clipReference,
        trackReference,
        trackIndex: 0,
        name: clipName,
        kind: "midi" as const,
        startTime: 0,
        endTime: 4,
        length: 4,
        noteCount: 4,
      };
      const notes = [0, 1, 2, 3].map((startTime) => ({
        pitch: result === "wrong-notes" ? 68 : 69,
        startTime,
        duration: 0.5,
        velocity: 100,
        mute: false,
      }));
      const unexpected = vi.fn(async () => {
        throw new Error("Unexpected source-fixture inspection");
      });
      const inspectNotes = vi.fn(async () => ({
        clip,
        notes,
        totalNotes: 4,
        offset: 0,
        limit: 2048,
        truncated: false,
      }));
      const application: Parameters<typeof verifyScenario>[0] = {
        executeTransportOperation: unexpected,
        executeRecordingOperation: unexpected,
        inspectSession: async () => snapshot,
        inspectDevices: async () => ({
          devices: [
            {
              reference: "00000000-0000-4000-8000-000000000013",
              trackReference,
              trackIndex: 0,
              index: 0,
              name: result === "wrong-device" ? "Analog" : "Operator",
              className: "Operator",
              classDisplayName: "Operator",
              enabled: true,
              parameterCount: 0,
              canHaveChains: false,
              canHaveDrumPads: false,
            },
          ],
          total: 1,
          offset: 0,
          limit: 32,
        }),
        inspectArrangement: async () => ({
          clips: [clip],
          total: 1,
          offset: 0,
          limit: 512,
        }),
        inspectArrangementMidiNotes: inspectNotes,
        inspectMidiNotes: async () => ({
          clip: {
            reference: clipReference,
            trackReference,
            trackIndex: 0,
            sceneIndex: 0,
            name: clipName,
            length: 4,
            noteCount: 4,
          },
          notes,
          totalNotes: 4,
          offset: 0,
          limit: 128,
          truncated: false,
        }),
        inspectArrangementTransport: unexpected,
        getStatus: unexpected,
        getCapabilities: unexpected,
      };
      const verified = await verifyScenario(application, context, baseline);
      expect(
        verified.map(({ assertion, passed }) => ({ assertion, passed })),
      ).toEqual([
        { assertion: "track-device", passed: result !== "wrong-device" },
        { assertion: "session-midi-pattern", passed: result !== "wrong-notes" },
        {
          assertion: "arrangement-midi-pattern",
          passed: result !== "wrong-notes",
        },
      ]);
      expect(inspectNotes).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedReference: trackReference,
          expectedClipReference: clipReference,
          expectedName: trackName,
          expectedStartTime: 0,
        }),
      );
      expect(unexpected).not.toHaveBeenCalled();
    },
  );

  it("states zero-based Session indices and track identity fields", async () => {
    const manifest = await loadScenarioManifest("session-clip-lifecycle");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(prompt).toContain("zero-based sceneIndex 4 (Session scene 5)");
    expect(prompt).toContain(
      "zero-based destinationSceneIndex 5 (Session scene 6)",
    );
    expect(prompt).toContain(
      `expectedName remains the track name "${context.trackNames[0]}"`,
    );
    expect(prompt).toContain(
      "expectedClipReference identifies the source or destination clip",
    );
  });

  it("states the enforced Session lifecycle order in its reviewed opening request", async () => {
    const manifest = await loadScenarioManifest("session-clip-lifecycle");
    expect(manifest.prompt).toBe(
      "Create a temporary Session MIDI clip, launch it, stop playback, update its properties, duplicate it, then delete the generated clips and track so the Set returns to its original state.",
    );
  });

  it("rejects a clip name in the launch track guard without consuming the stop step", async () => {
    const context = createScenarioRunContext(
      await loadScenarioManifest("session-clip-lifecycle"),
    );
    const trackName = context.trackNames[0]!;
    const clipName = context.clipNames[0]!;
    expect(
      await context.approvals.request(
        request("ableton_tracks", "reversible", {
          action: "create",
          kind: "midi",
          name: trackName,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_session_clips", "reversible", {
          action: "create-midi",
          expectedName: trackName,
          name: clipName,
          sceneIndex: 4,
          length: 4,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_session_clips", "reversible", {
          action: "launch",
          expectedName: clipName,
          sceneIndex: 4,
        }),
      ),
    ).toBe(false);
    expect(context.approvals.decisions.at(-1)?.reason).toBe(
      "argument_guard_rejected",
    );
    expect(
      await context.approvals.request(
        request("ableton_transport", "reversible", {
          action: "set-playing",
          isPlaying: false,
        }),
      ),
    ).toBe(false);
  });

  it("loads Arrangement lifecycle manifests with exact prompts", async () => {
    const arrangement = await loadScenarioManifest(
      "arrangement-clip-lifecycle",
    );
    const arrangementContext = createScenarioRunContext(arrangement);
    const arrangementPrompt = scenarioPrompt(
      arrangement.prompt,
      arrangementContext,
    );
    expect(arrangement.group).toBe("arrangement-and-cues");
    expect(arrangementPrompt).toContain("Arrangement at beat 32");
    expect(arrangementPrompt).toContain(
      `clip "${arrangementContext.clipNames[0]}"`,
    );
  });

  it("enforces ordering, names, item identity, and budgets", async () => {
    const manifest = await loadScenarioManifest("808-track");
    const context = createScenarioRunContext(manifest);
    const trackName = context.trackNames[0]!;

    expect(
      await context.approvals.request(
        request("ableton_tracks", "reversible", {
          action: "create",
          kind: "midi",
          name: trackName,
        }),
      ),
    ).toBe(false);
    expect(
      await context.approvals.request(
        request("ableton_browser", "read", {
          action: "search",
          query: "808",
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_tracks", "reversible", {
          action: "create",
          kind: "midi",
          name: trackName,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_browser", "reversible", {
          action: "load-item",
          index: 0,
          expectedName: trackName,
          expectedItemName: "Not the reviewed preset.adg",
        }),
      ),
    ).toBe(false);
  });

  it("enforces exact actions in grouped-tool ordering and allowlists", async () => {
    const manifest = await loadScenarioManifest("session-clip-lifecycle");
    const context = createScenarioRunContext(manifest);
    const trackName = context.trackNames[0]!;
    const clipName = context.clipNames[0]!;

    expect(
      await context.approvals.request(
        request("ableton_tracks", "reversible", {
          action: "create",
          kind: "midi",
          name: trackName,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_session_clips", "reversible", {
          action: "launch",
          expectedName: trackName,
          sceneIndex: 4,
        }),
      ),
    ).toBe(false);
    expect(
      await context.approvals.request(
        request("ableton_session_clips", "destructive", {
          action: "replace-notes",
          expectedName: trackName,
          sceneIndex: 4,
          notes: [],
        }),
      ),
    ).toBe(false);
    expect(
      await context.approvals.request(
        request("ableton_session_clips", "reversible", {
          action: "create-midi",
          expectedName: trackName,
          name: clipName,
          sceneIndex: 4,
          length: 4,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_session_clips", "reversible", {
          action: "launch",
          expectedName: trackName,
          sceneIndex: 4,
        }),
      ),
    ).toBe(true);
  });

  it("binds reviewed Browser fixtures to their intended tracks", async () => {
    const manifest = await loadScenarioManifest("piano-and-string-bass");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(prompt).toContain('Browser item "Childhood Home Piano.adg"');
    expect(prompt).toContain('Browser item "Upright Bass.adv"');
    expect(
      await context.approvals.request(
        request("ableton_browser", "read", {
          action: "search",
          query: "piano",
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_tracks", "reversible", {
          action: "create",
          kind: "midi",
          name: context.trackNames[0],
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_browser", "reversible", {
          action: "load-item",
          expectedName: context.trackNames[1],
          expectedItemName: "Childhood Home Piano.adg",
        }),
      ),
    ).toBe(false);
    expect(
      await context.approvals.request(
        request("ableton_browser", "reversible", {
          action: "load-item",
          expectedName: context.trackNames[0],
          expectedItemName: "Childhood Home Piano.adg",
        }),
      ),
    ).toBe(true);
  });

  it("binds the Auto Filter fixture to the generated audio track", async () => {
    const manifest = await loadScenarioManifest("auto-filter-audio");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(prompt).toContain('Browser item "Auto Filter"');
    expect(
      await context.approvals.request(
        request("ableton_browser", "read", {
          action: "search",
          query: "Auto Filter",
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_tracks", "reversible", {
          action: "create",
          kind: "audio",
          name: context.trackNames[0],
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_browser", "reversible", {
          action: "load-item",
          expectedName: context.trackNames[0],
          expectedItemName: "Auto Filter",
        }),
      ),
    ).toBe(true);
  });

  it("guards and verifies exact Arrangement MIDI patterns", async () => {
    const manifest = scenarioManifestSchema.parse({
      formatVersion: 1,
      id: "arrangement-pattern",
      group: "arrangement",
      prompt: "Create an Arrangement pattern",
      artifactPrefix: "AA_SMOKE_ARR_",
      allowedTools: ["ableton_arrangement"],
      allowedActions: {
        ableton_arrangement: ["create-midi-clip", "replace-notes"],
      },
      allowedRisks: ["reversible", "destructive"],
      maxToolCalls: 4,
      maxMutations: 2,
      timeoutMs: 60_000,
      trackNameSuffixes: ["Drums"],
      clipNameSuffixes: ["Beat"],
      assertions: [
        {
          type: "arrangement-midi-pattern",
          trackNameSuffix: "Drums",
          clipNameSuffix: "Beat",
          startTime: 8,
          length: 4,
          pitch: 36,
          starts: [0, 1, 2, 3],
          duration: 0.25,
          velocity: 110,
        },
      ],
    });
    const context = createScenarioRunContext(manifest);
    const trackName = context.trackNames[0]!;
    const clipName = context.clipNames[0]!;
    const notes = [0, 1, 2, 3].map((startTime) => ({
      pitch: 36,
      startTime,
      duration: 0.25,
      velocity: 110,
      mute: false,
    }));

    expect(
      await context.approvals.request(
        request("ableton_arrangement", "destructive", {
          action: "replace-notes",
          expectedName: trackName,
          notes,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_arrangement", "destructive", {
          action: "replace-notes",
          expectedName: trackName,
          notes: [...notes, { ...notes[0]!, startTime: 3.5 }],
        }),
      ),
    ).toBe(false);

    const trackReference = "00000000-0000-4000-8000-000000000001";
    const clipReference = "00000000-0000-4000-8000-000000000002";
    const baseline: SessionSnapshot = {
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 0,
      tracks: [],
      clips: [],
    };
    const snapshot: SessionSnapshot = {
      ...baseline,
      trackCount: 1,
      tracks: [
        {
          index: 0,
          reference: trackReference,
          name: trackName,
          kind: "midi",
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.85,
          pan: 0,
        },
      ],
    };
    const application = {
      inspectSession: async () => snapshot,
      inspectArrangement: async () => ({
        clips: [
          {
            reference: clipReference,
            trackReference,
            trackIndex: 0,
            name: clipName,
            kind: "midi" as const,
            startTime: 8,
            endTime: 12,
            length: 4,
            noteCount: 4,
          },
        ],
        total: 1,
        offset: 0,
        limit: 512,
      }),
      inspectArrangementMidiNotes: async () => ({
        clip: {
          reference: clipReference,
          trackReference,
          trackIndex: 0,
          name: clipName,
          kind: "midi" as const,
          startTime: 8,
          endTime: 12,
          length: 4,
          noteCount: 4,
        },
        notes,
        totalNotes: 4,
        offset: 0,
        limit: 2048,
        truncated: false,
      }),
    } as unknown as HeadlessApplication;

    await expect(
      verifyScenario(application, context, baseline),
    ).resolves.toEqual([
      expect.objectContaining({
        assertion: "arrangement-midi-pattern",
        passed: true,
      }),
    ]);
  });

  it("verifies grouped track lifecycle calls by exact action", async () => {
    const manifest = await loadScenarioManifest("track-lifecycle");
    const context = createScenarioRunContext(manifest);
    const initialName = context.trackNames[0]!;
    const finalName = context.trackNames[1]!;
    const target = {
      kind: "regular",
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: finalName,
    };

    await context.approvals.request(
      request("ableton_tracks", "reversible", {
        action: "create",
        kind: "midi",
        name: initialName,
      }),
    );
    await context.approvals.request(
      request("ableton_tracks", "reversible", {
        action: "rename",
        index: 0,
        expectedReference: target.expectedReference,
        expectedName: initialName,
        name: finalName,
      }),
    );
    await context.approvals.request(
      request("ableton_mixer_routing", "reversible", {
        action: "set-track-mixer",
        index: 0,
        expectedReference: target.expectedReference,
        expectedName: finalName,
        isMuted: true,
        isSoloed: true,
        isArmed: true,
        volume: 0.42,
        pan: -0.25,
      }),
    );
    await context.approvals.request(
      request("ableton_tracks", "destructive", {
        action: "delete",
        target,
      }),
    );

    const baseline: SessionSnapshot = {
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 0,
      tracks: [],
      clips: [],
    };
    const application = {
      inspectSession: async () => structuredClone(baseline),
    } as unknown as HeadlessApplication;

    await expect(
      verifyScenario(application, context, baseline),
    ).resolves.toEqual([
      expect.objectContaining({
        assertion: "track-lifecycle",
        passed: true,
      }),
    ]);
  });

  it("verifies read-only capability and tool-call scenarios", async () => {
    const manifest = scenarioManifestSchema.parse({
      formatVersion: 1,
      id: "inspection",
      group: "inspection",
      prompt: "Inspect Live",
      artifactPrefix: "AA_SMOKE_INSPECT_",
      allowedTools: ["ableton_session"],
      allowedActions: {
        ableton_session: ["connection-status", "inspect"],
      },
      allowedRisks: ["read"],
      maxToolCalls: 2,
      maxMutations: 0,
      timeoutMs: 60_000,
      assertions: [
        {
          type: "connection-capabilities",
          requiredCapabilities: ["session.inspect"],
        },
        { type: "session-unchanged" },
        {
          type: "tool-calls",
          required: [
            {
              toolName: "ableton_session",
              action: "connection-status",
              min: 1,
              max: 1,
            },
            {
              toolName: "ableton_session",
              action: "inspect",
              min: 1,
              max: 1,
            },
          ],
        },
      ],
    });
    const context = createScenarioRunContext(manifest);
    await context.approvals.request(
      request("ableton_session", "read", { action: "connection-status" }),
    );
    await context.approvals.request(
      request("ableton_session", "read", { action: "inspect" }),
    );
    const snapshot: SessionSnapshot = {
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 0,
      tracks: [],
      clips: [],
    };
    const application = {
      inspectSession: async () => snapshot,
      getStatus: async () => ({
        state: "connected" as const,
        liveVersion: "11.3.43",
        remoteScriptVersion: "0.4.1",
        liveSetId: "set",
        liveSetName: "Test Set",
        saved: true,
      }),
      getCapabilities: async () => ({
        capabilities: { "session.inspect": true },
      }),
    } as unknown as HeadlessApplication;

    const results = await verifyScenario(
      application,
      context,
      structuredClone(snapshot),
    );
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("redacts secrets, paths, and non-generated project names", () => {
    expect(
      sanitizeTraceValue({
        token: "secret",
        filePath: "/Users/example/project.als",
        name: "User Bass",
        generatedName: "AA_SMOKE_808_run_808 Drums",
        result: JSON.stringify({ name: "User Drums", noteCount: 4 }),
      }),
    ).toEqual({
      token: "[redacted]",
      filePath: "[path-redacted]",
      name: "[name-redacted]",
      generatedName: "AA_SMOKE_808_run_808 Drums",
      result: { name: "[name-redacted]", noteCount: 4 },
    });
  });
});
