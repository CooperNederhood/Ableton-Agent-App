import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  exitCodeForError,
  exitCodeForOperationFailures,
} from "./exit-codes.js";

describe("EXIT_CODES", () => {
  it("matches the documented stable exit-code contract", () => {
    // Kept in sync with docs/cli/terminal-client.md#output-formats-and-exit-codes.
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      USAGE_ERROR: 2,
      CONNECTION_ERROR: 3,
      APPROVAL_ERROR: 4,
      OPERATION_ERROR: 5,
      INTERRUPTED: 130,
    });
  });

  it("classifies connection, approval, and operation failures", () => {
    expect(exitCodeForError({ code: "connection_closed" })).toBe(
      EXIT_CODES.CONNECTION_ERROR,
    );
    expect(exitCodeForError({ code: "permission_denied" })).toBe(
      EXIT_CODES.APPROVAL_ERROR,
    );
    expect(exitCodeForError(new Error("agent failed"))).toBe(
      EXIT_CODES.OPERATION_ERROR,
    );
    expect(exitCodeForOperationFailures([{ code: "permission_denied" }])).toBe(
      EXIT_CODES.APPROVAL_ERROR,
    );
    expect(exitCodeForOperationFailures([{ code: "tool_failed" }])).toBe(
      EXIT_CODES.OPERATION_ERROR,
    );
    expect(exitCodeForOperationFailures([{ code: "not_connected" }])).toBe(
      EXIT_CODES.CONNECTION_ERROR,
    );
  });

  it("has no duplicate exit-code values", () => {
    const values = Object.values(EXIT_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});
