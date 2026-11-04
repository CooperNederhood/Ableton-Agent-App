import type { TelemetryEventPage } from "@ableton-agent/observability";
import type { FlatnessSmokeOwner } from "./flatness-smoke.js";

export const flatnessOwner: FlatnessSmokeOwner = {
  traceId: "00000000-0000-4000-8000-000000000001",
  correlationId: "00000000-0000-4000-8000-000000000001",
  passId: "pass-0",
  listenerId: "listener-0",
  native: {
    generation: "00000000-0000-4000-8000-000000000000",
    connectionId: "00000000-0000-4000-9000-000000000000",
    connectionEpoch: "00000000-0000-4000-a000-000000000000",
    nativeEpoch: 1,
  },
};

/** Controlled snapshots, deliberately not numerical reference measurements. */
export function flatnessHistory(
  owner = flatnessOwner,
): TelemetryEventPage["items"] {
  const stages = [
    "completed",
    "queued",
    "started",
    "progress",
    "completed",
    "queued",
    "started",
    "completed",
  ];
  return stages.map((stage, index) => {
    const id = `00000000-0000-4000-b000-${String(index).padStart(12, "0")}`;
    const causationId = `00000000-0000-4000-b000-${String(Math.max(0, index - 1)).padStart(12, "0")}`;
    const values = {
      "flatness.schema": "flucoma-flatness-smoke/v1",
      "flatness.support": "unqualified",
      "flatness.valueValidity": "unqualified",
      "flatness.units": "dB",
      "flatness.channelPolicy": "independent-stereo",
      "flatness.windowSamples": 2048,
      "flatness.hopSamples": 2048,
      "flatness.power": 0,
      "flatness.leftDeliveries": index < 3 ? 0 : 2,
      "flatness.rightDeliveries": index < 3 ? 0 : 1,
      "flatness.cleanup":
        index < 5 ? "not-started" : index === 7 ? "completed" : "pending",
    };
    const facts = [
      ...Object.entries(values).map(([field, value]) => ({
        field,
        actual: { state: "observed", value },
      })),
      ...["left", "right"].map((channel) => ({
        field: `flatness.${channel}Db`,
        actual:
          index < 3
            ? { state: "unavailable", reason: "not-reported" }
            : { state: "observed", value: channel === "left" ? -12 : -17 },
      })),
      ...["left", "right"].map((channel) => ({
        field: `flatness.${channel}Class`,
        actual:
          index < 2
            ? { state: "unavailable", reason: "not-reported" }
            : { state: "observed", value: "fluid.spectralshape~" },
      })),
    ];
    return {
      version: 2,
      id,
      causationId,
      trace: { traceId: owner.traceId, spanId: id },
      correlationId: owner.correlationId,
      sequence: index + 1,
      occurredAt: "2026-11-03T00:00:00.000Z",
      recordedAt: "2026-11-03T00:00:00.000Z",
      name:
        index === 0
          ? "output.listener.native.completed"
          : `output.listener.native.metric.spectral-flatness.${stage}`,
      source: "output-ingress",
      level: "info",
      outcome: stage === "completed" ? "success" : "unknown",
      durationMs: index,
      attributes: {
        passId: owner.passId,
        listenerId: owner.listenerId,
        ...owner.native,
        lifecycle: {
          scope: "independent-metric-timelines/v1",
          ...(index === 0 ? {} : { metric: "spectral-flatness" }),
          eventId: id,
          causationId,
          generation: owner.native.generation,
          nativeEpoch: owner.native.nativeEpoch,
          frames: 0,
          elapsedMs: index,
          durationMs: index,
          stage,
          phase: index === 0 ? "launch" : index >= 5 ? "drain" : "capture",
          reason:
            index >= 5
              ? "flatness_smoke_cleanup"
              : index === 3
                ? "flatness_smoke_output"
                : "flatness_smoke_capture",
          ...(index === 0 ? {} : { facts }),
        },
      },
    };
  });
}

/** run-aLbLsJ ingress cadence and facts, with normalized owner/event identities. */
export function recordedFlatnessHistory(
  owner = flatnessOwner,
): TelemetryEventPage["items"] {
  const base = flatnessHistory(owner);
  const rows = [
    [1, 881, 3963, 0, 0, 0, null, null],
    [2, 929, 3976, 13, 0, 0, null, null],
    [3, 1047, 4166, 203, 1, 1, -48.90800684011333, -48.90800684011333],
    [3, 1227, 4765, 802, 7, 6, -35.83465271590485, -44.649045787887076],
    [3, 1407, 5265, 1306, 12, 11, -31.506108299973086, -44.62190631556908],
    [3, 1561, 5765, 1802, 17, 16, -10.986341377852414, -40.421481088112486],
    [4, 1674, 6155, 2192, 20, 20, -44.51386287070393, -44.51386287070393],
    [5, 1678, 6156, 0, 20, 20, -44.51386287070393, -44.51386287070393],
    [6, 1682, 6156, 0, 20, 20, -44.51386287070393, -44.51386287070393],
    [7, 1694, 6158, 3, 20, 20, -44.51386287070393, -44.51386287070393],
  ] as const;
  const launch = base[0]!;
  launch.sequence = 885;
  launch.durationMs = 3034;
  Object.assign(launch.attributes.lifecycle!, {
    elapsedMs: 3963,
    durationMs: 3034,
  });
  const events = rows.map(
    (
      [
        template,
        sequence,
        elapsedMs,
        durationMs,
        leftCount,
        rightCount,
        leftDb,
        rightDb,
      ],
      index,
    ) => {
      const event = structuredClone(base[template]!);
      const eventId = `00000000-0000-4000-b000-${String(index + 1).padStart(12, "0")}`;
      const causationId = `00000000-0000-4000-b000-${String(index).padStart(12, "0")}`;
      const lifecycle = event.attributes.lifecycle as Record<string, unknown>;
      const prior = lifecycle.facts as { field: string; actual: object }[];
      const replaced = new Set([
        "flatness.leftDeliveries",
        "flatness.rightDeliveries",
        "flatness.leftDb",
        "flatness.rightDb",
        "flatness.leftClass",
        "flatness.rightClass",
      ]);
      const facts = prior.filter((fact) => !replaced.has(fact.field));
      for (const [channel, count, db] of [
        ["left", leftCount, leftDb],
        ["right", rightCount, rightDb],
      ] as const) {
        facts.push(
          {
            field: `flatness.${channel}Deliveries`,
            actual: { state: "observed", value: count },
          },
          {
            field: `flatness.${channel}Db`,
            actual:
              db === null
                ? { state: "unavailable", reason: "not-reported" }
                : { state: "observed", value: db },
          },
          {
            field: `flatness.${channel}Class`,
            actual:
              index === 0
                ? { state: "unavailable", reason: "not-reported" }
                : { state: "observed", value: "fluid.spectralshape~" },
          },
        );
      }
      Object.assign(event, {
        id: eventId,
        causationId,
        sequence,
        durationMs,
        trace: { traceId: owner.traceId, spanId: eventId },
      });
      Object.assign(lifecycle, {
        eventId,
        causationId,
        elapsedMs,
        durationMs,
        facts,
      });
      return event;
    },
  );
  return [launch, ...events].sort((a, b) => a.sequence - b.sequence);
}
