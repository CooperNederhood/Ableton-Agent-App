import { describe, expect, it, vi } from "vitest";

import {
  LocalObservabilityJournal,
  createNonBlockingObservabilityRecorder,
  type ConfigurationSnapshot,
  type ObservabilitySink,
  type TelemetryEventEnvelope,
} from "./index.js";

const event: TelemetryEventEnvelope = {
  version: 2,
  id: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2026-08-29T22:00:00.000Z",
  name: "tool.completed",
  source: "agent.runtime",
  level: "info",
  attributes: {},
};

const snapshot: ConfigurationSnapshot = {
  version: 2,
  id: "00000000-0000-4000-8000-000000000002",
  capturedAt: "2026-08-29T22:00:00.000Z",
  component: "agent.runtime",
  configurationVersion: "1",
  values: {},
};

describe("non-blocking observability recorder", () => {
  it("injects a void producer API while forwarding records to the async sink", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const snapshots: ConfigurationSnapshot[] = [];
    const sink: ObservabilitySink = {
      enqueue: (value) => {
        events.push(value);
        return Promise.resolve();
      },
      enqueueConfigurationSnapshot: (value) => {
        snapshots.push(value);
        return Promise.resolve();
      },
    };
    const recorder = createNonBlockingObservabilityRecorder(sink);

    expect(recorder.enqueue(event)).toBeUndefined();
    expect(recorder.enqueueConfigurationSnapshot(snapshot)).toBeUndefined();
    expect(events).toEqual([]);
    expect(snapshots).toEqual([]);
    await vi.waitFor(() => {
      expect(events).toEqual([event]);
      expect(snapshots).toEqual([snapshot]);
    });
  });

  it("reports synchronous and asynchronous failures out-of-band", async () => {
    const failures: unknown[] = [];
    const sink: ObservabilitySink = {
      enqueue: () => {
        throw new Error("synchronous");
      },
      enqueueConfigurationSnapshot: () =>
        Promise.reject(new Error("asynchronous")),
    };
    const recorder = createNonBlockingObservabilityRecorder(sink, {
      onFailure: (failure) => {
        failures.push(failure);
      },
    });

    expect(() => recorder.enqueue(event)).not.toThrow();
    expect(() => recorder.enqueueConfigurationSnapshot(snapshot)).not.toThrow();
    expect(failures).toEqual([]);
    await vi.waitFor(() => {
      expect(failures).toHaveLength(2);
    });
    expect(failures).toEqual([
      expect.objectContaining({ operation: "event" }),
      expect.objectContaining({ operation: "configuration_snapshot" }),
    ]);
  });

  it("isolates failures thrown by the diagnostic callback", async () => {
    const sink: ObservabilitySink = {
      enqueue: () => Promise.reject(new Error("write failed")),
      enqueueConfigurationSnapshot: () => Promise.resolve(),
    };
    const recorder = createNonBlockingObservabilityRecorder(sink, {
      onFailure: () => {
        throw new Error("diagnostic failed");
      },
    });

    expect(() => recorder.enqueue(event)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("hands queued producer calls to the journal before graceful shutdown", async () => {
    const journal = await LocalObservabilityJournal.open({
      batchDelayMs: 5_000,
    });
    const recorder = createNonBlockingObservabilityRecorder(journal);

    recorder.enqueue(event);
    await journal.shutdown();

    expect((await journal.getHealth()).persistedEvents).toBe(1);
  });
});
