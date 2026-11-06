import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { TelemetryEventPage } from "@ableton-agent/observability";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.js";
import { projectPitchSmoke } from "../../packages/test-support/src/integration/pitch-smoke.js";
import { projectFlatnessSmoke } from "../../packages/test-support/src/integration/flatness-smoke.js";
import {
  flatnessHistory,
  flatnessOwner,
} from "../../packages/test-support/src/integration/flatness-smoke-test-support.js";
import { restorePitchSmoke } from "../../tests/electron/acceptance-evidence.js";

type Control = { generation: string };
const { createPitchSmoke } = createRequire(import.meta.url)(
  "../../max-patches/audio-listener/audio_listener_pitch_probe.js",
) as {
  createPitchSmoke(
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

function capture(mode = "normal", invalid = NaN) {
  let now = 0;
  const control = { generation: flatnessOwner.native.generation };
  const history: TelemetryEventPage["items"] = [flatnessHistory()[0]!];
  const commands: (string | number)[][] = [];
  const probe = createPitchSmoke({
    now: () => now,
    sendControl: (...atoms) => commands.push(atoms),
    emit: (owner, raw) => {
      expect(owner).toBe(control);
      const lifecycle = nativeMetricLifecycleSchema.parse(raw);
      expect(lifecycle.metric).toBe("monophonic-pitch");
      expect(lifecycle.frames).toBe(0);
      expect(lifecycle.facts).toHaveLength(24);
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(8192);
      const id = lifecycle.eventId;
      history.push({
        version: 2,
        id,
        causationId: lifecycle.causationId,
        trace: { traceId: flatnessOwner.traceId, spanId: id },
        correlationId: flatnessOwner.correlationId,
        sequence: history.length + 1,
        occurredAt: "2026-11-05T00:00:00.000Z",
        recordedAt: "2026-11-05T00:00:00.000Z",
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
  receive("started", "fluid.pitch~", "fluid.pitch~");
  now = 150;
  if (mode !== "cancelled" && mode !== "missing") {
    receive(
      "value",
      0,
      1,
      mode === "invalid-hz" ? invalid : mode === "all-sentinel" ? 0 : 110,
      mode === "invalid-confidence" ? invalid : 0.6,
    );
    receive("value", 1, 1, mode === "all-sentinel" ? 0 : 220, 0.3);
    if (mode === "final-sentinel") {
      now = 750;
      receive("value", 0, 2, 0, 0);
    }
  }
  expect(probe.stop(control, mode === "cancelled")).toBe(false);
  now += 30;
  receive("stopped");
  expect(probe.stop(control, mode === "cancelled")).toBe(true);
  expect(commands).toEqual([
    ["begin", control.generation, 1],
    ["stop", control.generation, 1],
  ]);
  return history;
}

describe("production paired pitch probe to acceptance History boundary", () => {
  it("projects actual producer fields through strict ingress and fresh restart reads", async () => {
    const history = capture();
    const pitch = projectPitchSmoke(history, flatnessOwner);
    expect(pitch.events.at(-1)!.facts).toMatchObject({
      "pitch.leftHz": { state: "observed", value: 110 },
      "pitch.rightHz": { state: "observed", value: 220 },
      "pitch.leftConfidence": { state: "observed", value: 0.6 },
      "pitch.rightConfidence": { state: "observed", value: 0.3 },
      "pitch.leftCandidates": { state: "observed", value: 1 },
      "pitch.rightCandidates": { state: "observed", value: 1 },
      "pitch.cleanup": { state: "observed", value: "completed" },
    });
    expect(
      await restorePitchSmoke([pitch], true, async () =>
        structuredClone(history),
      ),
    ).toEqual([{ ...pitch, afterOwnedRestart: true }]);
  });
  it("accepts a final delivered sentinel after an earlier positive candidate", () => {
    const pitch = projectPitchSmoke(capture("final-sentinel"), flatnessOwner);
    expect(pitch.events.at(-1)!.facts).toMatchObject({
      "pitch.leftHz": { state: "observed", value: 0 },
      "pitch.leftConfidence": { state: "observed", value: 0 },
      "pitch.leftDeliveries": { state: "observed", value: 2 },
      "pitch.leftCandidates": { state: "observed", value: 1 },
    });
  });
  it.each(["missing", "all-sentinel", "cancelled"])(
    "rejects production %s output despite healthy siblings and cleanup",
    (mode) => {
      const history = [...capture(mode), ...flatnessHistory().slice(1)];
      expect(() => projectFlatnessSmoke(history, flatnessOwner)).not.toThrow();
      expect(() => projectPitchSmoke(history, flatnessOwner)).toThrow();
    },
  );
  it.each([
    ["invalid-hz", -1],
    ["invalid-hz", 49.9],
    ["invalid-hz", 2000.1],
    ["invalid-hz", NaN],
    ["invalid-hz", Infinity],
    ["invalid-confidence", -0.01],
    ["invalid-confidence", 1.01],
    ["invalid-confidence", NaN],
    ["invalid-confidence", Infinity],
  ] as const)(
    "rejects production %s %s without masking the local failure",
    (mode, value) => {
      const history = [...capture(mode, value), ...flatnessHistory().slice(1)];
      expect(() => projectFlatnessSmoke(history, flatnessOwner)).not.toThrow();
      expect(() => projectPitchSmoke(history, flatnessOwner)).toThrow();
    },
  );
});
