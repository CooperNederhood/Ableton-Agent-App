import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryEventEnvelopeSchema } from "@ableton-agent/observability";

const f = vi.hoisted(() => ({
  sequence: [],
  writes: [],
  runProcess: vi.fn(),
  owned: { pid: 1234, runId: "11111111-1111-4111-8111-111111111111" },
  cleanupError: false,
  active: false,
  failCheckpoint: false,
}));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (path, ...args) =>
      String(path).endsWith(".ableton-agent-token")
        ? "runner-secret-token-with-at-least-32-characters"
        : actual.readFile(path, ...args),
    ),
    writeFile: vi.fn(async (path, text) => {
      f.sequence.push("evidence");
      const json = JSON.parse(text);
      if (f.failCheckpoint && json.cleanup?.length > 0) {
        f.failCheckpoint = false;
        throw new Error("checkpoint failed");
      }
      f.writes.push({ path, json });
    }),
  };
});
vi.mock("./live-process-controller.mjs", () => ({
  LiveProcessController: class {
    async assertNoPreExistingLive() {
      f.sequence.push("admit");
    }
    async launch() {
      f.sequence.push("launch");
      f.active = true;
    }
    publicRecord() {
      return f.active ? f.owned : undefined;
    }
    async dismissKnownStartupDialogs() {
      return "none";
    }
    async gracefulStop() {
      f.sequence.push("graceful");
      f.active = false;
    }
    async discardAfterFailure() {
      f.sequence.push("discard");
      if (f.cleanupError) throw new Error("owned cleanup failed");
      f.active = false;
    }
  },
  createComputerUseLiveController: vi.fn(),
  runProcess: f.runProcess,
}));
vi.mock("./scenario-suite.mjs", () => ({
  loadScenarioSuite: vi.fn(async () => ({
    groups: [{ id: "transport", scenarios: ["transport-stop"] }],
  })),
  selectScenarioGroups: (suite) => suite.groups,
}));
vi.mock("./native-listening-runner.mjs", () => ({
  admitNativeScenarios: vi.fn(async () => undefined),
  createNativeListeningRunner: vi.fn(),
  reviewNativeScenario: vi.fn(),
  runNativeScenarioGroup: vi.fn(),
}));

describe("transport stop runner ownership and failure cleanup", () => {
  let argv;
  let exitCode;
  beforeEach(() => {
    vi.resetModules();
    f.sequence.length = 0;
    f.writes.length = 0;
    f.cleanupError = false;
    f.active = false;
    f.failCheckpoint = false;
    f.runProcess.mockReset();
    argv = process.argv;
    exitCode = process.exitCode;
    process.argv = [
      "node",
      "agent-smoke.mjs",
      "--skip-build",
      "--skip-install",
      "--scenario",
      "transport-stop",
      "--output",
      ".test-artifacts/transport-runner-mock.json",
    ];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  async function run(mode) {
    f.runProcess.mockImplementation(async (_command, args, options) => {
      const command = args[1];
      if (command === "status")
        return { status: 0, stdout: '{"healthy":true}', stderr: "" };
      if (command === "session-new")
        return {
          status: 0,
          stdout: '{"sessionId":"fresh-session"}',
          stderr: "",
        };
      if (command !== "run") throw new Error(`Unexpected command ${command}`);
      f.sequence.push("actor");
      expect(options.env.ABLETON_AGENT_SCENARIO_LIVE_PID).toBe(
        String(f.owned.pid),
      );
      expect(options.env.ABLETON_AGENT_SCENARIO_RUN_ID).toBe(f.owned.runId);
      expect(args).not.toContain("--approve-all");
      const success = mode === "success";
      return {
        status: success ? 0 : 5,
        timedOut: mode === "timeout",
        signal: mode === "cancelled" ? "SIGTERM" : undefined,
        stdout: JSON.stringify({
          ok: success,
          traceState: success || mode === "refusal" ? "completed" : "failed",
          scenarioId: "transport-stop",
          operations: [],
          operationFailures: [],
          assertions: [{ assertion: "transport-stopped", passed: success }],
          scenarioEvidence: {
            transportStop: {
              playing: { isPlaying: true },
              final: { isPlaying: !success },
            },
          },
        }),
        stderr: "",
      };
    });
    await import("../agent-smoke.mjs");
    return f.writes.at(-1).json;
  }

  it.each(["refusal", "timeout", "cancelled"])(
    "retains actor failure before exact-owned cleanup without retry: %s",
    async (mode) => {
      const evidence = await run(mode);
      expect(f.sequence.filter((item) => item === "actor")).toHaveLength(1);
      expect(f.sequence).toContain("discard");
      expect(f.sequence).not.toContain("graceful");
      const actorIndex = f.sequence.indexOf("actor");
      const cleanupIndex = f.sequence.indexOf("discard");
      expect(f.sequence.slice(actorIndex + 1, cleanupIndex)).toContain(
        "evidence",
      );
      expect(evidence.passed).toBe(false);
      expect(evidence.scenarios[0].attempts).toHaveLength(1);
      expect(
        evidence.scenarios[0].result.scenarioEvidence.transportStop.final
          .isPlaying,
      ).toBe(true);
      expect(evidence.cleanup.map((event) => event.stage)).toEqual([
        "started",
        "completed",
      ]);
      for (const event of evidence.cleanup) {
        expect(() => telemetryEventEnvelopeSchema.parse(event)).not.toThrow();
        expect(event.attributes).toEqual({ pid: f.owned.pid, discard: true });
        expect(event.causationId).toBe(f.owned.runId);
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
      }
      expect(evidence.cleanup[0].trace).toEqual(evidence.cleanup[1].trace);
    },
  );

  it("only gracefully closes after independent actor verification succeeded", async () => {
    const evidence = await run("success");
    expect(evidence.passed).toBe(true);
    expect(f.sequence).toContain("graceful");
    expect(f.sequence).not.toContain("discard");
    expect(
      evidence.scenarios[0].result.scenarioEvidence.transportStop.final
        .isPlaying,
    ).toBe(false);
    expect(evidence.cleanup.at(-1).outcome).toBe("success");
  });

  it("retains cleanup failures without converting actor failure into success", async () => {
    f.cleanupError = true;
    const evidence = await run("refusal");
    expect(evidence.passed).toBe(false);
    expect(
      evidence.cleanup.every((event) =>
        ["started", "failed"].includes(event.stage),
      ),
    ).toBe(true);
    expect(evidence.cleanupError).toBe("owned cleanup failed");
    expect(
      evidence.scenarios[0].result.scenarioEvidence.transportStop.final
        .isPlaying,
    ).toBe(true);
  });

  it("still cleans only its owned process when the pre-cleanup checkpoint fails", async () => {
    f.failCheckpoint = true;
    const evidence = await run("refusal");
    expect(f.sequence).toContain("discard");
    expect(f.active).toBe(false);
    expect(evidence.passed).toBe(false);
    expect(evidence.error).toBe("checkpoint failed");
    expect(
      evidence.scenarios[0].result.scenarioEvidence.transportStop.final
        .isPlaying,
    ).toBe(true);
  });

  it("rejects approve-all before launch or any mutation", async () => {
    process.argv.push("--approve-all");
    const evidence = await run("success");
    expect(f.sequence).not.toContain("launch");
    expect(f.sequence).not.toContain("actor");
    expect(f.sequence).not.toContain("discard");
    expect(evidence.passed).toBe(false);
    expect(evidence.error).toContain("ordinary guarded approvals");
  });
});
