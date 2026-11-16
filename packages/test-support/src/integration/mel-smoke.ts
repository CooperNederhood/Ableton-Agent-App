import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  metricAudioObservationSchema,
  projectMetricListeningReport,
  type MetricAudioObservation,
  metricRecordStreamContextReferenceSchema,
  metricRecordStreamDescriptorSchema,
  metricRecordChunkSchema,
  metricRecordStreamExpectedCoverage,
  canonicalMetricRecordJson,
  projectMetricFeatureSource,
  type MetricRecordStreamDescriptor,
  type MetricRecordChunk,
} from "@ableton-agent/protocol";
import type { AssertionInput, Facts } from "./contracts.js";
import {
  NATIVE_MEL_BUNDLE,
  NATIVE_MEL_PRODUCER,
} from "@ableton-agent/shared/m4l-devices";
import {
  projectMelLifecycle,
  validateMelLifecycle,
  type MelLifecycleReceipt,
  type MelHistoryEvent,
} from "./mel-lifecycle.js";
import {
  expandArrangementDescriptor,
  streamProofContentSha256,
  type ArrangementStreamProof,
} from "./arrangement-stream.js";
import { validateArrangementStreamProof } from "./validation.js";

/** Typed context projection, not evidence that the agent requested every page. */
export interface HistoricalMelSmokeEvidence {
  readonly contextId: string;
  readonly afterOwnedRestart: boolean;
  readonly cleanupComplete: boolean;
  readonly nativeLifecycle: readonly MelLifecycleReceipt[];
  readonly observation: MetricAudioObservation;
  readonly reportProjection: {
    readonly provenance: "typed-desktop-context-projection";
    readonly pages: readonly {
      readonly offset: number;
      readonly nextOffset: number | null;
      readonly rowCount: number;
      readonly sha256: string;
    }[];
  };
}
export interface StreamMelSmokeEvidence {
  readonly contextId: string;
  readonly afterOwnedRestart: boolean;
  readonly cleanupComplete: boolean;
  readonly nativeLifecycle: readonly MelLifecycleReceipt[];
  readonly observation: MetricRecordStreamDescriptor;
  readonly chunks: readonly MetricRecordChunk[];
  readonly stream: ArrangementStreamProof;
}
export type MelSmokeEvidence =
  HistoricalMelSmokeEvidence | StreamMelSmokeEvidence;

function streamMelSource(
  evidence: Omit<StreamMelSmokeEvidence, "nativeLifecycle">,
) {
  const descriptor = metricRecordStreamDescriptorSchema.parse(
    evidence.observation,
  );
  validateArrangementStreamProof(evidence.stream);
  const digest = (value: unknown) =>
    createHash("sha256").update(canonicalMetricRecordJson(value)).digest("hex");
  requireMel(
    descriptor.source.view === "session" &&
      descriptor.geometry.sampleRate === 48_000 &&
      descriptor.geometry.totalSamples === 90_000 &&
      evidence.stream.contextId === evidence.contextId &&
      evidence.stream.passId === descriptor.ownership.passId &&
      evidence.stream.listenerId === descriptor.ownership.listenerId &&
      evidence.stream.afterOwnedRestart === evidence.afterOwnedRestart &&
      evidence.stream.descriptorDigest === digest(descriptor) &&
      evidence.chunks.length === evidence.stream.chunkCount &&
      evidence.chunks.length > 0 &&
      evidence.chunks.length <= 256,
    "foreign or unbounded original mel stream",
  );
  const counts = new Map<
    string,
    { records: number; sequence: number; digest: string }
  >();
  const records = createHash("sha256");
  for (const raw of evidence.chunks) {
    const chunk = metricRecordChunkSchema.parse(raw);
    const { digest: chunkDigest, ...body } = chunk;
    const prior = counts.get(chunk.metric) ?? {
      records: 0,
      sequence: 0,
      digest: evidence.stream.descriptorDigest,
    };
    requireMel(
      descriptor.requestedMetrics.includes(chunk.metric) &&
        chunk.descriptorDigest === evidence.stream.descriptorDigest &&
        isDeepStrictEqual(chunk.ownership, descriptor.ownership) &&
        chunk.gaps.length === 0 &&
        chunk.chunkSequence === prior.sequence &&
        chunk.recordOffset === prior.records &&
        chunk.slotOffset === prior.records &&
        chunk.previousDigest === prior.digest &&
        chunkDigest === digest(body) &&
        chunk.records.every(
          (record, index) => record.index === prior.records + index,
        ),
      "changed, missing or reordered original mel stream records",
    );
    counts.set(chunk.metric, {
      records: prior.records + chunk.records.length,
      sequence: prior.sequence + 1,
      digest: chunkDigest,
    });
    records.update(JSON.stringify(chunk)).update("\n");
  }
  requireMel(
    records.digest("hex") === evidence.stream.recordsSha256 &&
      descriptor.requestedMetrics.every(
        (metric) =>
          counts.get(metric)?.records ===
          metricRecordStreamExpectedCoverage(descriptor, metric)
            .expectedRecords,
      ) &&
      (["level", "spectral-centroid", "attacks", "mel-bands"] as const).every(
        (metric) =>
          descriptor.algorithms.some(
            (algorithm) =>
              algorithm.metric === metric &&
              algorithm.availability === "available",
          ),
      ),
    "incomplete original mel stream or changed content fingerprint",
  );
  const { rows, ...geometry } = descriptor.geometry;
  void rows;
  const reference = {
    schema: "metric-record-stream-context/v1" as const,
    captureId: evidence.contextId,
    descriptorDigest: evidence.stream.descriptorDigest,
    descriptor: { ...descriptor, geometry },
  };
  const projected = projectMetricFeatureSource(reference, evidence.chunks);
  const mel = projected.metrics["mel-bands"];
  requireMel(mel, "missing original mel records");
  requireMel(
    mel.frames.length === 43 &&
      [0, 1].every((channel) =>
        mel.frames.some((frame) =>
          frame.magnitudes[channel]!.some((magnitude) => magnitude > 0),
        ),
      ),
    "requires complete nonzero independent stereo mel and baseline timelines",
  );
  return {
    ownership: descriptor.ownership,
    metrics: { "mel-bands": { ...mel, expectedRecords: 43 } },
  };
}
function requireMel(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`Mel smoke: ${detail}`);
}

const binaryIdentityKeys = [
  "melLoadedBinaryVerified",
  "melLoadedBinarySchema",
  "melLoadedBinaryPath",
  "melLoadedBinarySha256",
  "melLoadedBinaryPids",
  "melLoadedBinaryInode",
  "melLoadedBinaryDevice",
] as const;
export function validateMelBinaryProof(
  facts: Facts,
  phase: "baseline" | "capture-completed",
): void {
  const path = facts.melLoadedBinaryPath;
  requireMel(
    facts.melLoadedBinaryVerified === true &&
      facts.melLoadedBinarySchema === "owned-mapped-listener-mel/v1" &&
      facts.melLoadedBinarySha256 === NATIVE_MEL_PRODUCER.binarySha256 &&
      facts.melLoadedBinaryState === "completed" &&
      facts.melLoadedBinaryPhase === phase &&
      typeof path === "string" &&
      path.length <= 4096 &&
      path.startsWith("/") &&
      !path.split("/").some((part) => part === "." || part === "..") &&
      path.endsWith(`/${NATIVE_MEL_BUNDLE}/Contents/MacOS/listener.mel~`) &&
      typeof facts.melLoadedBinaryPids === "string" &&
      /^[1-9]\d*(?:,[1-9]\d*){0,7}$/u.test(facts.melLoadedBinaryPids) &&
      new Set(facts.melLoadedBinaryPids.split(",")).size ===
        facts.melLoadedBinaryPids.split(",").length &&
      typeof facts.melLoadedBinaryInode === "string" &&
      /^[1-9]\d{0,20}$/u.test(facts.melLoadedBinaryInode) &&
      typeof facts.melLoadedBinaryDevice === "string" &&
      /^\d{1,21}$/u.test(facts.melLoadedBinaryDevice) &&
      typeof facts.melLoadedBinaryDurationMs === "number" &&
      Number.isFinite(facts.melLoadedBinaryDurationMs) &&
      facts.melLoadedBinaryDurationMs >= 0,
    "missing independent pinned mapped mel binary proof",
  );
}

function pages(
  observation: MetricAudioObservation,
): HistoricalMelSmokeEvidence["reportProjection"]["pages"] {
  const result: HistoricalMelSmokeEvidence["reportProjection"]["pages"][number][] =
    [];
  let offset: number | null = 0;
  do {
    const page = projectMetricListeningReport(observation, {
      offset,
      limit: 32,
    });
    result.push({
      offset: page.offset,
      nextOffset: page.nextOffset,
      rowCount: page.rows.length,
      sha256: createHash("sha256").update(JSON.stringify(page)).digest("hex"),
    });
    requireMel(
      page.nextOffset === null || page.nextOffset > offset,
      "nonadvancing page",
    );
    offset = page.nextOffset;
  } while (offset !== null);
  return result;
}

export function projectMelSmoke(
  observation: MetricAudioObservation,
  contextId: string,
  cleanupComplete: boolean,
  history: readonly MelHistoryEvent[],
  afterOwnedRestart?: boolean,
): HistoricalMelSmokeEvidence;
export function projectMelSmoke(
  observation: unknown,
  contextId: string,
  cleanupComplete: boolean,
  history: readonly MelHistoryEvent[],
  afterOwnedRestart?: boolean,
): MelSmokeEvidence;
export function projectMelSmoke(
  observation: unknown,
  contextId: string,
  cleanupComplete: boolean,
  history: readonly MelHistoryEvent[],
  afterOwnedRestart = false,
): MelSmokeEvidence {
  if (
    observation &&
    typeof observation === "object" &&
    "reference" in observation
  ) {
    requireMel(
      "chunks" in observation &&
        "proof" in observation &&
        Array.isArray(observation.chunks),
      "missing original mel stream records",
    );
    validateArrangementStreamProof(observation.proof);
    const reference = metricRecordStreamContextReferenceSchema.parse(
      observation.reference,
    );
    const base = {
      contextId,
      afterOwnedRestart,
      cleanupComplete,
      observation: expandArrangementDescriptor(reference.descriptor),
      chunks: observation.chunks.map((chunk: unknown) =>
        metricRecordChunkSchema.parse(chunk),
      ),
      stream: observation.proof,
    };
    requireMel(
      reference.captureId === contextId &&
        reference.descriptorDigest === base.stream.descriptorDigest,
      "foreign mel stream reference",
    );
    const projected = {
      ...base,
      nativeLifecycle: projectMelLifecycle(history, streamMelSource(base)),
    };
    validateMelSmoke(projected);
    return projected;
  }
  const parsed = metricAudioObservationSchema.parse(observation);
  const evidence: HistoricalMelSmokeEvidence = {
    contextId,
    afterOwnedRestart,
    cleanupComplete,
    nativeLifecycle: projectMelLifecycle(history, parsed),
    observation: parsed,
    reportProjection: {
      provenance: "typed-desktop-context-projection",
      pages: pages(parsed),
    },
  };
  validateMelSmoke(evidence);
  return evidence;
}

export function validateMelSmoke(
  value: unknown,
): asserts value is MelSmokeEvidence {
  requireMel(value && typeof value === "object", "missing evidence");
  const evidence = value as MelSmokeEvidence;
  if ("chunks" in evidence) {
    requireMel(
      Object.keys(evidence).every((key) =>
        [
          "contextId",
          "afterOwnedRestart",
          "cleanupComplete",
          "nativeLifecycle",
          "observation",
          "chunks",
          "stream",
        ].includes(key),
      ) &&
        typeof evidence.contextId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(evidence.contextId) &&
        typeof evidence.afterOwnedRestart === "boolean" &&
        evidence.cleanupComplete === true,
      "invalid stream context provenance or cleanup",
    );
    validateMelLifecycle(evidence.nativeLifecycle, streamMelSource(evidence));
    return;
  }
  requireMel(
    Object.keys(evidence).every((key) =>
      [
        "contextId",
        "afterOwnedRestart",
        "cleanupComplete",
        "nativeLifecycle",
        "observation",
        "reportProjection",
      ].includes(key),
    ) &&
      typeof evidence.contextId === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(evidence.contextId) &&
      typeof evidence.afterOwnedRestart === "boolean" &&
      evidence.cleanupComplete === true,
    "invalid context provenance or acquisition cleanup",
  );
  const observation = metricAudioObservationSchema.parse(evidence.observation);
  const mel = observation.metrics["mel-bands"];
  validateMelLifecycle(evidence.nativeLifecycle, observation);
  requireMel(
    observation.outcome === "complete" &&
      observation.source.view === "session" &&
      observation.geometry.sampleRate === 48_000 &&
      observation.geometry.totalSamples === 90_000 &&
      observation.sourceCoverage.endSample -
        observation.sourceCoverage.startSample ===
        90_000 &&
      observation.reduction.mode === "none" &&
      (["level", "spectral-centroid", "attacks", "mel-bands"] as const).every(
        (metric) =>
          observation.requestedMetrics.includes(metric) &&
          observation.metrics[metric]?.status === "complete",
      ) &&
      mel?.status === "complete" &&
      mel.expectedRecords === 43 &&
      mel.frames.length === 43 &&
      mel.gaps.length === 0 &&
      [0, 1].every((channel) =>
        mel.frames.some((frame) =>
          frame.magnitudes[channel]!.some((magnitude) => magnitude > 0),
        ),
      ),
    "requires complete nonzero independent stereo mel and baseline timelines",
  );
  requireMel(
    evidence.reportProjection?.provenance ===
      "typed-desktop-context-projection" &&
      Object.keys(evidence.reportProjection).length === 2 &&
      Array.isArray(evidence.reportProjection.pages) &&
      evidence.reportProjection.pages.length > 0 &&
      evidence.reportProjection.pages.length <= observation.rows.length,
    "missing bounded context report projection",
  );
  requireMel(
    isDeepStrictEqual(evidence.reportProjection.pages, pages(observation)),
    "lossy, changed or truncated report vectors, ratios, profile or support",
  );
}

export function verifyMelSmoke(
  input: AssertionInput,
  sourceId: string,
  afterRestart: boolean,
): void {
  const selected =
    input.turn ?? (input.turns.length === 1 ? input.turns[0] : undefined);
  const capture = selected?.captures[0];
  const source = input.baseline.sources?.[sourceId];
  const entries = afterRestart ? input.evidence?.melSmoke : selected?.melSmoke;
  const evidence = entries?.[0];
  requireMel(
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
    "missing independently owned capture",
  );
  validateMelSmoke(evidence);
  const observation = evidence.observation;
  const owner = observation.ownership;
  validateMelBinaryProof(input.baseline.facts, "baseline");
  validateMelBinaryProof(selected.facts, "capture-completed");
  requireMel(
    binaryIdentityKeys.every(
      (key) => selected.facts[key] === input.baseline.facts[key],
    ),
    "mapped mel binary identity changed between baseline and capture",
  );
  for (const [key, expected] of Object.entries(owner)) {
    const field = `melLoadedBinary${key[0]!.toUpperCase()}${key.slice(1)}`;
    requireMel(
      selected.facts[field] === expected,
      "mapped mel proof belongs to a different acquisition",
    );
  }
  if (afterRestart)
    requireMel(
      Object.entries(selected.facts)
        .filter(([key]) => key.startsWith("melLoadedBinary"))
        .every(([key, expected]) => input.evidence?.facts[key] === expected),
      "original mapped acquisition proof changed after restart",
    );
  const context = (
    afterRestart ? input.evidence?.contexts : selected.contexts
  )?.find((entry) => entry.contextId === evidence.contextId);
  requireMel(
    owner.passId === capture.passId &&
      owner.listenerId === capture.listenerId &&
      owner.traceId === selected.facts.sdkTurnId &&
      owner.correlationId === selected.facts.sdkTurnId &&
      Object.entries(capture.native).every(
        ([key, value]) => Reflect.get(owner, key) === value,
      ) &&
      capture.sampleRate === observation.geometry.sampleRate &&
      capture.startSample === observation.geometry.startSample &&
      capture.endSample === observation.geometry.endSample &&
      context?.readable &&
      context.passId === capture.passId &&
      isDeepStrictEqual(context.source, source.source) &&
      context.afterOwnedRestart === afterRestart &&
      evidence.afterOwnedRestart === afterRestart &&
      context.contentSha256 ===
        ("stream" in evidence
          ? streamProofContentSha256(evidence.stream)
          : createHash("sha256")
              .update(JSON.stringify(observation))
              .digest("hex")),
    "foreign ownership or typed context content",
  );
  if (afterRestart)
    requireMel(
      isDeepStrictEqual(evidence, {
        ...selected.melSmoke?.[0],
        afterOwnedRestart: true,
        ...("stream" in evidence &&
        selected.melSmoke?.[0] &&
        "stream" in selected.melSmoke[0]
          ? {
              stream: {
                ...selected.melSmoke[0].stream,
                afterOwnedRestart: true,
              },
            }
          : {}),
      }),
      "persisted mel content changed after owned restart",
    );
}
