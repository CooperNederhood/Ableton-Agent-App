import { describe, expect, it } from "vitest";

import {
  InvalidSkillInvocationError,
  formatSkillInvocation,
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
});
