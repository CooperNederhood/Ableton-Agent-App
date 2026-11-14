import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type {
  DriverContext,
  LifecycleEvent,
} from "@ableton-agent/test-support/integration";
import { arrangementTestEvidence } from "../../packages/test-support/src/integration/arrangement-test-support.js";
import {
  loadedArrangementState,
  handoffArrangementSource,
  arrangementOwnerReleased,
  arrangementCaptureToolCausation,
  readArrangementAcceptanceSource,
  readSavedArrangementSource,
  type ArrangementEvidenceReads,
} from "../../tests/electron/acceptance-arrangement.js";
import { ScopedApprovalPolicy } from "../../tests/electron/acceptance-approvals.js";
import { PackagedAcceptanceDriver } from "../../tests/electron/acceptance-driver.js";
import { createSyntheticMetricRecordStreamFixture } from "@ableton-agent/protocol/testing";
import { readArrangementMetricChunks } from "../../tests/electron/acceptance-arrangement.js";
import {
  inspectArrangementListeningSourceResultSchema,
  transportOperationResultSchema,
} from "@ableton-agent/protocol";
import { appEventSchema } from "../../apps/desktop/src/contracts.js";

describe("Arrangement capture tool attribution", () => {
  function fixture() {
    const owner = {
      appSessionId: "10000000-0000-4000-8000-000000000001",
      agentId: "10000000-0000-4000-8000-000000000002",
      conversationId: "conversation-1",
      userMessageId: "10000000-0000-4000-8000-000000000003",
      operationId: "10000000-0000-4000-8000-000000000003",
      sdkTurnId: "sdk-turn-1",
    };
    const event = appEventSchema.parse({
      type: "approval.requested",
      operationId: owner.operationId,
      appSessionId: owner.appSessionId,
      agentInstanceId: owner.agentId,
      sdkSessionId: owner.conversationId,
      trace: {
        traceId: owner.sdkTurnId,
        correlationId: owner.sdkTurnId,
        causationId: "capture-tool-1",
      },
      approval: {
        id: "10000000-0000-4000-8000-000000000004",
        title: "Play and listen to audio",
        risk: "medium",
        summary: "One reviewed Arrangement capture",
        changes: [],
        destructive: false,
        tool: {
          name: "ableton_listening",
          action: "play-arrangement-and-listen",
          arguments: { action: "play-arrangement-and-listen" },
          argumentsComplete: true,
        },
      },
    });
    if (event.type !== "approval.requested")
      throw new Error("Wrong test event");
    return { owner, event };
  }
  it("uses the independently observed tool call, not the user-message id", () => {
    const { owner, event } = fixture();
    expect(arrangementCaptureToolCausation([event], owner)).toBe(
      "capture-tool-1",
    );
    expect(() => arrangementCaptureToolCausation([], owner)).toThrow("Missing");
    expect(() =>
      arrangementCaptureToolCausation([event, event], owner),
    ).toThrow("ambiguous");
  });
  it.each([
    "operationId",
    "appSessionId",
    "agentId",
    "conversationId",
    "sdkTurnId",
  ] as const)("rejects an unrelated %s", (field) => {
    const { owner, event } = fixture();
    expect(() =>
      arrangementCaptureToolCausation([event], {
        ...owner,
        [field]: "unrelated",
      }),
    ).toThrow("Missing");
  });
  it("rejects a different action or correlation", () => {
    const { owner, event } = fixture();
    expect(() =>
      arrangementCaptureToolCausation(
        [{ ...event, approval: { ...event.approval, tool: undefined } }],
        owner,
      ),
    ).toThrow("Missing");
    expect(() =>
      arrangementCaptureToolCausation(
        [{ ...event, trace: { ...event.trace!, correlationId: "unrelated" } }],
        owner,
      ),
    ).toThrow("Missing");
  });
});

describe("authenticated Arrangement owner release", () => {
  async function fixture() {
    const stream = await createSyntheticMetricRecordStreamFixture();
    const row: Record<string, unknown> = { ...stream.descriptor.ownership };
    const attributes = {
      passId: stream.descriptor.ownership.passId,
      cleanupPolicy: "leave-running",
      sourceOwnership: "authenticated-listener-registry",
      listenerOwnerReleased: true,
      listeners: [row],
    };
    return { ownership: stream.descriptor.ownership, row, attributes };
  }
  it("uses the emitted owner row rather than a nonexistent scalar listener id", async () => {
    const h = await fixture();
    expect(arrangementOwnerReleased(h.attributes, h.ownership)).toBe(true);
    h.attributes.listenerOwnerReleased = false;
    expect(arrangementOwnerReleased(h.attributes, h.ownership)).toBe(false);
  });
  it.each([
    "listenerId",
    "connectionId",
    "connectionEpoch",
    "generation",
    "nativeEpoch",
  ])("rejects a different %s", async (field) => {
    const h = await fixture();
    h.row[field] = "wrong-owner";
    expect(arrangementOwnerReleased(h.attributes, h.ownership)).toBe(false);
  });
  it("rejects extra or missing listener rows", async () => {
    const h = await fixture();
    h.attributes.listeners.push(h.row);
    expect(arrangementOwnerReleased(h.attributes, h.ownership)).toBe(false);
    h.attributes.listeners = [];
    expect(arrangementOwnerReleased(h.attributes, h.ownership)).toBe(false);
  });
});

describe("declared Arrangement source handoff", () => {
  function fixture() {
    const state = {
      transportPlaying: false,
      currentBeat: 72,
      tempoBpm: 128,
      loopEnabled: false,
      arrangementRecord: false,
      sessionRecord: false,
      overdub: false,
      sessionAutomationRecord: false,
      globalBackToArrangement: true,
      targetArmed: true,
      targetMonitoring: 2,
      arrangementEligible: null,
      playingSessionClips: 0,
      queuedSessionClips: 0,
    };
    const before = inspectArrangementListeningSourceResultSchema.parse({
      schemaVersion: 1,
      queryId: "10000000-0000-4000-8000-000000000001",
      track: {
        kind: "regular",
        index: 1,
        expectedReference: "10000000-0000-4000-8000-000000000002",
        expectedName: "Track",
      },
      range: { startBeat: 0, endBeat: 384 },
      projectRevision: 1,
      evidence: "message-rate-only",
      projectPath: "/owned/prepared.als",
      before: state,
      after: state,
      clips: [
        {
          clipId: "10000000-0000-4000-8000-000000000003",
          name: "Source",
          startBeat: 0,
          endBeat: 16,
          filePath: "/owned/source.aif",
          sampleRate: 48000,
          sampleLength: 360000,
          recording: false,
          warped: true,
          startMarker: 0,
          endMarker: 16,
          loopStart: 0,
          loopEnd: 16,
          looping: true,
          gain: 1,
          pitchCoarse: 0,
          pitchFine: 0,
        },
      ],
    });
    const after = structuredClone(before);
    after.before.globalBackToArrangement = false;
    after.before.arrangementEligible = true;
    after.after = { ...after.before };
    const transport = {
      currentSongTime: 72,
      isPlaying: false,
      tempo: 128,
      timeSignature: { numerator: 4, denominator: 4 },
      metronome: false,
      launchQuantization: 0,
      recordQuantization: 0,
      linkEnabled: false,
      backToArrangement: true,
    };
    const result = transportOperationResultSchema.parse({
      action: "back-to-arrangement",
      before: transport,
      after: { ...transport, backToArrangement: false },
      verified: true,
    });
    const controller = new AbortController();
    const read = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const restore = vi.fn(async () => result);
    return {
      before,
      after,
      read,
      restore,
      controller,
      result,
      input: { read, restore, signal: controller.signal },
    };
  }
  it("returns verified evidence after exactly one source mutation and two independent reads", async () => {
    const h = fixture();
    expect(await handoffArrangementSource(h.input)).toEqual({
      command: "transport.back_to_arrangement",
      dispatchedCount: 1,
      beforeBackToArrangement: true,
      afterBackToArrangement: false,
      transportStopped: true,
      verified: true,
    });
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.restore).toHaveBeenCalledTimes(1);
    expect(h.read.mock.invocationCallOrder[0]).toBeLessThan(
      h.restore.mock.invocationCallOrder[0]!,
    );
    expect(h.restore.mock.invocationCallOrder[0]).toBeLessThan(
      h.read.mock.invocationCallOrder[1]!,
    );
  });
  it.each(["arrangementRecord", "sessionRecord", "transportPlaying"] as const)(
    "denies %s before mutation",
    async (field) => {
      const h = fixture();
      h.before.before[field] = true;
      await expect(handoffArrangementSource(h.input)).rejects.toThrow(
        "Loaded Arrangement state",
      );
      expect(h.restore).not.toHaveBeenCalled();
    },
  );
  it("denies active Session clips rather than interrupting unrelated playback", async () => {
    const h = fixture();
    h.before.before.playingSessionClips = 1;
    await expect(handoffArrangementSource(h.input)).rejects.toThrow(
      "Loaded Arrangement state",
    );
    expect(h.restore).not.toHaveBeenCalled();
  });
  it("does not retry a rejected mutation", async () => {
    const h = fixture();
    h.restore.mockRejectedValueOnce(new Error("bridge failure"));
    await expect(handoffArrangementSource(h.input)).rejects.toThrow(
      "bridge failure",
    );
    expect(h.restore).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(1);
  });
  it("rejects unverified Arrangement eligibility after handoff", async () => {
    const h = fixture();
    h.after.before.arrangementEligible = null;
    await expect(handoffArrangementSource(h.input)).rejects.toThrow(
      "Loaded Arrangement state",
    );
  });
  it("rejects protected state changes", async () => {
    const h = fixture();
    h.after.before.tempoBpm = 129;
    h.after.after.tempoBpm = 129;
    await expect(handoffArrangementSource(h.input)).rejects.toThrow(
      "protected source state",
    );
  });
  it("rejects changed source media after handoff", async () => {
    const h = fixture();
    h.after.clips[0]!.filePath = "/owned/different.aif";
    await expect(handoffArrangementSource(h.input)).rejects.toThrow(
      "protected source state",
    );
  });
  it("rejects unrelated transport setting changes", async () => {
    const h = fixture();
    if (h.result.action !== "back-to-arrangement" || !("after" in h.result))
      throw new Error("Unexpected test transport result");
    h.result.after.metronome = true;
    await expect(handoffArrangementSource(h.input)).rejects.toThrow(
      "protected transport state",
    );
  });
  it("honors cancellation before dispatch", async () => {
    const h = fixture();
    h.read.mockReset().mockImplementationOnce(async () => {
      h.controller.abort();
      return h.before;
    });
    await expect(handoffArrangementSource(h.input)).rejects.toThrow();
    expect(h.restore).not.toHaveBeenCalled();
  });
  it("honors cancellation after mutation without retrying", async () => {
    const h = fixture();
    h.restore.mockImplementationOnce(async () => {
      h.controller.abort();
      return transportOperationResultSchema.parse({
        action: "back-to-arrangement",
        before: {
          currentSongTime: 72,
          isPlaying: false,
          tempo: 128,
          timeSignature: { numerator: 4, denominator: 4 },
          metronome: false,
          launchQuantization: 0,
          recordQuantization: 0,
          linkEnabled: false,
          backToArrangement: true,
        },
        after: {
          currentSongTime: 72,
          isPlaying: false,
          tempo: 128,
          timeSignature: { numerator: 4, denominator: 4 },
          metronome: false,
          launchQuantization: 0,
          recordQuantization: 0,
          linkEnabled: false,
          backToArrangement: false,
        },
        verified: true,
      });
    });
    await expect(handoffArrangementSource(h.input)).rejects.toThrow();
    expect(h.restore).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(1);
  });
});

describe("loaded Arrangement guard diagnostics", () => {
  it.each([true, null])(
    "retains the exact blocked override state %s",
    (override) => {
      expect(() =>
        loadedArrangementState(
          {
            transportPlaying: false,
            currentBeat: 72,
            tempoBpm: 128,
            loopEnabled: false,
            arrangementRecord: false,
            sessionRecord: false,
            overdub: false,
            sessionAutomationRecord: false,
            globalBackToArrangement: override,
            targetArmed: true,
            targetMonitoring: 2,
            arrangementEligible: false,
            playingSessionClips: 0,
            queuedSessionClips: 0,
          },
          [],
        ),
      ).toThrow(`"globalBackToArrangement":${override}`);
    },
  );
});

function savedXml() {
  const clip = (id: number, start: number, end: number) =>
    `<AudioClip Id="${id}" Time="${start}"><CurrentStart Value="${start}"/><CurrentEnd Value="${end}"/><SampleRef><FileRef><RelativePathType Value="3"/><RelativePath Value="media/resource-001.aif"/><Path Value=""/><Type Value="2"/></FileRef></SampleRef></AudioClip>`;
  return `<Ableton Creator="Ableton Live 11.3.43"><LiveSet><Tracks><MidiTrack/><AudioTrack><Name><EffectiveName Value="Track"/></Name><DeviceChain><MainSequencer><ClipSlotList>${clip(90, 0, 4)}</ClipSlotList><Sample><ArrangerAutomation><Events>${clip(1, 0, 16)}${clip(2, 16, 32)}</Events></ArrangerAutomation></Sample></MainSequencer></DeviceChain></AudioTrack><ReturnTrack/></Tracks></LiveSet></Ableton>`;
}
describe("bounded independent persisted stream pages", () => {
  const context = () => ({
    sessionId: "session-1",
    captureId: "capture-1",
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
  });
  async function collect(input: AsyncIterable<unknown>) {
    const output = [];
    for await (const chunk of input) output.push(chunk);
    return output;
  }
  it("uses the global storage cursor rather than per-metric wire sequence", async () => {
    const stream = await createSyntheticMetricRecordStreamFixture();
    const chunks = [];
    for await (const chunk of stream.chunks()) chunks.push(chunk);
    const expected = chunks.slice(0, 2);
    const read = vi.fn(async (request: { afterSequence?: number }) => {
      const items =
        request.afterSequence === -1 ? [expected[0]!] : [expected[1]!];
      return {
        items,
        encodedBytes: Buffer.byteLength(JSON.stringify(items)),
        ...(request.afterSequence === -1 ? { nextSequence: 17 } : {}),
      };
    });
    expect(await collect(readArrangementMetricChunks(read, context()))).toEqual(
      expected,
    );
    expect(read.mock.calls.map(([request]) => request.afterSequence)).toEqual([
      -1, 17,
    ]);
  });
  it.each(["cursor", "empty-continuation", "byte-count", "malformed"] as const)(
    "rejects %s evidence rather than skipping missing pages",
    async (failure) => {
      const stream = await createSyntheticMetricRecordStreamFixture();
      const next = await stream.chunks().next();
      if (next.done) throw new Error("Missing synthetic chunk");
      const first = next.value;
      const items = failure === "empty-continuation" ? [] : [first];
      const read = vi.fn(async () => ({
        items,
        encodedBytes:
          failure === "byte-count"
            ? 1
            : Buffer.byteLength(JSON.stringify(items)),
        nextSequence: failure === "cursor" ? -1 : 0,
        ...(failure === "malformed" ? { extra: true } : {}),
      }));
      await expect(
        collect(readArrangementMetricChunks(read, context())),
      ).rejects.toThrow();
    },
  );
  it("cancels a hanging page and clears its deadline without dispatching another read", async () => {
    const controller = new AbortController();
    const read = vi.fn(() => new Promise<never>(() => {}));
    const pending = collect(
      readArrangementMetricChunks(read, {
        ...context(),
        signal: controller.signal,
      }),
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("times out a hanging page rather than hanging cleanup", async () => {
    const read = vi.fn(() => new Promise<never>(() => {}));
    await expect(
      collect(
        readArrangementMetricChunks(read, {
          ...context(),
          deadlineAt: Date.now() + 10,
        }),
      ),
    ).rejects.toThrow(/deadline/);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
function harness(controller = new AbortController()) {
  const inputs = arrangementTestEvidence();
  const context: DriverContext = {
    runId: "run-1",
    traceId: "trace-1",
    correlationId: "correlation-1",
    causationId: "cause-1",
    signal: controller.signal,
    deadlineAt: Date.now() + 10_000,
    fixture: inputs.fixture,
    scenario: {
      schemaVersion: 1,
      id: "synthetic",
      fixtureId: inputs.fixture.id,
      requiredCapabilities: ["arrangement-audio"],
      permissions: [],
      budget: { runMs: 1000, cleanupMs: 1000, persistenceMs: 1000 },
      steps: [],
      assertions: [],
    },
  };
  const { savedProjectSha256, savedClips, media, ...loaded } = inputs.baseline;
  const reads: ArrangementEvidenceReads = {
    saved: vi.fn(async () => ({ savedProjectSha256, savedClips })),
    loaded: vi.fn(async () => loaded),
    media: vi.fn(async () => media),
    close: vi.fn(async () => undefined),
  };
  const events: LifecycleEvent[] = [];
  return {
    ...inputs,
    context,
    reads,
    events,
    emit: (event: LifecycleEvent) => events.push(event),
  };
}
describe("Arrangement acceptance entry and independent read seam", () => {
  it("reads exact regular audio Arrangement ranges, not Session clips or returns", () => {
    const bytes = gzipSync(savedXml());
    const saved = readSavedArrangementSource(bytes, 1, "Track");
    expect(saved.creator).toBe("Ableton Live 11.3.43");
    expect(saved.savedClips).toEqual([
      {
        savedClipId: "1",
        startBeat: 0,
        endBeat: 16,
        mediaTarget: "media/resource-001.aif",
      },
      {
        savedClipId: "2",
        startBeat: 16,
        endBeat: 32,
        mediaTarget: "media/resource-001.aif",
      },
    ]);
    expect(saved.savedProjectSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => readSavedArrangementSource(bytes, 0, "Track")).toThrow();
    expect(() => readSavedArrangementSource(bytes, 1, "Other")).toThrow();
  });
  it.each([
    [
      "external media",
      (xml: string) => xml.replaceAll('Value="3"', 'Value="6"'),
    ],
    [
      "path escape",
      (xml: string) =>
        xml.replaceAll("media/resource-001.aif", "../resource.aif"),
    ],
    ["Live 12", (xml: string) => xml.replace("11.3.43", "12.0.0")],
    ["duplicate saved ID", (xml: string) => xml.replace('Id="2"', 'Id="1"')],
    [
      "invalid range",
      (xml: string) =>
        xml.replace('CurrentEnd Value="32"', 'CurrentEnd Value="15"'),
    ],
    [
      "unbalanced XML",
      (xml: string) => xml.replace("</Tracks>", "</AudioTrack>"),
    ],
  ])("rejects %s without rewriting saved bytes", (_, transform) => {
    const bytes = gzipSync(transform(savedXml())),
      before = Buffer.from(bytes);
    expect(() => readSavedArrangementSource(bytes, 1, "Track")).toThrow();
    expect(bytes).toEqual(before);
  });
  it("reads saved, loaded and media independently with traced lifecycle and cleanup", async () => {
    const h = harness();
    expect(
      await readArrangementAcceptanceSource(
        h.context,
        h.definition,
        h.reads,
        h.emit,
      ),
    ).toEqual(h.baseline);
    for (const fn of [h.reads.saved, h.reads.loaded, h.reads.media])
      expect(fn).toHaveBeenCalledWith(h.context);
    expect(h.reads.close).toHaveBeenCalledOnce();
    expect(h.events.map(({ stage, phase }) => `${stage}:${phase}`)).toEqual([
      "arrangement.preconditions:queued",
      "arrangement.preconditions:started",
      "arrangement.preconditions:progress",
      "arrangement.preconditions:progress",
      "arrangement.preconditions.cleanup:queued",
      "arrangement.preconditions.cleanup:started",
      "arrangement.preconditions.cleanup:completed",
      "arrangement.preconditions:completed",
    ]);
    for (const event of h.events) {
      expect(event).toMatchObject({
        runId: h.context.runId,
        traceId: h.context.traceId,
        correlationId: h.context.correlationId,
        causationId: h.context.causationId,
      });
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(event)).not.toContain("loadedPath");
    }
  });
  it.each(["saved", "loaded", "media", "close"] as const)(
    "fails closed and cleans up when %s fails",
    async (stage) => {
      const h = harness();
      vi.mocked(h.reads[stage]).mockRejectedValueOnce(
        new Error("controlled read failure"),
      );
      await expect(
        readArrangementAcceptanceSource(
          h.context,
          h.definition,
          h.reads,
          h.emit,
        ),
      ).rejects.toThrow("controlled read failure");
      expect(h.reads.close).toHaveBeenCalledOnce();
      expect(h.events.at(-1)).toMatchObject({
        stage: "arrangement.preconditions",
        phase: "failed",
      });
      expect(
        h.events.some(
          (event) =>
            event.stage === "arrangement.preconditions" &&
            event.phase === "completed",
        ),
      ).toBe(false);
    },
  );
  it("retains primary and cleanup failures", async () => {
    const h = harness();
    vi.mocked(h.reads.loaded).mockRejectedValueOnce(new Error("source failed"));
    vi.mocked(h.reads.close).mockRejectedValueOnce(new Error("release failed"));
    await expect(
      readArrangementAcceptanceSource(h.context, h.definition, h.reads, h.emit),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "source failed" }),
        expect.objectContaining({ message: "release failed" }),
      ],
    });
  });
  it("honors cancellation before reads and between independent reads", async () => {
    for (const when of ["before", "loaded"] as const) {
      const controller = new AbortController(),
        h = harness(controller);
      if (when === "before") controller.abort(new Error("cancelled"));
      else
        vi.mocked(h.reads.loaded).mockImplementationOnce(async () => {
          controller.abort(new Error("cancelled"));
          return h.baseline;
        });
      await expect(
        readArrangementAcceptanceSource(
          h.context,
          h.definition,
          h.reads,
          h.emit,
        ),
      ).rejects.toThrow("cancelled");
      expect(h.reads.media).not.toHaveBeenCalled();
      expect(h.reads.close).toHaveBeenCalledOnce();
      expect(h.events.at(-1)?.phase).toBe("cancelled");
    }
  });
  it("honors finite precondition deadlines and still releases reads", async () => {
    const h = harness();
    await expect(
      readArrangementAcceptanceSource(
        { ...h.context, deadlineAt: 0 },
        h.definition,
        h.reads,
        h.emit,
      ),
    ).rejects.toThrow("deadline");
    expect(h.reads.saved).not.toHaveBeenCalled();
    expect(h.reads.close).toHaveBeenCalledOnce();
  });
  it("cancels an in-flight read and bounds failed cleanup without hanging", async () => {
    const controller = new AbortController(),
      h = harness(controller);
    vi.mocked(h.reads.loaded).mockImplementationOnce(() => {
      controller.abort(new Error("in-flight cancellation"));
      return new Promise(() => undefined);
    });
    await expect(
      readArrangementAcceptanceSource(h.context, h.definition, h.reads, h.emit),
    ).rejects.toThrow("in-flight cancellation");
    expect(h.reads.close).toHaveBeenCalledOnce();
    expect(h.events.at(-1)?.phase).toBe("cancelled");
    const timeout = harness();
    vi.mocked(timeout.reads.close).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const context = {
      ...timeout.context,
      scenario: {
        ...timeout.context.scenario,
        budget: { ...timeout.context.scenario.budget, cleanupMs: 5 },
      },
    };
    await expect(
      readArrangementAcceptanceSource(
        context,
        timeout.definition,
        timeout.reads,
        timeout.emit,
      ),
    ).rejects.toThrow("deadline");
    expect(timeout.events.at(-2)?.phase).toBe("failed");
    expect(timeout.events.at(-1)?.phase).toBe("failed");
  });
  it("rejects self-consistent saved/loaded hashes that are not the verified prepared Set", async () => {
    const h = harness();
    Object.assign(h.context, {
      dependencyInventory: {
        schemaVersion: 1,
        candidateRoot: "candidate",
        resources: [],
        preparedProject: {
          target: "prepared.als",
          sha256: "c".repeat(64),
          bytes: 1,
        },
      },
    });
    await expect(
      readArrangementAcceptanceSource(h.context, h.definition, h.reads, h.emit),
    ).rejects.toThrow("verified staged/prepared");
    expect(h.reads.close).toHaveBeenCalledOnce();
  });
  it("permits only exact reviewed Arrangement scope once and denies Session substitutions", () => {
    const h = harness();
    const permission = {
      tool: "listen",
      action: "start",
      risk: "medium",
      maxUses: 1,
      stepIds: ["listen"],
      arguments: {
        track: "$source.trackId",
        start: "$source.startBeat",
        end: "$source.endBeat",
      },
    } as const;
    const owner = {
      operationId: "operation-1",
      appSessionId: "app-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
    };
    const request = {
      ...owner,
      tool: "listen",
      action: "start",
      risk: "medium",
      destructive: false,
      arguments: { track: "track-1", start: 0, end: 384 },
    };
    const policy = new ScopedApprovalPolicy([permission]);
    for (const arguments_ of [
      { track: "track-1", start: 72, end: 384 },
      { track: "track-1", start: 0, end: 384, slot: 0 },
    ])
      expect(
        policy.decide(
          { ...request, arguments: arguments_ },
          owner,
          h.baseline,
          "listen",
        ),
      ).toBe(false);
    expect(policy.decide(request, owner, h.baseline, "other-step")).toBe(false);
    expect(policy.decide(request, owner, h.baseline, "listen")).toBe(true);
    expect(policy.decide(request, owner, h.baseline, "listen")).toBe(false);
    const sessionRule = new ScopedApprovalPolicy([
      { ...permission, arguments: { clip: "$source.clipId" } },
    ]);
    expect(
      sessionRule.decide(
        { ...request, arguments: { clip: "clip-1" } },
        owner,
        h.baseline,
        "listen",
      ),
    ).toBe(false);
  });
  it("advertises dedicated Arrangement while preserving both Session source capabilities", () => {
    const driver = new PackagedAcceptanceDriver({
      runDirectory: ".test-artifacts/synthetic-not-launched",
    });
    expect(driver.capabilities).toContain("arrangement-audio");
    expect(driver.capabilities).toContain("session-audio");
    expect(driver.capabilities).toContain("session-midi");
  });
});
