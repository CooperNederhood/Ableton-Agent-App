import { describe, expect, it } from "vitest";
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
describe("reviewed scoped approvals", () => {
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
