import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyScenario,
  collectToolNames,
  recoverScenarioTrace,
  shouldRetryAgentScenario,
} from "./scenario-evidence.mjs";

describe("scenario evidence", () => {
  it("recovers timed-out tool activity and refuses retries or success classification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scenario-trace-"));
    const path = join(directory, "trace.json");
    const trace = {
      scenarioId: "fixture",
      traceState: "running",
      ok: false,
      operations: [{ type: "operation.started", toolName: "ableton_tracks" }],
      operationFailures: [{ code: "invalid_tool_arguments" }],
      assertions: [{ assertion: "tool-calls", passed: true }],
      policyViolations: [],
      budgets: { mutations: 0 },
    };
    try {
      await writeFile(path, JSON.stringify(trace));
      const result = await recoverScenarioTrace(
        { status: null, json: undefined },
        path,
        "fixture",
      );
      expect(result.evidenceSource).toBe("trace-checkpoint");
      expect(collectToolNames(result)).toEqual(["ableton_tracks"]);
      expect(classifyScenario({}, result)).toBe("fail");
      expect(shouldRetryAgentScenario(result)).toBe(false);
      expect(
        await recoverScenarioTrace(
          { status: null, json: undefined },
          path,
          "different-fixture",
        ),
      ).toMatchObject({
        evidenceSource: "unavailable",
        traceEvidenceError: expect.stringContaining("identity"),
      });
      expect(
        await recoverScenarioTrace(
          { status: 0, json: { ok: true } },
          path,
          "fixture",
        ),
      ).toMatchObject({ evidenceSource: "stdout", json: { ok: true } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never promotes failed or truncated traces to recovered passes or retries", () => {
    for (const flags of [
      { traceState: "failed" },
      { traceState: "completed", operationsTruncated: true },
      { traceState: "completed", approvalsTruncated: true },
    ]) {
      const result = {
        status: 5,
        json: {
          ...flags,
          ok: false,
          operationFailures: [{ code: "invalid_tool_arguments" }],
          assertions: [{ assertion: "cleanup", passed: true }],
          policyViolations: [],
          budgets: { mutations: 0 },
        },
      };
      expect(classifyScenario({}, result)).toBe("fail");
      expect(shouldRetryAgentScenario(result)).toBe(false);
    }
  });

  it("does not accept a completed stdout payload when process cleanup timed out or was terminated", () => {
    for (const processState of [{ timedOut: true }, { signal: "SIGTERM" }]) {
      const result = {
        ...processState,
        status: null,
        json: {
          ok: false,
          traceState: "completed",
          operationFailures: [{ code: "invalid_tool_arguments" }],
          assertions: [{ assertion: "cleanup", passed: true }],
          policyViolations: [],
          budgets: { mutations: 0 },
        },
      };
      expect(classifyScenario({}, result)).toBe("fail");
      expect(shouldRetryAgentScenario(result)).toBe(false);
    }
  });

  it("reports missing, malformed and oversized checkpoints as unavailable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scenario-trace-invalid-"));
    const path = join(directory, "trace.json");
    try {
      const missing = await recoverScenarioTrace(
        { status: null, json: undefined },
        path,
        "fixture",
      );
      expect(missing.evidenceSource).toBe("unavailable");
      expect(shouldRetryAgentScenario(missing)).toBe(false);
      await writeFile(path, "not json");
      expect(
        await recoverScenarioTrace(
          { status: null, json: undefined },
          path,
          "fixture",
        ),
      ).toMatchObject({
        evidenceSource: "unavailable",
        traceEvidenceError: expect.any(String),
      });
      await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1));
      expect(
        await recoverScenarioTrace(
          { status: null, json: undefined },
          path,
          "fixture",
        ),
      ).toMatchObject({
        evidenceSource: "unavailable",
        traceEvidenceError: expect.stringContaining("2 MiB"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("classifies ordinary passes and failures", () => {
    expect(
      classifyScenario(
        {},
        {
          status: 0,
          json: {
            ok: true,
            assertions: [{ passed: true }],
          },
        },
      ),
    ).toBe("pass");
    expect(classifyScenario({}, { status: 5, json: { ok: false } })).toBe(
      "fail",
    );
  });

  it("requires independent assertions and the selected CLI scenario identity", () => {
    for (const assertions of [undefined, []])
      expect(
        classifyScenario({}, { status: 0, json: { ok: true, assertions } }),
      ).toBe("fail");
    for (const flags of [
      {},
      { scenarioId: "wrong", traceState: "completed" },
      { scenarioId: "selected" },
    ])
      expect(
        classifyScenario(
          { id: "selected" },
          {
            status: 0,
            json: {
              ok: true,
              assertions: [{ passed: true }],
              ...flags,
            },
          },
        ),
      ).toBe("fail");
    expect(
      classifyScenario(
        { id: "selected" },
        {
          status: 0,
          json: {
            ok: true,
            assertions: [{ passed: true }],
            scenarioId: "selected",
            traceState: "completed",
          },
        },
      ),
    ).toBe("pass");
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
                details: { capability: "arrangement.create_midi_clip" },
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

  it("does not let success-shaped output hide explicit failures", () => {
    for (const flags of [
      { assertions: [{ passed: false }] },
      { operationFailures: [{ code: "bridge_timeout" }] },
      { policyViolations: ["unsafe mutation"] },
    ]) {
      expect(
        classifyScenario({}, { status: 0, json: { ok: true, ...flags } }),
      ).toBe("fail");
    }
  });

  it("requires nonempty verified assertions for an expected denial", () => {
    for (const assertions of [undefined, []]) {
      expect(
        classifyScenario(
          { expectedOutcome: "expected-denial" },
          {
            status: 5,
            json: {
              approvals: [{ approved: false }],
              assertions,
              operationFailures: [],
              policyViolations: [],
            },
          },
        ),
      ).toBe("fail");
    }
  });

  it("matches structured unsupported capability facts, never incidental text", () => {
    const capability = "arrangement.create_midi_clip";
    const manifest = { unsupportedCapabilities: [capability] };
    const failure = {
      code: "unsupported_capability",
      details: { capability },
    };
    expect(
      classifyScenario(manifest, {
        status: 4,
        json: { operationFailures: [failure] },
      }),
    ).toBe("unsupported-skip");
    for (const flags of [
      { operationFailures: [failure, { code: "bridge_timeout" }] },
      { operationFailures: [failure], assertions: [{ passed: false }] },
      { operationFailures: [failure], policyViolations: ["unsafe mutation"] },
      {
        operationFailures: [
          {
            code: "tool_failed",
            message: `unsupported_capability ${capability}`,
          },
        ],
      },
      {
        operationFailures: [
          { code: "unsupported_capability", message: capability },
        ],
      },
      {
        operationFailures: [{ code: "unsupported_capability", capability }],
      },
      {
        operationFailures: [
          {
            code: "unsupported_capability",
            details: { capability: `${capability}.other` },
          },
        ],
      },
    ]) {
      expect(classifyScenario(manifest, { status: 4, json: flags })).toBe(
        "fail",
      );
    }
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
