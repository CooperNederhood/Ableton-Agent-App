import { describe, expect, it, vi } from "vitest";
import {
  captureCleanupConfirmed,
  restoreFlatnessSmoke,
  restoreSpreadSmoke,
} from "../../tests/electron/acceptance-evidence.js";
import { projectFlatnessSmoke } from "../../packages/test-support/src/integration/flatness-smoke.js";
import { projectSpreadSmoke } from "../../packages/test-support/src/integration/spread-smoke.js";
import { spreadHistory } from "../../packages/test-support/src/integration/spread-smoke-test-support.js";
import {
  flatnessHistory,
  flatnessOwner,
  recordedFlatnessHistory,
} from "../../packages/test-support/src/integration/flatness-smoke-test-support.js";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.js";

describe("flatness diagnostic typed History restoration seam", () => {
  it("projects the authentic fifteen-fact ingress shape with class witnesses and independent cleanup timing", () => {
    const history = recordedFlatnessHistory();
    for (const event of history)
      nativeMetricLifecycleSchema.parse(event.attributes.lifecycle);
    const projected = projectFlatnessSmoke(history, flatnessOwner);
    expect(projected.events).toHaveLength(10);
    expect(projected.events.at(-1)?.facts).toMatchObject({
      "flatness.leftClass": {
        state: "observed",
        value: "fluid.spectralshape~",
      },
      "flatness.rightClass": {
        state: "observed",
        value: "fluid.spectralshape~",
      },
      "flatness.leftDeliveries": { state: "observed", value: 20 },
      "flatness.rightDeliveries": { state: "observed", value: 20 },
      "flatness.cleanup": { state: "observed", value: "completed" },
    });
  });
  it.each(["failed", "cancelled"] as const)(
    "never admits authentic %s events with bounded rejected-value diagnostics",
    (stage) => {
      const history = recordedFlatnessHistory();
      const event = history.find((item) =>
        item.name.endsWith("spectral-flatness.progress"),
      )!;
      const lifecycle = nativeMetricLifecycleSchema.parse(
        event.attributes.lifecycle,
      );
      event.attributes.lifecycle = nativeMetricLifecycleSchema.parse({
        ...lifecycle,
        stage,
        reason:
          stage === "failed"
            ? "flatness_malformed_output"
            : "flatness_smoke_capture",
        facts: [
          ...lifecycle.facts!,
          ...["channel", "sequence", "db"].map((key) => ({
            field: `flatness.rejected.${key}`,
            actual: { state: "observed", value: "invalid" },
          })),
        ],
      });
      event.name = `output.listener.native.metric.spectral-flatness.${stage}`;
      event.outcome = stage === "failed" ? "failure" : "cancelled";
      expect(() => projectFlatnessSmoke(history, flatnessOwner)).toThrow();
    },
  );
  it.each(["missing", "wrong", "premature", "rejected-on-success"] as const)(
    "rejects %s class/diagnostic facts in the authentic ingress shape",
    (fault) => {
      const history = recordedFlatnessHistory();
      const event = history.find((item) =>
        item.name.endsWith(
          fault === "premature"
            ? "spectral-flatness.queued"
            : "spectral-flatness.started",
        ),
      )!;
      const lifecycle = nativeMetricLifecycleSchema.parse(
        event.attributes.lifecycle,
      );
      const facts = lifecycle.facts!.filter(
        (fact) => !(fault === "missing" && fact.field === "flatness.leftClass"),
      );
      if (fault === "wrong" || fault === "premature")
        facts.find((fact) => fact.field === "flatness.leftClass")!.actual = {
          state: "observed",
          value: fault === "wrong" ? "jbogus" : "fluid.spectralshape~",
        };
      if (fault === "rejected-on-success")
        facts.push({
          field: "flatness.rejected.db",
          actual: { state: "observed", value: "invalid" },
        });
      event.attributes.lifecycle = nativeMetricLifecycleSchema.parse({
        ...lifecycle,
        facts,
      });
      expect(() => projectFlatnessSmoke(history, flatnessOwner)).toThrow();
    },
  );
  it("admits every smoke fixture lifecycle through the canonical ingress schema", () => {
    for (const event of flatnessHistory().slice(1)) {
      const lifecycle = nativeMetricLifecycleSchema.parse(
        event.attributes.lifecycle,
      );
      expect(lifecycle.metric).toBe("spectral-flatness");
      expect(lifecycle.facts).toHaveLength(15);
      expect(lifecycle).toEqual(event.attributes.lifecycle);
    }
  });
  it("uses canonical unavailable facts without renaming the smoke failure code", () => {
    const lifecycle = nativeMetricLifecycleSchema.parse(
      flatnessHistory()[1]!.attributes.lifecycle,
    );
    expect(
      lifecycle.facts?.find((fact) => fact.field === "flatness.leftDb")?.actual,
    ).toEqual({ state: "unavailable", reason: "not-reported" });
    expect(
      nativeMetricLifecycleSchema.parse({
        ...lifecycle,
        stage: "failed",
        reason: "flatness_no_output",
      }).reason,
    ).toBe("flatness_no_output");
    expect(
      nativeMetricLifecycleSchema.safeParse({
        ...lifecycle,
        facts: [
          {
            field: "flatness.leftDb",
            actual: { state: "unavailable", reason: "no-output" },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("re-reads owned trace after restart and retains both actual diagnostic values", async () => {
    const original = projectFlatnessSmoke(flatnessHistory(), flatnessOwner);
    const read = vi.fn().mockResolvedValue(flatnessHistory());
    expect(await restoreFlatnessSmoke([original], true, read)).toEqual([
      { ...original, afterOwnedRestart: true },
    ]);
    expect(read).toHaveBeenCalledExactlyOnceWith(flatnessOwner.traceId);
  });
  it("does not let the original successful projection mask missing or corrupt persisted diagnostics", async () => {
    const original = projectFlatnessSmoke(flatnessHistory(), flatnessOwner);
    for (const history of [[], flatnessHistory().slice(0, -1)]) {
      await expect(
        restoreFlatnessSmoke([original], true, async () => history),
      ).rejects.toThrow();
    }
  });
  it("propagates typed History failure and cancellation without falling back to cached evidence", async () => {
    const original = projectFlatnessSmoke(flatnessHistory(), flatnessOwner);
    for (const failure of [
      new Error("History unavailable"),
      new DOMException("Aborted", "AbortError"),
    ])
      await expect(
        restoreFlatnessSmoke([original], true, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
  });
  it("leaves original scenarios without smoke diagnostics unchanged", async () => {
    const read = vi.fn();
    expect(await restoreFlatnessSmoke([], true, read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("spread diagnostic typed History restoration", () => {
  it("re-reads only persisted spread events rather than cached flatness or values", async () => {
    const original = projectSpreadSmoke(spreadHistory(), flatnessOwner);
    const read = vi.fn().mockResolvedValue(spreadHistory());
    expect(await restoreSpreadSmoke([original], true, read)).toEqual([
      { ...original, afterOwnedRestart: true },
    ]);
    expect(read).toHaveBeenCalledExactlyOnceWith(flatnessOwner.traceId);
    for (const history of [[], flatnessHistory(), spreadHistory().slice(0, -1)])
      await expect(
        restoreSpreadSmoke([original], true, async () => history),
      ).rejects.toThrow();
  });
  it("admits spread as a diagnostic only, never as supported FFT frames", () => {
    for (const event of spreadHistory().slice(1)) {
      const lifecycle = nativeMetricLifecycleSchema.parse(
        event.attributes.lifecycle,
      );
      expect(lifecycle.metric).toBe("spectral-spread");
      expect(lifecycle.frames).toBe(0);
      expect(lifecycle.facts).toHaveLength(18);
    }
  });
  it("propagates read failure/cancellation and does not read traces without captures", async () => {
    const original = projectSpreadSmoke(spreadHistory(), flatnessOwner);
    for (const failure of [
      new Error("History unavailable"),
      new DOMException("Aborted", "AbortError"),
    ])
      await expect(
        restoreSpreadSmoke([original], true, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    const read = vi.fn();
    expect(await restoreSpreadSmoke([], true, read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

const owner = {
  traceId: "trace",
  correlationId: "correlation",
  passId: "pass",
  listenerId: "listener",
  sessionId: "session",
  agentId: "agent",
  native: {
    generation: "generation",
    nativeEpoch: 1,
    connectionId: "connection",
    connectionEpoch: "connection-epoch",
  },
};
const base = {
  trace: { traceId: "trace", spanId: "span" },
  correlationId: "correlation",
  outcome: "success" as const,
  durationMs: 1,
};
const native = {
  ...base,
  name: "listening.metric-capture.completed",
  attributes: {
    passId: "pass",
    action: "cleanup",
    listeners: [{ listenerId: "listener", ...owner.native }],
  },
};
const source = {
  ...base,
  name: "listening.runtime.session-source-cleanup.completed",
  sessionId: "session",
  activeAgentId: "agent",
  attributes: { passId: "pass" },
};

describe("independent capture cleanup evidence", () => {
  it.each([
    "generation",
    "nativeEpoch",
    "connectionId",
    "connectionEpoch",
  ] as const)("rejects a cleanup receipt from a different native %s", (key) => {
    const observed = {
      ...native,
      attributes: {
        ...native.attributes,
        listeners: [
          {
            listenerId: "listener",
            ...owner.native,
            [key]: key === "nativeEpoch" ? 2 : "other",
          },
        ],
      },
    };
    expect(captureCleanupConfirmed([observed, source], owner)).toBe(false);
  });
  it("recognizes the successful sealed-capture release/finalization path, not release alone", () => {
    const release = {
      ...native,
      attributes: { ...native.attributes, action: "release" },
    };
    const finalization = {
      ...native,
      attributes: { ...native.attributes, action: "finalization" },
    };
    expect(
      captureCleanupConfirmed([release, finalization, source], owner),
    ).toBe(true);
    expect(captureCleanupConfirmed([release, source], owner)).toBe(false);
    expect(captureCleanupConfirmed([finalization, source], owner)).toBe(false);
    expect(captureCleanupConfirmed([release, finalization], owner)).toBe(false);
  });
  it("requires both native and source release for the exact owner", () => {
    expect(captureCleanupConfirmed([native, source], owner)).toBe(true);
    expect(captureCleanupConfirmed([source], owner)).toBe(false);
    expect(captureCleanupConfirmed([native], owner)).toBe(false);
    expect(captureCleanupConfirmed([], owner)).toBe(false);
  });
  it.each([
    "traceId",
    "correlationId",
    "passId",
    "listenerId",
    "sessionId",
    "agentId",
  ] as const)("rejects foreign %s", (key) => {
    expect(
      captureCleanupConfirmed([native, source], { ...owner, [key]: "foreign" }),
    ).toBe(false);
  });
  it("does not turn a later cleanup acknowledgement into a clean pass", () => {
    expect(() =>
      captureCleanupConfirmed(
        [
          {
            ...native,
            name: "listening.metric-capture.failed",
            outcome: "failure",
          },
          native,
          source,
        ],
        owner,
      ),
    ).toThrow("failed or cancelled");
  });
  it("requires bounded timing, not just completed prose or event names", () => {
    expect(
      captureCleanupConfirmed([{ ...native, durationMs: -1 }, source], owner),
    ).toBe(false);
  });
});
