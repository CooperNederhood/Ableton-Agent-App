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
  trackId: "track",
  clipId: "clip",
  slotIndex: 0,
  mediaSha256: "0".repeat(64),
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
