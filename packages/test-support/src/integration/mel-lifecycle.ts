import type { TelemetryEventPage } from "@ableton-agent/observability";
import type { MetricAudioObservation } from "@ableton-agent/protocol";
import { NATIVE_MEL_PRODUCER } from "@ableton-agent/shared/m4l-devices";

type HistoryEvent = TelemetryEventPage["items"][number];
export type MelHistoryEvent = Pick<HistoryEvent, "name" | "attributes"> &
  Partial<HistoryEvent>;
export interface MelLifecycleReceipt {
  readonly eventId: string;
  readonly causationId: string;
  readonly sequence: number;
  readonly traceId: string;
  readonly correlationId: string;
  readonly passId: string;
  readonly listenerId: string;
  readonly generation: string;
  readonly nativeEpoch: number;
  readonly connectionId: string;
  readonly connectionEpoch: string;
  readonly stage: string;
  readonly phase: string;
  readonly reason: string;
  readonly frames: number;
  readonly elapsedMs: number;
  readonly durationMs: number;
  readonly facts: Readonly<Record<string, number>>;
}
const ownerKeys = [
  "traceId",
  "correlationId",
  "passId",
  "listenerId",
  "generation",
  "nativeEpoch",
  "connectionId",
  "connectionEpoch",
] as const;
const prefix = "output.listener.native.metric.mel-bands.";
const fields = [
  "abi",
  "sampleRate",
  "bandCount",
  "expectedFrames",
  "validFrames",
  "receivedFrames",
  "dspGeneration",
  "startSample",
  "endSample",
  "terminalReason",
  "lostFrames",
  "trailingSamples",
  "terminalConsumed",
  "recordsDrained",
  "framesDrained",
  "sourceClockExclusive",
].map((key) => `mel.${key}`);
const diagnosticFields = {
  stopped: [
    "producerAbi",
    "epoch",
    "generation",
    "sequence",
    "startSample",
    "endSample",
    "lostFrames",
    "trailingSamples",
    "reason",
    "sampleRate",
    "bandCount",
  ],
  drain: [
    "producerAbi",
    "token",
    "epoch",
    "generation",
    "recordsDrained",
    "framesDrained",
    "terminalConsumed",
    "clockValid",
    "sourceClockExclusive",
  ],
} as const;
function check(value: unknown): asserts value {
  if (!value)
    throw new Error("Missing or invalid owned mel physical-drain receipt");
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= min
  );
}

/** Project actual typed native events, never infer cleanup from a complete timeline. */
export function projectMelLifecycle(
  history: readonly MelHistoryEvent[],
  observation: MetricAudioObservation,
): readonly MelLifecycleReceipt[] {
  const owner = observation.ownership;
  const events = history.filter(
    (event) =>
      event.name.startsWith(prefix) &&
      event.trace?.traceId === owner.traceId &&
      event.attributes.passId === owner.passId,
  );
  check(events.length > 0 && events.length <= 1024);
  const diagnostics = new Map<
    string,
    { facts: Record<string, number>; sequence: number }
  >();
  const receipts = events.flatMap((event) => {
    const lifecycle = object(event.attributes.lifecycle);
    check(
      event.source === "output-ingress" &&
        event.correlationId === owner.correlationId &&
        event.trace?.spanId === event.id &&
        lifecycle.eventId === event.id &&
        lifecycle.causationId === event.causationId &&
        lifecycle.scope === "independent-metric-timelines/v1" &&
        lifecycle.metric === "mel-bands" &&
        lifecycle.generation === owner.generation &&
        lifecycle.nativeEpoch === owner.nativeEpoch &&
        event.name === `${prefix}${String(lifecycle.stage)}` &&
        event.durationMs === lifecycle.durationMs &&
        event.outcome ===
          (lifecycle.stage === "completed" ? "success" : "unknown"),
    );
    for (const key of ownerKeys)
      if (key !== "traceId" && key !== "correlationId")
        check(event.attributes[key] === owner[key]);
    check(Array.isArray(lifecycle.facts) && lifecycle.facts.length <= 16);
    const kind =
      lifecycle.reason === "mel_native_stopped_receipt"
        ? "stopped"
        : lifecycle.reason === "mel_native_drain_receipt"
          ? "drain"
          : undefined;
    const allowed = kind
      ? diagnosticFields[kind].map((key) => `mel.${kind}.${key}`)
      : fields;
    const facts: Record<string, number> = {};
    for (const raw of lifecycle.facts) {
      const fact = object(raw);
      const actual = object(fact.actual);
      check(
        Object.keys(fact).length === 2 &&
          typeof fact.field === "string" &&
          allowed.includes(fact.field) &&
          !Object.hasOwn(facts, fact.field) &&
          Object.keys(actual).length === 2 &&
          actual.state === "observed" &&
          integer(actual.value),
      );
      facts[fact.field] = actual.value;
    }
    if (kind) {
      check(
        !diagnostics.has(kind) &&
          lifecycle.stage === "progress" &&
          lifecycle.phase === "drain" &&
          lifecycle.frames ===
            observation.metrics["mel-bands"]?.frames.length &&
          lifecycle.durationMs === undefined &&
          integer(event.sequence, 1) &&
          Object.keys(facts).length === allowed.length &&
          allowed.every((key) => Object.hasOwn(facts, key)),
      );
      diagnostics.set(kind, { facts, sequence: event.sequence });
      return [];
    }
    return [
      {
        ...Object.fromEntries(ownerKeys.map((key) => [key, owner[key]])),
        eventId: event.id,
        causationId: event.causationId,
        sequence: event.sequence,
        stage: lifecycle.stage,
        phase: lifecycle.phase,
        reason: lifecycle.reason,
        frames: lifecycle.frames,
        elapsedMs: lifecycle.elapsedMs,
        durationMs: lifecycle.durationMs,
        facts,
      } as MelLifecycleReceipt,
    ];
  });
  validateMelLifecycle(receipts, observation);
  const terminal = receipts.at(-1)!;
  const mel = observation.metrics["mel-bands"]!;
  for (const kind of ["stopped", "drain"] as const) {
    const diagnostic = diagnostics.get(kind);
    check(diagnostic);
    const expected = {
      producerAbi: NATIVE_MEL_PRODUCER.abi,
      epoch: owner.nativeEpoch,
      generation: terminal.facts["mel.dspGeneration"],
      ...(kind === "stopped"
        ? {
            sequence: mel.expectedRecords,
            startSample:
              mel.sourceSupport.startSample + mel.expectedRecords * 2048,
            endSample: mel.sourceSupport.endSample,
            lostFrames: 0,
            trailingSamples: terminal.facts["mel.trailingSamples"],
            reason: 10,
            sampleRate: mel.sampleRate,
            bandCount: 24,
          }
        : {
            recordsDrained: terminal.facts["mel.recordsDrained"],
            framesDrained: terminal.facts["mel.framesDrained"],
            terminalConsumed: 1,
            clockValid: 1,
            sourceClockExclusive: terminal.facts["mel.sourceClockExclusive"],
          }),
    };
    for (const [key, value] of Object.entries(expected))
      check(diagnostic.facts[`mel.${kind}.${key}`] === value);
    check(diagnostic.sequence < terminal.sequence);
    if (kind === "drain")
      check(
        diagnostic.sequence > diagnostics.get("stopped")!.sequence &&
          integer(diagnostic.facts["mel.drain.token"], 1) &&
          diagnostic.facts["mel.drain.token"] <= 12000,
      );
  }
  return receipts;
}

export function validateMelLifecycle(
  value: unknown,
  observation: MetricAudioObservation,
): asserts value is readonly MelLifecycleReceipt[] {
  check(Array.isArray(value) && value.length > 0 && value.length <= 1024);
  const mel = observation.metrics["mel-bands"];
  check(mel);
  const expected = {
    "mel.sampleRate": mel.sampleRate,
    "mel.bandCount": 24,
    "mel.expectedFrames": mel.expectedRecords,
    "mel.startSample": mel.sourceSupport.startSample,
    "mel.endSample": mel.sourceSupport.endSample,
    "mel.terminalReason": 10,
    "mel.lostFrames": 0,
    "mel.trailingSamples":
      (mel.sourceSupport.endSample - mel.sourceSupport.startSample) % 2048,
    "mel.terminalConsumed": 1,
    "mel.recordsDrained": mel.frames.length + 3,
    "mel.framesDrained": mel.frames.length,
  };
  let generation: number | undefined;
  let previousSequence = 0,
    previousElapsed = 0,
    previousFrames = 0,
    previousReceived = 0;
  const ids = new Set<string>();
  let terminal = 0;
  let ready = false;
  for (const [index, raw] of value.entries()) {
    const event = object(raw);
    check(
      Object.keys(event).length === 18 &&
        ownerKeys.every((key) => event[key] === observation.ownership[key]) &&
        typeof event.eventId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(event.eventId) &&
        typeof event.causationId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(event.causationId) &&
        event.causationId !== event.eventId &&
        !ids.has(event.eventId) &&
        integer(event.sequence, previousSequence + 1) &&
        typeof event.elapsedMs === "number" &&
        Number.isFinite(event.elapsedMs) &&
        event.elapsedMs >= previousElapsed &&
        event.elapsedMs <= 120_000 &&
        typeof event.durationMs === "number" &&
        Number.isFinite(event.durationMs) &&
        event.durationMs >= 0 &&
        event.durationMs <= 120_000 &&
        ["queued", "started", "progress", "completed"].includes(
          String(event.stage),
        ) &&
        ["configuration", "capture", "drain"].includes(String(event.phase)) &&
        typeof event.reason === "string" &&
        /^mel_native_[a-z_]{1,100}$/u.test(event.reason),
    );
    const facts = object(event.facts);
    check(
      Object.keys(facts).length >= 6 &&
        Object.keys(facts).length <= 16 &&
        Object.entries(facts).every(
          ([key, n]) => fields.includes(key) && integer(n),
        ),
    );
    for (const key of fields.slice(0, 6)) check(Object.hasOwn(facts, key));
    if (
      event.reason === "mel_native_prepare" ||
      event.reason === "mel_native_arm_pending"
    ) {
      check(
        !ready &&
          event.phase === "configuration" &&
          (event.reason === "mel_native_prepare"
            ? ["queued", "started"].includes(String(event.stage))
            : event.stage === "progress") &&
          facts["mel.abi"] === 0 &&
          facts["mel.validFrames"] === 0 &&
          facts["mel.receivedFrames"] === 0 &&
          Object.keys(facts).length === 6,
      );
    } else {
      check(facts["mel.abi"] === NATIVE_MEL_PRODUCER.abi);
      if (event.reason === "mel_native_ready") {
        check(
          !ready &&
            event.phase === "configuration" &&
            event.stage === "completed" &&
            integer(facts["mel.dspGeneration"], 1),
        );
        ready = true;
      } else check(ready);
    }
    for (const [key, expectedValue] of Object.entries(expected))
      if (Object.hasOwn(facts, key)) check(facts[key] === expectedValue);
    check(
      integer(facts["mel.validFrames"], previousFrames) &&
        facts["mel.validFrames"] <= mel.frames.length &&
        integer(facts["mel.receivedFrames"], previousReceived) &&
        facts["mel.receivedFrames"] <= mel.expectedRecords &&
        facts["mel.receivedFrames"] >= facts["mel.validFrames"] &&
        event.frames === facts["mel.validFrames"],
    );
    if (Object.hasOwn(facts, "mel.dspGeneration")) {
      check(
        integer(facts["mel.dspGeneration"], 1) &&
          (generation === undefined ||
            facts["mel.dspGeneration"] === generation),
      );
      generation = facts["mel.dspGeneration"];
    }
    if (event.reason === "mel_native_cleanup_complete") {
      terminal++;
      check(
        index === value.length - 1 &&
          event.stage === "completed" &&
          event.phase === "drain" &&
          fields.every((key) => Object.hasOwn(facts, key)) &&
          facts["mel.validFrames"] === mel.frames.length &&
          facts["mel.receivedFrames"] === mel.expectedRecords &&
          integer(
            facts["mel.sourceClockExclusive"],
            mel.sourceSupport.endSample,
          ),
      );
    }
    ids.add(event.eventId);
    previousSequence = event.sequence;
    previousElapsed = event.elapsedMs;
    previousFrames = facts["mel.validFrames"];
    previousReceived = facts["mel.receivedFrames"];
  }
  check(terminal === 1);
}
