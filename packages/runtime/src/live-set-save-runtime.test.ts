import { describe, expect, it, vi } from "vitest";

import type { AbletonLiveSetSaveEvent } from "@ableton-agent/bridge";
import {
  telemetryEventEnvelopeSchema,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";

import {
  DefaultLiveSetSaveRuntime,
  type LiveSetSaveAction,
  type LiveSetSaveBridge,
  type LiveSetSaveRuntimeEvent,
} from "./live-set-save-runtime.js";

class FakeBridge implements LiveSetSaveBridge {
  listener: ((event: AbletonLiveSetSaveEvent) => void) | undefined;

  subscribeLiveSetSaves(
    listener: (event: AbletonLiveSetSaveEvent) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: AbletonLiveSetSaveEvent): void {
    this.listener?.(event);
  }
}

function saveEvent(
  liveSetId: string,
  modified = "100",
  sequence = 1,
): AbletonLiveSetSaveEvent {
  return {
    event: "live_set.save_observed",
    sequence,
    payload: {
      liveSetId,
      liveSetName: `Set ${liveSetId}`,
      saved: true,
      diagnostics: [],
      observedAt: "2026-09-20T20:00:00.000Z",
      fileModifiedTimeNs: modified,
      fileSizeBytes: 4096,
    },
    receivedAt: "2026-09-20T20:00:00.100Z",
    projectRevision: 7,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DefaultLiveSetSaveRuntime", () => {
  it("dispatches actions deterministically and deduplicates repeated metadata", async () => {
    const bridge = new FakeBridge();
    const calls: string[] = [];
    const events: LiveSetSaveRuntimeEvent[] = [];
    const action = (id: string): LiveSetSaveAction => ({
      id,
      async execute(context) {
        calls.push(id);
        context.reportProgress({ phase: id });
      },
    });
    const runtime = new DefaultLiveSetSaveRuntime({
      bridge,
      actions: [action("capture"), action("persist")],
    });
    runtime.subscribe((event) => events.push(event));
    runtime.start();

    bridge.emit(saveEvent("set-1"));
    bridge.emit(saveEvent("set-1"));
    await flush();
    await runtime.stop();

    expect(calls).toEqual(["capture", "persist"]);
    expect(events.map(({ type }) => type)).toEqual([
      "live_set.save_observation.queued",
      "live_set.save_observation.started",
      "live_set.save_action.queued",
      "live_set.save_action.started",
      "live_set.save_action.progress",
      "live_set.save_action.completed",
      "live_set.save_action.queued",
      "live_set.save_action.started",
      "live_set.save_action.progress",
      "live_set.save_action.completed",
      "live_set.save_observation.progress",
      "live_set.save_observation.completed",
    ]);
  });

  it("serializes saves for one Set and preserves observation order", async () => {
    const bridge = new FakeBridge();
    const releases: Array<() => void> = [];
    const calls: string[] = [];
    const runtime = new DefaultLiveSetSaveRuntime({
      bridge,
      actions: [
        {
          id: "capture",
          async execute({ observation }) {
            calls.push(`start:${observation.fileModifiedTimeNs}`);
            await new Promise<void>((resolve) => releases.push(resolve));
            calls.push(`end:${observation.fileModifiedTimeNs}`);
          },
        },
      ],
    });
    runtime.start();
    bridge.emit(saveEvent("set-1", "100", 1));
    bridge.emit(saveEvent("set-1", "200", 2));
    await flush();
    expect(calls).toEqual(["start:100"]);
    releases.shift()?.();
    await flush();
    expect(calls).toEqual(["start:100", "end:100", "start:200"]);
    releases.shift()?.();
    await runtime.stop();
    expect(calls).toEqual(["start:100", "end:100", "start:200", "end:200"]);
  });

  it("cancels the old Set on switch and emits bounded failure telemetry", async () => {
    const bridge = new FakeBridge();
    const events: LiveSetSaveRuntimeEvent[] = [];
    const telemetry: TelemetryEventEnvelope[] = [];
    const runtime = new DefaultLiveSetSaveRuntime({
      bridge,
      telemetry: {
        enqueue(event) {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
      actions: [
        {
          id: "capture",
          lifecycleName: "live_set.snapshot_capture",
          async execute({ observation, signal }) {
            if (observation.liveSetId === "set-2") {
              throw new Error("x".repeat(800));
            }
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        },
      ],
    });
    runtime.subscribe((event) => events.push(event));
    runtime.start();
    bridge.emit(saveEvent("set-1", "100", 1));
    await flush();
    bridge.emit(saveEvent("set-2", "200", 2));
    await flush();
    await runtime.stop();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "live_set.save_action.cancelled",
          liveSetId: "set-1",
        }),
        expect.objectContaining({
          type: "live_set.save_observation.cancelled",
          liveSetId: "set-1",
        }),
        expect.objectContaining({
          type: "live_set.save_action.failed",
          liveSetId: "set-2",
          attributes: { error: "x".repeat(512) },
        }),
      ]),
    );
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "live_set.snapshot_capture.cancelled",
          outcome: "cancelled",
        }),
        expect.objectContaining({
          name: "live_set.snapshot_capture.failed",
          outcome: "failure",
        }),
      ]),
    );
  });

  it("unsubscribes and aborts active work on stop", async () => {
    const bridge = new FakeBridge();
    const aborted = vi.fn();
    const runtime = new DefaultLiveSetSaveRuntime({
      bridge,
      actions: [
        {
          id: "capture",
          async execute({ signal }) {
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  aborted();
                  resolve();
                },
                { once: true },
              ),
            );
          },
        },
      ],
    });
    runtime.start();
    bridge.emit(saveEvent("set-1"));
    await flush();
    await runtime.stop();
    expect(aborted).toHaveBeenCalledOnce();
    expect(bridge.listener).toBeUndefined();
  });
});
