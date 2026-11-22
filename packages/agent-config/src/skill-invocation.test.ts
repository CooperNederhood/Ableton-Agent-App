import { describe, expect, it } from "vitest";

import {
  InvalidSkillInvocationError,
  formatSkillInvocation,
  parseArtifactScopeToken,
  parseSkillInvocation,
} from "./skill-invocation.js";

describe("skill invocation parsing", () => {
  it("parses a slash skill and preserves its request", () => {
    const invocation = parseSkillInvocation(
      "/mix-review tighten the low end, then preserve dynamics",
    );

    expect(invocation).toEqual({
      skillName: "mix-review",
      request: "tighten the low end, then preserve dynamics",
    });
    expect(formatSkillInvocation(invocation!)).toBe(
      "/mix-review tighten the low end, then preserve dynamics",
    );
  });

  it("leaves legacy prompts alone", () => {
    expect(parseSkillInvocation("Help me balance the mix")).toBeUndefined();
  });

  it.each(["/", "/Mix-Review request", "/mix/review request"])(
    "rejects malformed slash input %s",
    (input) => {
      expect(() => parseSkillInvocation(input)).toThrow(
        InvalidSkillInvocationError,
      );
    },
  );

  it.each([
    ["i only do dnb --scope profile", "profile", "i only do dnb"],
    ["--scope=set track roles", "live-set", "track roles"],
    ["--scope Session", "session", ""],
  ])("extracts the scope token from %s", (input, scope, request) => {
    expect(parseArtifactScopeToken(input)).toEqual({ scope, request });
  });

  it("leaves requests without a scope token unchanged", () => {
    expect(parseArtifactScopeToken("  remember sidechain ")).toEqual({
      request: "remember sidechain",
    });
  });

  it.each(["--scope", "x --scope galaxy"])("rejects %s", (input) => {
    expect(() => parseArtifactScopeToken(input)).toThrow(
      InvalidSkillInvocationError,
    );
  });
});
