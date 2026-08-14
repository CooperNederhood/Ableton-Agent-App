import { describe, expect, it } from "vitest";

import { classifyScenario, collectToolNames } from "./scenario-evidence.mjs";

describe("scenario evidence", () => {
  it("classifies ordinary passes and failures", () => {
    expect(classifyScenario({}, { status: 0, json: { ok: true } })).toBe(
      "pass",
    );
    expect(classifyScenario({}, { status: 5, json: { ok: false } })).toBe(
      "fail",
    );
  });

  it("classifies reviewed denials and unsupported skips", () => {
    expect(
      classifyScenario(
        { expectedOutcome: "expected-denial" },
        {
          status: 5,
          json: {
            ok: false,
            approvals: [{ approved: false }],
            assertions: [{ passed: true }],
            operationFailures: [],
            policyViolations: [
              "scenario approval policy denied a tool request",
            ],
          },
        },
      ),
    ).toBe("expected-denial-pass");
    expect(
      classifyScenario(
        { unsupportedCapabilities: ["arrangement.create_midi_clip"] },
        {
          status: 4,
          json: {
            operationFailures: [
              {
                code: "unsupported_capability",
                capability: "arrangement.create_midi_clip",
              },
            ],
          },
        },
      ),
    ).toBe("unsupported-skip");
  });

  it("collects unique started tool names", () => {
    expect(
      collectToolNames({
        json: {
          operations: [
            { type: "operation.started", toolName: "ableton_session_inspect" },
            {
              type: "operation.completed",
              toolName: "ableton_session_inspect",
            },
            { type: "operation.started", toolName: "ableton_session_inspect" },
          ],
        },
      }),
    ).toEqual(["ableton_session_inspect"]);
  });
});
