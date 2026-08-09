import { describe, expect, it } from "vitest";

import { classifyErrorCode } from "./errors.js";

describe("stable error categories", () => {
  it.each([
    ["configuration_missing", "configuration"],
    ["not_connected", "connection"],
    ["invalid_params", "validation"],
    ["stale_reference", "conflict"],
    ["approval_denied", "permission"],
    ["unsupported_capability", "capability"],
    ["operation_timeout", "timeout"],
    ["lom_error", "internal"],
    ["unknown_future_error", "internal"],
  ] as const)("classifies %s as %s", (code, category) => {
    expect(classifyErrorCode(code)).toBe(category);
  });
});
