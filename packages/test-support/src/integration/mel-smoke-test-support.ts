import { createHash } from "node:crypto";
import {
  MEL_BAND_PROFILE,
  createMetricObservationReportRows,
  melBandTimelineSchema,
  metricAudioObservationSchema,
  projectMetricListeningReport,
  type MetricAudioObservation,
} from "@ableton-agent/protocol";
import type { TelemetryEventPage } from "@ableton-agent/observability";
import { agentListeningFixture } from "./agent-listening-test-support.js";
import { projectMelSmoke } from "./mel-smoke.js";
import {
  NATIVE_MEL_BUNDLE,
  NATIVE_MEL_PRODUCER,
} from "@ableton-agent/shared/m4l-devices";
import type { Facts } from "./contracts.js";

/** Controlled mapping fixture, never evidence of a loaded host process. */
export function melBinaryFacts(
  phase: "baseline" | "capture-completed",
  owner?: MetricAudioObservation["ownership"],
): Facts {
  return {
    melLoadedBinaryVerified: true,
    melLoadedBinarySchema: "owned-mapped-listener-mel/v1",
    melLoadedBinaryPath: `/owned/frozen/${NATIVE_MEL_BUNDLE}/Contents/MacOS/listener.mel~`,
    melLoadedBinarySha256: NATIVE_MEL_PRODUCER.binarySha256,
    melLoadedBinaryPids: "98766",
    melLoadedBinaryInode: "123",
    melLoadedBinaryDevice: "456",
    melLoadedBinaryPhase: phase,
    melLoadedBinaryState: "completed",
    melLoadedBinaryDurationMs: 1,
    ...(owner
      ? Object.fromEntries(
          Object.entries(owner).map(([key, value]) => [
            `melLoadedBinary${key[0]!.toUpperCase()}${key.slice(1)}`,
            value,
          ]),
        )
      : {}),
  };
}

/** Synthetic native lifecycle, explicitly not a physical acquisition receipt. */
export function melSmokeHistory(
  observation: MetricAudioObservation,
): TelemetryEventPage["items"] {
  const owner = observation.ownership;
  const mel = observation.metrics["mel-bands"]!;
  const phases = [
    "configuration",
    "configuration",
    "configuration",
    "capture",
    "capture",
    "capture",
    "drain",
    "drain",
    "drain",
  ];
  const stages = [
    "queued",
    "started",
    "completed",
    "started",
    "progress",
    "completed",
    "queued",
    "started",
    "completed",
  ];
  const reasons = [
    "prepare",
    "prepare",
    "ready",
    "capture",
    "frames",
    "capture_complete",
    "cleanup",
    "cleanup",
    "cleanup_complete",
  ];
  const eventId = (index: number) =>
    `00000000-0000-4000-c000-${String(index).padStart(12, "0")}`;
  const events = stages.map((stage, index) => {
    const id = eventId(index);
    const cause = index === 0 ? owner.causationId : eventId(index - 1);
    const count = index < 4 ? 0 : mel.frames.length;
    const values = {
      "mel.abi": index < 2 ? 0 : NATIVE_MEL_PRODUCER.abi,
      "mel.sampleRate": mel.sampleRate,
      "mel.bandCount": 24,
      "mel.expectedFrames": mel.expectedRecords,
      "mel.validFrames": count,
      "mel.receivedFrames": count,
      ...(index < 2 ? {} : { "mel.dspGeneration": 7 }),
      ...(index < 3
        ? {}
        : {
            "mel.startSample": mel.sourceSupport.startSample,
            "mel.endSample": mel.sourceSupport.endSample,
          }),
      ...(index < 5
        ? {}
        : {
            "mel.terminalReason": 10,
            "mel.lostFrames": 0,
            "mel.trailingSamples": 1936,
          }),
      ...(index < 8
        ? {}
        : {
            "mel.terminalConsumed": 1,
            "mel.recordsDrained": count + 3,
            "mel.framesDrained": count,
            "mel.sourceClockExclusive": mel.sourceSupport.endSample + 64,
          }),
    };
    return {
      version: 2,
      id,
      causationId: cause,
      trace: { traceId: owner.traceId, spanId: id },
      correlationId: owner.correlationId,
      sequence: (index + 1) * 10,
      occurredAt: "2026-11-05T00:00:00.000Z",
      recordedAt: "2026-11-05T00:00:00.000Z",
      name: `output.listener.native.metric.mel-bands.${stage}`,
      source: "output-ingress",
      level: "info",
      outcome: stage === "completed" ? "success" : "unknown",
      durationMs: index,
      attributes: {
        passId: owner.passId,
        listenerId: owner.listenerId,
        generation: owner.generation,
        nativeEpoch: owner.nativeEpoch,
        connectionId: owner.connectionId,
        connectionEpoch: owner.connectionEpoch,
        lifecycle: {
          scope: "independent-metric-timelines/v1",
          metric: "mel-bands",
          eventId: id,
          causationId: cause,
          generation: owner.generation,
          nativeEpoch: owner.nativeEpoch,
          stage,
          phase: phases[index]!,
          frames: count,
          elapsedMs: index,
          durationMs: index,
          reason: `mel_native_${reasons[index]!}`,
          facts: Object.entries(values).map(([field, value]) => ({
            field,
            actual: { state: "observed", value },
          })),
        },
      },
    } satisfies TelemetryEventPage["items"][number];
  });
  const diagnostic = (
    kind: "stopped" | "drain",
    values: Record<string, number>,
  ) => {
    const event = structuredClone(events[5]!);
    const id = eventId(kind === "stopped" ? 90 : 91);
    event.id = id;
    event.trace.spanId = id;
    event.sequence += kind === "stopped" ? -1 : 1;
    event.name = "output.listener.native.metric.mel-bands.progress";
    event.outcome = "unknown";
    return {
      ...event,
      durationMs: undefined,
      attributes: {
        ...event.attributes,
        lifecycle: {
          ...event.attributes.lifecycle,
          durationMs: undefined,
          eventId: id,
          stage: "progress",
          phase: "drain",
          reason: `mel_native_${kind}_receipt`,
          facts: Object.entries(values).map(([field, value]) => ({
            field: `mel.${kind}.${field}`,
            actual: { state: "observed", value },
          })),
        },
      },
    };
  };
  return [
    ...events.slice(0, 5),
    diagnostic("stopped", {
      producerAbi: NATIVE_MEL_PRODUCER.abi,
      epoch: owner.nativeEpoch,
      generation: 7,
      sequence: mel.expectedRecords,
      startSample: mel.sourceSupport.startSample + mel.expectedRecords * 2048,
      endSample: mel.sourceSupport.endSample,
      lostFrames: 0,
      trailingSamples: 1936,
      reason: 10,
      sampleRate: mel.sampleRate,
      bandCount: 24,
    }),
    events[5]!,
    diagnostic("drain", {
      producerAbi: NATIVE_MEL_PRODUCER.abi,
      token: 251,
      epoch: owner.nativeEpoch,
      generation: 7,
      recordsDrained: mel.frames.length + 3,
      framesDrained: mel.frames.length,
      terminalConsumed: 1,
      clockValid: 1,
      sourceClockExclusive: mel.sourceSupport.endSample + 64,
    }),
    ...events.slice(6),
  ];
}

/** Synthetic contract vectors, never an acoustic oracle or native DSP proof. */
export function melSmokeFixture(action: "get" | "report" = "get") {
  const fixture = agentListeningFixture("get");
  const raw = structuredClone(fixture.context.observation!);
  raw.metrics["mel-bands"] = melBandTimelineSchema.parse({
    schema: "mel-band-timeline/v1",
    status: "complete",
    sampleRate: 48_000,
    profile: MEL_BAND_PROFILE,
    sourceSupport: raw.sourceCoverage,
    expectedRecords: 43,
    frames: Array.from({ length: 43 }, (_, index) => ({
      index,
      support: { startSample: index * 2048, endSample: (index + 1) * 2048 },
      magnitudes: [
        Array.from({ length: 24 }, (_, band) => (index + band + 1) / 101),
        Array.from({ length: 24 }, (_, band) => (index + band + 2) / 203),
      ],
    })),
    gaps: [],
  });
  raw.requestedMetrics.push("mel-bands");
  raw.rows = createMetricObservationReportRows(raw);
  const observation = metricAudioObservationSchema.parse(raw);
  const history = melSmokeHistory(observation);
  const smoke = projectMelSmoke(observation, fixture.contextId, true, history);
  Object.assign(fixture.input.baseline.facts, melBinaryFacts("baseline"));
  Object.assign(
    fixture.turn.facts,
    melBinaryFacts("capture-completed", observation.ownership),
  );
  const context = {
    action,
    entry: fixture.context.entry,
    ...(action === "get"
      ? { observation }
      : { report: projectMetricListeningReport(observation) }),
  };
  const result = fixture.records.find(
    (entry) => entry.id === "result-context",
  )!;
  Object.assign(result, { result: { result: { content: context } } });
  const call = fixture.records.find((entry) => entry.id === "call-context")!;
  Object.assign(call, { arguments: { action, contextId: fixture.contextId } });
  Object.assign(fixture.turn, { melSmoke: [smoke] });
  Object.assign(fixture.turn.captures[0]!, {
    metricFamilies: observation.requestedMetrics,
    native: {
      generation: observation.ownership.generation,
      nativeEpoch: observation.ownership.nativeEpoch,
      connectionId: observation.ownership.connectionId,
      connectionEpoch: observation.ownership.connectionEpoch,
    },
  });
  Object.assign(fixture.turn.contexts[0]!, {
    contentSha256: createHash("sha256")
      .update(JSON.stringify(observation))
      .digest("hex"),
  });
  return { ...fixture, context, smoke, observation, history };
}
