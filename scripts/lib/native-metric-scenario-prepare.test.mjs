import { randomUUID } from "node:crypto";
import { mkdir, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";
import { prepareNativeMetricLongFixture } from "./native-metric-scenario-prepare.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it.each(["completed", "failed", "cancelled"])(
  "journals offline preparation %s with timing, redaction, causation, cleanup, and no retries",
  async (outcome) => {
    const root = resolve(
      ".test-artifacts",
      `long-prepare-lifecycle-${randomUUID()}`,
    );
    roots.push(root);
    await mkdir(resolve(".test-artifacts"), { recursive: true });
    const events = [];
    const journal = {
      enqueue: (event) => events.push(event),
      flush: vi.fn(),
      close: vi.fn(),
    };
    const controller = new globalThis.AbortController();
    const execute = vi.fn(async () => {
      await mkdir(join(root, "fixture"));
      if (outcome === "cancelled") {
        controller.abort();
        const error = new Error("Cancelled: token=private-unit-secret");
        error.name = "AbortError";
        throw error;
      }
      if (outcome === "failed")
        throw new Error("Failure: token=private-unit-secret");
      return {
        stdout: JSON.stringify({
          inputPath: join(root, "fixture/input.json"),
          physicalQualification: false,
        }),
      };
    });
    const operation = prepareNativeMetricLongFixture({
      sourceInput: "never-read-input.json",
      candidateInput: "never-read-candidate.json",
      directory: root,
      execute,
      signal: controller.signal,
      services: {
        resolveLiveAgentStorage,
        sanitizeTelemetryAttributes,
        LocalObservabilityJournal: { open: async () => journal },
      },
    });
    if (outcome === "completed")
      await expect(operation).resolves.toMatchObject({
        physicalQualification: false,
      });
    else await expect(operation).rejects.toThrow();
    expect(execute).toHaveBeenCalledOnce();
    expect(events.slice(0, 4).map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      outcome,
    ]);
    for (const [index, event] of events.slice(0, 4).entries()) {
      expect(event.name).toBe(
        `integration.native_listening.long-metric-fixture-preparation.${event.stage}`,
      );
      expect(event.source).toBe("application");
      expect(event.trace.traceId).toBe(events[0].trace.traceId);
      expect(event.correlationId).toBe(events[0].correlationId);
      expect(event.causationId).toBe(
        index ? events[index - 1].id : events[0].causationId,
      );
      expect(event.durationMs).toBeGreaterThanOrEqual(
        index ? events[index - 1].durationMs : 0,
      );
    }
    expect(JSON.stringify(events)).not.toContain("private-unit-secret");
    if (outcome !== "completed") {
      await expect(access(join(root, "fixture"))).rejects.toThrow();
      expect(events.at(-1).stage).toBe("completed");
      expect(events.at(-1).name).toContain("preparation-cleanup");
    }
    expect(journal.flush).toHaveBeenCalledOnce();
    expect(journal.close).toHaveBeenCalledOnce();
  },
);
