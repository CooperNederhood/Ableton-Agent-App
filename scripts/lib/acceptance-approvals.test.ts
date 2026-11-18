import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolvePermissionArguments,
  type FixtureManifest,
  type ScenarioManifest,
  type ArrangementSourceEvidence,
} from "@ableton-agent/test-support/integration";
import { arrangementTestEvidence } from "../../packages/test-support/src/integration/arrangement-test-support.js";
import {
  ScopedApprovalPolicy,
  type ScopedApproval,
  type ScopedPermission,
} from "../../tests/electron/acceptance-approvals.js";
const owner = {
  operationId: "operation",
  appSessionId: "session",
  agentId: "agent",
  conversationId: "conversation",
};
const source = {
  source: {
    trackId: "track",
    clipId: "clip",
    slotIndex: 0,
    mediaSha256: "0".repeat(64),
  },
  listenerId: "listener",
  loadedMediaPath: "/owned/source.wav",
  facts: {},
};
const rule: ScopedPermission = {
  tool: "listen",
  action: "session",
  risk: "medium",
  maxUses: 1,
  arguments: {
    "target.track": "$source.trackId",
    "target.clip": "$source.clipId",
    beats: 4,
  },
};
const request: ScopedApproval = {
  ...owner,
  tool: "listen",
  action: "session",
  risk: "medium",
  destructive: false,
  arguments: { target: { track: "track", clip: "clip" }, beats: 4 },
};
function reviewedArrangement(scenarioId: string) {
  const scenario = JSON.parse(
    readFileSync(
      new URL(
        `../../integration/acceptance-scenarios/${scenarioId}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ScenarioManifest;
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        `../../integration/fixtures/${scenario.fixtureId}/fixture.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as FixtureManifest;
  const permission = scenario.permissions.find(
    (item) => item.action === "play-arrangement-and-listen",
  )!;
  const step = scenario.steps.find((item) =>
    permission.stepIds!.includes(item.id),
  )!;
  const definition = fixture.arrangementSources!.find(
    (item) => item.id === (permission.sourceId ?? step.sourceId),
  )!;
  const binding = fixture.listenerBindings!.find(
    (item) => item.slot === definition.listenerBindingSlot,
  )!;
  const bound: ArrangementSourceEvidence = {
    ...arrangementTestEvidence().baseline,
    source: {
      view: "arrangement",
      trackId: "fd9711d3-85e3-4209-bfe8-c8d9a5e3627b",
      trackIndex: definition.trackIndex,
      startBeat: definition.startBeat,
      endBeat: definition.endBeat,
      clips: definition.clips.map((clip, index) => ({
        startBeat: clip.startBeat,
        endBeat: clip.endBeat,
        savedClipId: clip.savedClipId,
        ...(clip.midiNotesSha256 === undefined
          ? {}
          : { midiNotesSha256: clip.midiNotesSha256 }),
        clipId: `live-clip-${index}`,
        mediaSha256: clip.mediaTarget === null ? null : "a".repeat(64),
      })),
    },
    trackName: definition.trackName,
    listenerDeviceIndex: binding.deviceIndex,
  };
  const resolved = resolvePermissionArguments(permission, bound);
  const capture = {
    ...request,
    tool: "ableton_listening",
    action: "play-arrangement-and-listen",
    arguments: {
      action: "play-arrangement-and-listen",
      listenerIds: [bound.listenerId],
      sources: [
        {
          track: {
            kind: "regular",
            index: bound.source.trackIndex,
            expectedReference: bound.source.trackId,
            expectedName: bound.trackName,
          },
        },
      ],
      startBeat: resolved.startBeat,
      endBeat: resolved.endBeat,
      maximumDurationMs: 900_000,
    },
  };
  return {
    scenario,
    permission,
    bound,
    capture,
    stepId: step.id,
    sources: { [definition.id]: bound },
  };
}
describe("reviewed scoped approvals", () => {
  it("allows flexible bounded comprehension preparation without allowing recapture or unrelated mutations", () => {
    const f = reviewedArrangement("long-horizon-comprehension");
    const policy = new ScopedApprovalPolicy(f.scenario.permissions);
    const sources = { ...f.sources, "clip-1": source };
    const stop = {
      ...request,
      tool: "ableton_transport",
      action: "set-playing",
      arguments: { action: "set-playing", isPlaying: false },
    };
    const handoff = {
      ...stop,
      action: "back-to-arrangement",
      arguments: { action: "back-to-arrangement" },
    };
    const stopClips = {
      ...request,
      tool: "ableton_tracks",
      action: "stop-clips",
      arguments: {
        action: "stop-clips",
        target: {
          kind: "regular",
          index: 0,
          expectedReference: source.source.trackId,
          expectedName: "1-808 Core Kit",
        },
        quantized: false,
      },
    };
    for (const denied of [
      { ...stop, arguments: { action: "set-playing", isPlaying: true } },
      { ...stop, arguments: { ...stop.arguments, currentSongTime: 0 } },
      { ...handoff, destructive: true },
      { ...handoff, agentId: "foreign-agent" },
      {
        ...stopClips,
        arguments: {
          ...stopClips.arguments,
          target: { ...stopClips.arguments.target, index: 1 },
        },
      },
    ])
      expect(policy.decide(denied, owner, undefined, f.stepId, sources)).toBe(
        false,
      );
    for (let count = 0; count < 16; count++) {
      for (const preparation of [handoff, stopClips, stop])
        expect(
          policy.decide(preparation, owner, undefined, f.stepId, sources),
        ).toBe(true);
    }
    for (const preparation of [handoff, stopClips, stop])
      expect(
        policy.decide(preparation, owner, undefined, f.stepId, sources),
      ).toBe(false);
    for (const captureRule of f.scenario.permissions.filter(
      (permission) => permission.tool === "ableton_listening",
    ))
      expect(captureRule.maxUses).toBe(1);
    expect(policy.decide(f.capture, owner, f.bound, f.stepId, sources)).toBe(
      true,
    );
    expect(policy.decide(f.capture, owner, f.bound, f.stepId, sources)).toBe(
      false,
    );
    const sessionCapture = {
      ...request,
      tool: "ableton_listening",
      action: "play-session-and-listen",
      arguments: {
        action: "play-session-and-listen",
        target: {
          view: "session",
          track: stopClips.arguments.target,
          sceneIndex: source.source.slotIndex,
          expectedClipReference: source.source.clipId,
          expectedClipName: "clip-1",
        },
        listenerIds: [source.listenerId],
      },
    };
    expect(
      policy.decide(sessionCapture, owner, undefined, f.stepId, sources),
    ).toBe(true);
    expect(
      policy.decide(sessionCapture, owner, undefined, f.stepId, sources),
    ).toBe(false);
  });
  describe.each([
    "arrangement-long-form-listening",
    "listening-consolidation-short-audio",
    "listening-consolidation-short-midi",
    "listening-consolidation-long-audio",
    "listening-consolidation-long-midi",
  ])("canonical Arrangement selectors for %s", (scenarioId) => {
    it("admits reviewed selectors once without changing the manifest or request", () => {
      const f = reviewedArrangement(scenarioId);
      const before = structuredClone(f);
      const policy = new ScopedApprovalPolicy([f.permission]);
      expect(
        policy.decide(f.capture, owner, f.bound, f.stepId, f.sources),
      ).toBe(true);
      expect(
        policy.decide(f.capture, owner, f.bound, f.stepId, f.sources),
      ).toBe(false);
      expect(f).toEqual(before);
    });
    it("preserves listener-only requests without optional source selectors", () => {
      const f = reviewedArrangement(scenarioId);
      Reflect.deleteProperty(f.capture.arguments, "sources");
      expect(
        new ScopedApprovalPolicy([f.permission]).decide(
          f.capture,
          owner,
          f.bound,
          f.stepId,
          f.sources,
        ),
      ).toBe(true);
    });
    it.each([
      "reference",
      "name",
      "missing-reference",
      "missing-name",
      "index",
      "kind",
      "listener",
      "second-listener",
      "duplicate-source",
      "foreign-source",
      "device-reference",
      "device-index",
      "extra-track",
      "extra-source",
      "extra-argument",
      "object-not-array",
      "start",
      "end",
      "deadline",
      "owner",
      "step",
      "missing-binding",
    ])("denies %s without spending the valid source's use", (mode) => {
      const f = reviewedArrangement(scenarioId);
      const invalid = structuredClone(f.capture);
      const args = invalid.arguments;
      const selector = args.sources[0]!;
      if (mode === "reference") selector.track.expectedReference = "foreign";
      if (mode === "name") selector.track.expectedName = "foreign";
      if (mode === "missing-reference")
        Reflect.deleteProperty(selector.track, "expectedReference");
      if (mode === "missing-name")
        Reflect.deleteProperty(selector.track, "expectedName");
      if (mode === "index") selector.track.index++;
      if (mode === "kind") selector.track.kind = "return";
      if (mode === "listener") args.listenerIds[0] = "foreign";
      if (mode === "second-listener") args.listenerIds.push("foreign");
      if (mode === "duplicate-source")
        args.sources.push(structuredClone(selector));
      if (mode === "foreign-source")
        args.sources.push({
          track: { ...selector.track, expectedReference: "foreign" },
        });
      if (mode === "device-reference")
        Reflect.set(selector, "listenerDeviceReference", "unverified-device");
      if (mode === "device-index")
        Reflect.set(
          selector,
          "listenerDeviceIndex",
          f.bound.listenerDeviceIndex,
        );
      if (mode === "extra-track") Reflect.set(selector.track, "extra", true);
      if (mode === "extra-source") Reflect.set(selector, "extra", true);
      if (mode === "extra-argument") Reflect.set(args, "extra", true);
      if (mode === "object-not-array")
        Reflect.set(args, "sources", { 0: selector });
      if (mode === "start") args.startBeat = Number(args.startBeat) + 1;
      if (mode === "end") args.endBeat = Number(args.endBeat) + 1;
      if (mode === "deadline") args.maximumDurationMs = 30_000;
      if (mode === "owner") invalid.conversationId = "foreign";
      const policy = new ScopedApprovalPolicy([f.permission]);
      expect(
        policy.decide(
          invalid,
          owner,
          mode === "missing-binding" ? undefined : f.bound,
          mode === "step" ? "unreviewed-step" : f.stepId,
          mode === "missing-binding" ? {} : f.sources,
        ),
      ).toBe(false);
      expect(
        policy.decide(f.capture, owner, f.bound, f.stepId, f.sources),
      ).toBe(true);
    });
    it("preserves explicit deadlines and per-step guards independently of maxUses", () => {
      const f = reviewedArrangement(scenarioId);
      const policy = new ScopedApprovalPolicy([
        {
          ...f.permission,
          maxUses: 2,
          arguments: { ...f.permission.arguments, maximumDurationMs: 30_000 },
        },
      ]);
      expect(
        policy.decide(f.capture, owner, f.bound, f.stepId, f.sources),
      ).toBe(false);
      Reflect.deleteProperty(f.capture.arguments, "maximumDurationMs");
      expect(
        policy.decide(f.capture, owner, f.bound, f.stepId, f.sources),
      ).toBe(false);
      f.capture.arguments.maximumDurationMs = 30_000;
      expect(
        policy.decide(f.capture, owner, f.bound, f.stepId, f.sources),
      ).toBe(true);
      expect(
        policy.decide(f.capture, owner, f.bound, f.stepId, f.sources),
      ).toBe(false);
    });
  });
  it("keeps the saved case-13 explicit 30000-ms Session deadline denied", () => {
    const scenario = JSON.parse(
      readFileSync(
        new URL(
          "../../integration/acceptance-scenarios/session-two-midi-listening.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as ScenarioManifest;
    const policy = new ScopedApprovalPolicy(scenario.permissions);
    const capture = {
      ...request,
      tool: "ableton_listening",
      action: "play-session-and-listen",
      arguments: {
        action: "play-session-and-listen",
        target: {
          view: "session",
          track: {
            kind: "regular",
            index: 0,
            expectedReference: "track",
            expectedName: "1-Operator",
          },
          sceneIndex: 0,
          expectedClipReference: "clip",
          expectedClipName: "clip-1",
        },
        listenerIds: ["listener"],
        durationBeats: 4,
        maximumDurationMs: 30_000,
      },
    };
    expect(policy.decide(capture, owner, source, "listen-operator")).toBe(
      false,
    );
    capture.arguments.maximumDurationMs = 900_000;
    expect(policy.decide(capture, owner, source, "listen-operator")).toBe(true);
  });
  it.each([false, true])(
    "admits only the canonical default listening deadline (named source=%s)",
    (namedSource) => {
      const scenario = JSON.parse(
        readFileSync(
          new URL(
            "../../integration/acceptance-scenarios/session-clip-identify.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as { permissions: ScopedPermission[] };
      const captureRule = {
        ...scenario.permissions[0]!,
        ...(namedSource ? { sourceId: "a" } : {}),
      };
      const arguments_ = {
        action: "play-session-and-listen",
        target: {
          view: "session",
          track: {
            kind: "regular",
            index: 0,
            expectedReference: "track",
            expectedName: "audio-track",
          },
          sceneIndex: 0,
          expectedClipReference: "clip",
          expectedClipName: "clip-1",
        },
        listenerIds: ["listener"],
      };
      const captureRequest = {
        ...request,
        tool: "ableton_listening",
        action: "play-session-and-listen",
      };
      const policy = new ScopedApprovalPolicy([captureRule]);
      for (const maximumDurationMs of [300_000, 900_001, 120_000]) {
        expect(
          policy.decide(
            {
              ...captureRequest,
              arguments: { ...arguments_, maximumDurationMs },
            },
            owner,
            source,
            "listen",
            { a: source },
          ),
        ).toBe(false);
      }
      const normalized = {
        ...captureRequest,
        arguments: { ...arguments_, maximumDurationMs: 900_000 },
      };
      expect(
        policy.decide(
          {
            ...normalized,
            arguments: {
              ...normalized.arguments,
              listenerIds: ["foreign-listener"],
            },
          },
          owner,
          source,
          "listen",
          { a: source },
        ),
      ).toBe(false);
      expect(
        policy.decide(normalized, owner, source, "listen", { a: source }),
      ).toBe(true);
      expect(
        policy.decide(normalized, owner, source, "listen", { a: source }),
      ).toBe(false);
      expect(
        new ScopedApprovalPolicy([captureRule]).decide(
          { ...captureRequest, arguments: arguments_ },
          owner,
          source,
          "listen",
          { a: source },
        ),
      ).toBe(true);
      const boundedRule = {
        ...captureRule,
        arguments: { ...captureRule.arguments, maximumDurationMs: 120_000 },
      };
      expect(
        new ScopedApprovalPolicy([boundedRule]).decide(
          { ...captureRequest, arguments: arguments_ },
          owner,
          source,
          "listen",
          { a: source },
        ),
      ).toBe(false);
      expect(
        new ScopedApprovalPolicy([boundedRule]).decide(
          {
            ...captureRequest,
            arguments: { ...arguments_, maximumDurationMs: 120_000 },
          },
          owner,
          source,
          "listen",
          { a: source },
        ),
      ).toBe(true);
    },
  );
  it("allows the reviewed three-minute case's exact single seek only in its listen step", () => {
    const scenario = JSON.parse(
      readFileSync(
        new URL(
          "../../integration/acceptance-scenarios/arrangement-long-form-listening.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { permissions: ScopedPermission[] };
    const rules = scenario.permissions.filter(
      ({ action }) => action === "seek",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      tool: "ableton_transport",
      risk: "medium",
      maxUses: 1,
      sourceId: "arrangement-source",
      stepIds: ["listen"],
      arguments: { action: "seek", time: 0 },
    });
    const policy = new ScopedApprovalPolicy(rules);
    const seek = {
      ...request,
      tool: "ableton_transport",
      action: "seek",
      arguments: { action: "seek", time: 0 },
    };
    const sources = { "arrangement-source": source };
    expect(
      policy.decide(
        { ...seek, arguments: { action: "seek", time: 1 } },
        owner,
        source,
        "listen",
        sources,
      ),
    ).toBe(false);
    expect(
      policy.decide(
        { ...seek, arguments: { action: "seek", time: 0, extra: true } },
        owner,
        source,
        "listen",
        sources,
      ),
    ).toBe(false);
    expect(policy.decide(seek, owner, source, "another-step", sources)).toBe(
      false,
    );
    expect(policy.decide(seek, owner, source, "listen")).toBe(false);
    expect(policy.decide(seek, owner, source, "listen", sources)).toBe(true);
    expect(policy.decide(seek, owner, source, "listen", sources)).toBe(false);
  });
  it.each(["valid", "foreign", "duplicate", "historical", "extra-argument"])(
    "admits an equivalent batch of source-scoped derivations atomically (%s)",
    (mode) => {
      const sources = {
        first: { ...source, contextId: "context-1" },
        second: {
          ...source,
          source: { ...source.source, clipId: "clip-2", slotIndex: 1 },
          contextId: "context-2",
        },
      };
      const policy = new ScopedApprovalPolicy(
        Object.keys(sources).map((sourceId) => ({
          tool: "ableton_context",
          action: "derive-features",
          risk: "medium",
          sourceId,
          maxUses: 1,
          arguments: {
            action: "derive-features",
            "contextIds.0": "$source.contextId",
            includeHistorical: false,
          },
        })),
      );
      const batch = {
        ...request,
        tool: "ableton_context",
        action: "derive-features",
        arguments: {
          action: "derive-features",
          contextIds: ["context-1", "context-2"],
          includeHistorical: false,
        },
      };
      const attempted = {
        ...batch,
        arguments: {
          ...batch.arguments,
          ...(mode === "foreign"
            ? { contextIds: ["context-1", "foreign"] }
            : {}),
          ...(mode === "duplicate"
            ? { contextIds: ["context-1", "context-1"] }
            : {}),
          ...(mode === "historical" ? { includeHistorical: true } : {}),
          ...(mode === "extra-argument" ? { unsafe: true } : {}),
        },
      };
      expect(
        policy.decide(attempted, owner, undefined, "listen", sources),
      ).toBe(mode === "valid");
      if (mode !== "valid")
        expect(policy.decide(batch, owner, undefined, "listen", sources)).toBe(
          true,
        );
      expect(policy.decide(batch, owner, undefined, "listen", sources)).toBe(
        false,
      );
    },
  );
  it("allows four optional actor stops in one step and one source handoff without permitting start or seek", () => {
    const policy = new ScopedApprovalPolicy([
      {
        tool: "ableton_transport",
        action: "set-playing",
        risk: "medium",
        maxUses: 4,
        arguments: { action: "set-playing", isPlaying: false },
      },
      {
        tool: "ableton_transport",
        action: "back-to-arrangement",
        risk: "medium",
        maxUses: 1,
        arguments: { action: "back-to-arrangement" },
      },
    ]);
    const stop = {
      ...request,
      tool: "ableton_transport",
      action: "set-playing",
      arguments: { action: "set-playing", isPlaying: false },
    };
    expect(
      policy.decide(
        { ...stop, arguments: { action: "set-playing", isPlaying: true } },
        owner,
        undefined,
        "listen",
      ),
    ).toBe(false);
    expect(
      policy.decide(
        { ...stop, arguments: { ...stop.arguments, currentSongTime: 0 } },
        owner,
        undefined,
        "listen",
      ),
    ).toBe(false);
    for (let count = 0; count < 4; count++)
      expect(policy.decide(stop, owner, undefined, "listen")).toBe(true);
    expect(policy.decide(stop, owner, undefined, "listen")).toBe(false);
    const handoff = {
      ...stop,
      action: "back-to-arrangement",
      arguments: { action: "back-to-arrangement" },
    };
    expect(policy.decide(handoff, owner, undefined, "listen")).toBe(true);
    expect(policy.decide(handoff, owner, undefined, "listen")).toBe(false);
  });
  it("binds distinct sources within one turn without spending another source's single use", () => {
    const sources = {
      first: source,
      second: {
        ...source,
        source: { ...source.source, clipId: "clip-2", slotIndex: 1 },
      },
    };
    const policy = new ScopedApprovalPolicy(
      Object.keys(sources).map((sourceId) => ({
        ...rule,
        sourceId,
        stepIds: ["identify"],
      })),
    );
    expect(policy.decide(request, owner, undefined, "identify", sources)).toBe(
      true,
    );
    expect(policy.decide(request, owner, undefined, "identify", sources)).toBe(
      false,
    );
    const second = {
      ...request,
      arguments: { target: { track: "track", clip: "clip-2" }, beats: 4 },
    };
    expect(policy.decide(second, owner, undefined, "other", sources)).toBe(
      false,
    );
    expect(policy.decide(second, owner, undefined, "identify", {})).toBe(false);
    expect(policy.decide(second, owner, undefined, "identify", sources)).toBe(
      true,
    );
    expect(policy.decide(second, owner, undefined, "identify", sources)).toBe(
      false,
    );
  });
  it("binds the selected listener and permits each reviewed step only once", () => {
    const policy = new ScopedApprovalPolicy([
      {
        ...rule,
        maxUses: 2,
        stepIds: ["listen-a", "listen-a-again"],
        arguments: { ...rule.arguments, "listenerIds.0": "$source.listenerId" },
      },
    ]);
    const listening = {
      ...request,
      arguments: {
        target: { track: "track", clip: "clip" },
        beats: 4,
        listenerIds: ["listener"],
      },
    };
    expect(policy.decide(listening, owner, source, "identify")).toBe(false);
    expect(policy.decide(listening, owner, source)).toBe(false);
    expect(policy.decide(listening, owner, source, "listen-a")).toBe(true);
    expect(policy.decide(listening, owner, source, "listen-a")).toBe(false);
    expect(
      policy.decide(
        listening,
        owner,
        {
          ...source,
          listenerId: "other-listener",
        },
        "listen-a-again",
      ),
    ).toBe(false);
    expect(policy.decide(listening, owner, source, "listen-a-again")).toBe(
      true,
    );
  });
  it("binds exact structured arguments and consumes a finite rule budget", () => {
    const policy = new ScopedApprovalPolicy([rule]);
    expect(policy.decide(request, owner, source)).toBe(true);
    expect(policy.decide(request, owner, source)).toBe(false);
  });
  it.each([
    "operationId",
    "appSessionId",
    "agentId",
    "conversationId",
  ] as const)("denies a foreign %s", (key) => {
    expect(
      new ScopedApprovalPolicy([rule]).decide(
        { ...request, [key]: "other" },
        owner,
        source,
      ),
    ).toBe(false);
  });
  it("denies missing bindings, extra arguments, duplicate rules and high-risk work", () => {
    expect(new ScopedApprovalPolicy([rule]).decide(request, owner)).toBe(false);
    expect(
      new ScopedApprovalPolicy([rule]).decide(
        {
          ...request,
          arguments: {
            target: { track: "track", clip: "clip" },
            beats: 4,
            extra: true,
          },
        },
        owner,
        source,
      ),
    ).toBe(false);
    expect(
      new ScopedApprovalPolicy([rule, rule]).decide(request, owner, source),
    ).toBe(false);
    expect(
      new ScopedApprovalPolicy([rule]).decide(
        { ...request, risk: "high" },
        owner,
        source,
      ),
    ).toBe(false);
    expect(
      new ScopedApprovalPolicy([rule]).decide(
        { ...request, destructive: true },
        owner,
        source,
      ),
    ).toBe(false);
  });
  it.each([
    { token: "[REDACTED]" },
    { "target.track": "track" },
    { target: {} },
    { beats: Number.NaN },
    { tooLong: "x".repeat(2049) },
  ])("rejects ambiguous or incomplete argument evidence %#", (arguments_) => {
    expect(() =>
      new ScopedApprovalPolicy([rule]).decide(
        { ...request, arguments: arguments_ },
        owner,
        source,
      ),
    ).toThrow();
  });
});
