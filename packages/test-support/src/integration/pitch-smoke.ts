import { isDeepStrictEqual } from "node:util";
import type { TelemetryEventPage } from "@ableton-agent/observability";
import {
  FLUCOMA_DEPENDENCY_FILES,
  FLUCOMA_PITCH_BUNDLE,
} from "@ableton-agent/shared/m4l-devices";
import type { AssertionInput, Facts, PitchSmokeEvidence } from "./contracts.js";

type HistoryEvent = TelemetryEventPage["items"][number];
export type PitchSmokeOwner = Pick<
  PitchSmokeEvidence,
  "traceId" | "correlationId" | "passId" | "listenerId" | "native"
>;
const prefix = "output.listener.native.metric.monophonic-pitch.";
const constants = {
  "pitch.schema": "flucoma-pitch-smoke/v1",
  "pitch.support": "unqualified",
  "pitch.valueValidity": "unqualified",
  "pitch.units": "Hz",
  "pitch.algorithm": "YinFFT",
  "pitch.minfreq": 50,
  "pitch.maxfreq": 2000,
  "pitch.channelPolicy": "independent-stereo",
  "pitch.windowSamples": 2048,
  "pitch.hopSamples": 2048,
  "pitch.fftSamples": 2048,
  "pitch.confidenceSemantics": "yinfft-score-not-probability",
  "pitch.undefinedHz": 0,
};
const fields = [
  ...Object.keys(constants),
  ...["left", "right"].flatMap((channel) =>
    ["Deliveries", "Hz", "Confidence", "Candidates", "Class"].map(
      (suffix) => `pitch.${channel}${suffix}`,
    ),
  ),
  "pitch.cleanup",
];
function check(value: unknown): asserts value {
  if (!value)
    throw new Error("Invalid or incomplete paired pitch smoke evidence");
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  check(
    Object.keys(value).length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key)),
  );
}
function bounded(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(value)
  );
}
function owned(event: HistoryEvent, owner: PitchSmokeOwner): boolean {
  return (
    event.trace?.traceId === owner.traceId &&
    event.correlationId === owner.correlationId &&
    event.attributes.passId === owner.passId
  );
}
function exactOwner(event: HistoryEvent, owner: PitchSmokeOwner): void {
  check(
    owned(event, owner) &&
      event.source === "output-ingress" &&
      event.attributes.listenerId === owner.listenerId &&
      Object.entries(owner.native).every(
        ([key, value]) => event.attributes[key] === value,
      ),
  );
}
function observed(value: unknown): number | string {
  const actual = record(value);
  keys(actual, ["state", "value"]);
  check(
    actual.state === "observed" &&
      (typeof actual.value === "number" || typeof actual.value === "string"),
  );
  return actual.value;
}
function unavailable(value: unknown): void {
  const actual = record(value);
  keys(actual, ["state", "reason"]);
  check(actual.state === "unavailable" && actual.reason === "not-reported");
}

/** Paired diagnostic snapshots from typed History; no scalar spectral or report surrogate. */
export function projectPitchSmoke(
  history: readonly HistoryEvent[],
  owner: PitchSmokeOwner,
  afterOwnedRestart = false,
): PitchSmokeEvidence {
  const candidates = history.filter(
    (event) => event.name.startsWith(prefix) && owned(event, owner),
  );
  check(candidates.length >= 7 && candidates.length <= 96);
  const events = candidates.map((event) => {
    exactOwner(event, owner);
    const lifecycle = record(event.attributes.lifecycle);
    check(Buffer.byteLength(JSON.stringify(lifecycle), "utf8") <= 8192);
    check(
      lifecycle.scope === "independent-metric-timelines/v1" &&
        lifecycle.metric === "monophonic-pitch" &&
        lifecycle.frames === 0 &&
        lifecycle.generation === owner.native.generation &&
        lifecycle.nativeEpoch === owner.native.nativeEpoch &&
        lifecycle.eventId === event.id &&
        lifecycle.causationId === event.causationId &&
        event.trace?.spanId === event.id &&
        event.name === `${prefix}${String(lifecycle.stage)}` &&
        event.durationMs === lifecycle.durationMs &&
        event.outcome ===
          (lifecycle.stage === "completed" ? "success" : "unknown") &&
        !["failed", "cancelled"].includes(String(lifecycle.stage)),
    );
    check(Array.isArray(lifecycle.facts) && lifecycle.facts.length === 24);
    const facts: Record<
      string,
      PitchSmokeEvidence["events"][number]["facts"][string]
    > = {};
    for (const raw of lifecycle.facts) {
      const fact = record(raw);
      check(
        typeof fact.field === "string" &&
          fields.includes(fact.field) &&
          !Object.hasOwn(facts, fact.field),
      );
      const actual = record(fact.actual);
      if (actual.state === "observed") observed(actual);
      else unavailable(actual);
      facts[fact.field] =
        actual as PitchSmokeEvidence["events"][number]["facts"][string];
    }
    return {
      eventId: event.id,
      causationId: event.causationId,
      sequence: event.sequence,
      stage: lifecycle.stage,
      phase: lifecycle.phase,
      elapsedMs: lifecycle.elapsedMs,
      durationMs: lifecycle.durationMs,
      reason: lifecycle.reason,
      facts,
    } as PitchSmokeEvidence["events"][number];
  });
  const launch = history.find((event) => event.id === events[0]!.causationId);
  check(
    launch &&
      launch.name === "output.listener.native.completed" &&
      launch.outcome === "success",
  );
  exactOwner(launch, owner);
  const lifecycle = record(launch.attributes.lifecycle);
  check(
    lifecycle.phase === "launch" &&
      lifecycle.stage === "completed" &&
      lifecycle.eventId === launch.id &&
      lifecycle.scope === "independent-metric-timelines/v1" &&
      lifecycle.generation === owner.native.generation &&
      lifecycle.nativeEpoch === owner.native.nativeEpoch,
  );
  const evidence = {
    ...owner,
    native: { ...owner.native },
    afterOwnedRestart,
    launchEventId: launch.id,
    launchSequence: launch.sequence,
    events,
  };
  validatePitchSmoke(evidence);
  return evidence;
}

export function validatePitchSmoke(
  value: unknown,
): asserts value is PitchSmokeEvidence {
  const evidence = record(value);
  keys(evidence, [
    "traceId",
    "correlationId",
    "passId",
    "listenerId",
    "native",
    "launchEventId",
    "launchSequence",
    "afterOwnedRestart",
    "events",
  ]);
  for (const key of [
    "traceId",
    "correlationId",
    "passId",
    "listenerId",
    "launchEventId",
  ])
    check(identity(evidence[key]));
  check(typeof evidence.afterOwnedRestart === "boolean");
  const native = record(evidence.native);
  keys(native, [
    "generation",
    "connectionId",
    "connectionEpoch",
    "nativeEpoch",
  ]);
  for (const key of ["generation", "connectionId", "connectionEpoch"])
    check(
      typeof native[key] === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(
          String(native[key]),
        ),
    );
  check(
    bounded(native.nativeEpoch, 1, 1_000_000) &&
      Number.isInteger(native.nativeEpoch),
  );
  check(
    bounded(evidence.launchSequence, 0, Number.MAX_SAFE_INTEGER) &&
      Number.isInteger(evidence.launchSequence),
  );
  check(
    Array.isArray(evidence.events) &&
      evidence.events.length >= 7 &&
      evidence.events.length <= 96,
  );
  let sequence = 0;
  let elapsed = 0;
  let cause = evidence.launchEventId;
  let phase = 0;
  let progress = false;
  let counts = [0, 0];
  let candidates = [0, 0];
  const pairs: (readonly [number, number] | undefined)[] = [
    undefined,
    undefined,
  ];
  const ids = new Set([cause]);
  for (const raw of evidence.events) {
    const event = record(raw);
    keys(event, [
      "eventId",
      "causationId",
      "sequence",
      "stage",
      "phase",
      "elapsedMs",
      "durationMs",
      "reason",
      "facts",
    ]);
    check(Buffer.byteLength(JSON.stringify(event), "utf8") <= 8192);
    check(
      identity(event.eventId) &&
        !ids.has(event.eventId) &&
        event.causationId === cause,
    );
    check(
      bounded(event.sequence, sequence + 1, Number.MAX_SAFE_INTEGER) &&
        Number.isInteger(event.sequence),
    );
    check(
      bounded(event.elapsedMs, elapsed, 120_000) &&
        bounded(event.durationMs, 0, 120_000),
    );
    const facts = record(event.facts);
    keys(facts, fields);
    for (const [field, expected] of Object.entries(constants))
      check(observed(facts[field]) === expected);
    const nextCandidates: number[] = [];
    const nextCounts = ["left", "right"].map((channel, index) => {
      if (phase === 0) unavailable(facts[`pitch.${channel}Class`]);
      else check(observed(facts[`pitch.${channel}Class`]) === "fluid.pitch~");
      const deliveries = observed(facts[`pitch.${channel}Deliveries`]);
      check(
        bounded(deliveries, counts[index]!, 400) &&
          Number.isInteger(deliveries),
      );
      const positive = observed(facts[`pitch.${channel}Candidates`]);
      check(
        bounded(positive, candidates[index]!, deliveries) &&
          Number.isInteger(positive) &&
          positive - candidates[index]! <= deliveries - counts[index]!,
      );
      nextCandidates.push(positive);
      if (deliveries === 0) {
        unavailable(facts[`pitch.${channel}Hz`]);
        unavailable(facts[`pitch.${channel}Confidence`]);
      } else {
        const hz = observed(facts[`pitch.${channel}Hz`]);
        const confidence = observed(facts[`pitch.${channel}Confidence`]);
        check((hz === 0 || bounded(hz, 50, 2000)) && bounded(confidence, 0, 1));
        // A nonzero last pair needs a candidate. A final sentinel needs at least
        // one noncandidate delivery, and is distinct from absent output.
        check(hz === 0 ? positive < deliveries : positive > 0);
        const previous = pairs[index];
        if (deliveries === counts[index])
          check(previous?.[0] === hz && previous[1] === confidence);
        else if (hz > 0) check(positive > candidates[index]!);
        else check(positive - candidates[index]! < deliveries - counts[index]!);
        pairs[index] = [hz, confidence];
      }
      return deliveries;
    });
    const cleanup = observed(facts["pitch.cleanup"]);
    if (phase === 0 || phase === 1) {
      check(
        event.stage === (phase === 0 ? "queued" : "started") &&
          event.reason === "pitch_smoke_capture" &&
          nextCounts.every((n) => n === 0),
      );
      phase++;
    } else if (phase === 2 && event.stage === "progress") {
      check(
        event.reason === "pitch_smoke_output" && nextCounts.every((n) => n > 0),
      );
      progress = true;
    } else if (phase === 2) {
      check(
        progress &&
          event.stage === "completed" &&
          event.reason === "pitch_smoke_capture" &&
          nextCounts.every((n) => n > 0) &&
          nextCandidates.every((n) => n > 0),
      );
      phase++;
    } else {
      check(
        phase <= 5 &&
          event.stage === ["queued", "started", "completed"][phase - 3] &&
          event.reason === "pitch_smoke_cleanup" &&
          nextCounts.every((n, i) => n === counts[i]),
      );
      phase++;
    }
    const draining = event.reason === "pitch_smoke_cleanup";
    check(
      event.phase === (draining ? "drain" : "capture") &&
        cleanup ===
          (draining
            ? event.stage === "completed"
              ? "completed"
              : "pending"
            : "not-started"),
    );
    ids.add(event.eventId);
    cause = event.eventId;
    sequence = event.sequence;
    elapsed = event.elapsedMs;
    counts = nextCounts;
    candidates = nextCandidates;
  }
  check(phase === 6);
}

const binaryIdentityKeys = [
  "pitchLoadedBinaryVerified",
  "pitchLoadedBinarySchema",
  "pitchLoadedBinaryPath",
  "pitchLoadedBinarySha256",
  "pitchLoadedBinaryPids",
  "pitchLoadedBinaryInode",
  "pitchLoadedBinaryDevice",
] as const;
export function validatePitchBinaryProof(
  facts: Facts,
  phase: "baseline" | "capture-completed",
): void {
  const name = `${FLUCOMA_PITCH_BUNDLE}/Contents/MacOS/fluid.pitch~`;
  const pin = FLUCOMA_DEPENDENCY_FILES.find((entry) => entry.name === name);
  const path = facts.pitchLoadedBinaryPath;
  check(
    pin &&
      facts.pitchLoadedBinaryVerified === true &&
      facts.pitchLoadedBinarySchema === "owned-mapped-flucoma-pitch/v1" &&
      facts.pitchLoadedBinarySha256 === pin.sha256 &&
      facts.pitchLoadedBinaryState === "completed" &&
      facts.pitchLoadedBinaryPhase === phase &&
      typeof path === "string" &&
      path.length <= 4096 &&
      path.startsWith("/") &&
      !path.split("/").some((part) => part === "." || part === "..") &&
      path.endsWith(`/${name}`) &&
      typeof facts.pitchLoadedBinaryPids === "string" &&
      /^[1-9]\d*(?:,[1-9]\d*){0,7}$/u.test(facts.pitchLoadedBinaryPids) &&
      new Set(facts.pitchLoadedBinaryPids.split(",")).size ===
        facts.pitchLoadedBinaryPids.split(",").length &&
      typeof facts.pitchLoadedBinaryInode === "string" &&
      /^[1-9]\d{0,20}$/u.test(facts.pitchLoadedBinaryInode) &&
      typeof facts.pitchLoadedBinaryDevice === "string" &&
      /^\d{1,21}$/u.test(facts.pitchLoadedBinaryDevice) &&
      bounded(facts.pitchLoadedBinaryDurationMs, 0, Number.MAX_VALUE),
  );
}

export function verifyPitchSmoke(
  input: AssertionInput,
  sourceId: string,
  afterRestart: boolean,
): void {
  const selected =
    input.turn ?? (input.turns.length === 1 ? input.turns[0] : undefined);
  const capture = selected?.captures[0];
  const source = input.baseline.sources?.[sourceId];
  const entries = afterRestart
    ? input.evidence?.pitchSmoke
    : selected?.pitchSmoke;
  const evidence = entries?.[0];
  check(
    selected?.status === "completed" &&
      selected.captures.length === 1 &&
      capture?.native &&
      capture.complete &&
      capture.cleanupComplete &&
      !capture.failure &&
      capture.operationId === selected.operationId &&
      source &&
      capture.listenerId === source.listenerId &&
      isDeepStrictEqual(capture.source, source.source) &&
      entries?.length === 1 &&
      evidence,
  );
  validatePitchSmoke(evidence);
  validatePitchBinaryProof(input.baseline.facts, "baseline");
  validatePitchBinaryProof(selected.facts, "capture-completed");
  check(
    binaryIdentityKeys.every(
      (key) => selected.facts[key] === input.baseline.facts[key],
    ),
  );
  const owner = {
    traceId: evidence.traceId,
    correlationId: evidence.correlationId,
    passId: evidence.passId,
    listenerId: evidence.listenerId,
    ...evidence.native,
  };
  for (const [key, expected] of Object.entries(owner))
    check(
      selected.facts[
        `pitchLoadedBinary${key[0]!.toUpperCase()}${key.slice(1)}`
      ] === expected,
    );
  check(
    evidence.traceId === selected.facts.sdkTurnId &&
      evidence.correlationId === selected.facts.sdkTurnId &&
      evidence.passId === capture.passId &&
      evidence.listenerId === capture.listenerId &&
      isDeepStrictEqual(evidence.native, capture.native) &&
      evidence.afterOwnedRestart === afterRestart,
  );
  if (afterRestart) {
    check(
      Object.entries(selected.facts)
        .filter(([key]) => key.startsWith("pitchLoadedBinary"))
        .every(([key, expected]) => input.evidence?.facts[key] === expected),
    );
    check(
      isDeepStrictEqual(evidence, {
        ...selected.pitchSmoke?.[0],
        afterOwnedRestart: true,
      }),
    );
  }
}
