import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { TelemetryEventPage } from "@ableton-agent/observability";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.js";
import { projectFlatnessSmoke } from "../../packages/test-support/src/integration/flatness-smoke.js";
import { projectSpreadSmoke } from "../../packages/test-support/src/integration/spread-smoke.js";
import {
  flatnessHistory,
  flatnessOwner,
} from "../../packages/test-support/src/integration/flatness-smoke-test-support.js";
import { restoreSpreadSmoke } from "../../tests/electron/acceptance-evidence.js";

type Control = { generation: string };
const { createSpectralShapeSmoke } = createRequire(import.meta.url)(
  "../../max-patches/audio-listener/audio_listener_flatness_probe.js",
) as {
  createSpectralShapeSmoke(
    this: void,
    options: {
      now(): number;
      sendControl(...atoms: (string | number)[]): void;
      emit(control: Control, lifecycle: unknown): boolean;
    },
  ): {
    start(control: Control, epoch: number, cause: string): void;
    receive(packet: (string | number)[]): void;
    stop(control: Control, cancelled?: boolean): boolean;
  };
};

function capture(spread = 1200, cancelled = false) {
  let now = 0;
  const control = { generation: flatnessOwner.native.generation };
  const history: TelemetryEventPage["items"] = [flatnessHistory()[0]!];
  const commands: (string | number)[][] = [];
  const probe = createSpectralShapeSmoke({
    now: () => now,
    sendControl: (...atoms) => commands.push(atoms),
    emit: (owner, raw) => {
      expect(owner).toBe(control);
      const lifecycle = nativeMetricLifecycleSchema.parse(raw);
      const id = lifecycle.eventId;
      history.push({
        version: 2,
        id,
        causationId: lifecycle.causationId,
        trace: { traceId: flatnessOwner.traceId, spanId: id },
        correlationId: flatnessOwner.correlationId,
        sequence: history.length + 1,
        occurredAt: "2026-11-04T00:00:00.000Z",
        recordedAt: "2026-11-04T00:00:00.000Z",
        name: `output.listener.native.metric.${lifecycle.metric}.${lifecycle.stage}`,
        source: "output-ingress",
        level: "info",
        outcome:
          lifecycle.stage === "completed"
            ? "success"
            : lifecycle.stage === "failed"
              ? "failure"
              : lifecycle.stage === "cancelled"
                ? "cancelled"
                : "unknown",
        durationMs: lifecycle.durationMs,
        attributes: {
          passId: flatnessOwner.passId,
          listenerId: flatnessOwner.listenerId,
          ...flatnessOwner.native,
          lifecycle,
        },
      });
      return true;
    },
  });
  const receive = (...atoms: (string | number)[]) =>
    probe.receive([control.generation, 1, ...atoms]);
  probe.start(control, 1, history[0]!.id);
  receive("started", "fluid.spectralshape~", "fluid.spectralshape~");
  now = 150;
  if (!cancelled) {
    receive("value", 0, 1, spread, -12);
    receive("value", 1, 1, 1700, -17);
  }
  expect(probe.stop(control, cancelled)).toBe(false);
  now = 180;
  receive("stopped");
  expect(probe.stop(control, cancelled)).toBe(true);
  expect(commands).toEqual([
    ["begin", control.generation, 1],
    ["stop", control.generation, 1],
  ]);
  return history;
}

describe("production SpectralShape probe to acceptance History boundary", () => {
  it("projects actual producer fields through strict ingress and restart reads", async () => {
    const history = capture();
    const spread = projectSpreadSmoke(history, flatnessOwner);
    const flatness = projectFlatnessSmoke(history, flatnessOwner);
    expect(Object.keys(spread.events.at(-1)!.facts)).toHaveLength(18);
    expect(Object.keys(flatness.events.at(-1)!.facts)).toHaveLength(15);
    expect(spread.events.at(-1)!.facts).toMatchObject({
      "spread.leftHz": { state: "observed", value: 1200 },
      "spread.rightHz": { state: "observed", value: 1700 },
      "spread.unit": { state: "observed", value: 0 },
      "spread.minfreq": { state: "observed", value: 0 },
      "spread.maxfreq": { state: "observed", value: -1 },
    });
    expect(flatness.events.at(-1)!.facts).toMatchObject({
      "flatness.leftDb": { state: "observed", value: -12 },
      "flatness.rightDb": { state: "observed", value: -17 },
    });
    expect(
      await restoreSpreadSmoke([spread], true, async () =>
        structuredClone(history),
      ),
    ).toEqual([{ ...spread, afterOwnedRestart: true }]);
  });
  it("rejects real local spread failure without losing healthy flatness evidence", () => {
    const history = capture(-1);
    expect(() => projectSpreadSmoke(history, flatnessOwner)).toThrow();
    expect(() => projectFlatnessSmoke(history, flatnessOwner)).not.toThrow();
  });
  it("requires spread diagnostics even when healthy flatness survives", () => {
    const history = capture().filter(
      (event) => !event.name.includes("spectral-spread"),
    );
    expect(() => projectFlatnessSmoke(history, flatnessOwner)).not.toThrow();
    expect(() => projectSpreadSmoke(history, flatnessOwner)).toThrow();
  });
  it("does not turn cancelled production capture with confirmed cleanup into smoke success", () => {
    const history = capture(1200, true);
    expect(() => projectSpreadSmoke(history, flatnessOwner)).toThrow();
    expect(() => projectFlatnessSmoke(history, flatnessOwner)).toThrow();
  });
});
