import { describe, expect, it } from "vitest";

import {
  classifyScenario,
  collectToolNames,
  shouldRetryAgentScenario,
} from "./scenario-evidence.mjs";

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

  it("accepts recovered validation probes only after all postconditions pass", () => {
    expect(
      classifyScenario(
        {},
        {
          status: 5,
          json: {
            ok: false,
            operationFailures: [{ code: "invalid_tool_arguments" }],
            assertions: [{ assertion: "cleanup", passed: true }],
            policyViolations: [],
          },
        },
      ),
    ).toBe("recovered-pass");
    expect(
      classifyScenario(
        {},
        {
          status: 5,
          json: {
            ok: false,
            operationFailures: [{ code: "invalid_tool_arguments" }],
            assertions: [{ assertion: "cleanup", passed: false }],
            policyViolations: [],
          },
        },
      ),
    ).toBe("fail");
    expect(
      classifyScenario(
        {},
        {
          status: 5,
          json: {
            ok: false,
            operationFailures: [{ code: "bridge_timeout" }],
            assertions: [{ assertion: "cleanup", passed: true }],
            policyViolations: [],
          },
        },
      ),
    ).toBe("fail");
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

  it("retries bounded model execution misses but not real workflow failures", () => {
    expect(
      shouldRetryAgentScenario({
        json: {
          operations: [],
          operationFailures: [],
          assertions: [{ assertion: "tool-calls", passed: false }],
          policyViolations: [],
          budgets: { mutations: 0 },
        },
      }),
    ).toBe(true);
    expect(
      shouldRetryAgentScenario({
        json: {
          operations: [{ type: "operation.started" }],
          operationFailures: [{ code: "invalid_tool_arguments" }],
          assertions: [],
          policyViolations: [],
          budgets: { mutations: 0 },
        },
      }),
    ).toBe(true);
    expect(
      shouldRetryAgentScenario({
        json: {
          operations: [{ type: "operation.started" }],
          operationFailures: [{ code: "bridge_timeout" }],
          assertions: [],
          policyViolations: [],
          budgets: { mutations: 0 },
        },
      }),
    ).toBe(false);
    expect(
      shouldRetryAgentScenario({
        json: {
          operations: [],
          operationFailures: [],
          assertions: [{ assertion: "tool-calls", passed: false }],
          policyViolations: [],
          budgets: { mutations: 1 },
        },
      }),
    ).toBe(false);
  });
});
