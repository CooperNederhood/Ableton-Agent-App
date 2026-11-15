import {
  hash,
  identifier,
  listenerIdentifier,
  rejectUnknownFields,
  requireCondition,
  safeRelativePath,
} from "./validation.js";
import type { AssertionInput, FixtureManifest } from "./contracts.js";
import type { ArrangementStreamProof } from "./arrangement-stream.js";

/** Dedicated Arrangement capability; Session source and duration contracts remain unchanged. */
export const ARRANGEMENT_AUDIO_CAPABILITY = "arrangement-audio" as const;
export interface ArrangementRange {
  readonly startBeat: number;
  readonly endBeat: number;
}
export interface ArrangementFixtureSource extends ArrangementRange {
  readonly id: string;
  readonly view: "arrangement";
  readonly trackIndex: number;
  readonly trackName: string;
  readonly listenerBindingSlot: string;
  readonly tempoBpm: number;
  readonly clips: readonly (ArrangementRange & {
    readonly savedClipId: string;
    readonly mediaTarget: string;
  })[];
}
export interface ArrangementSourceIdentity extends ArrangementRange {
  readonly view: "arrangement";
  readonly trackId: string;
  readonly trackIndex: number;
  readonly clips: readonly (ArrangementRange & {
    readonly clipId: string;
    readonly savedClipId: string;
    readonly mediaSha256: string;
  })[];
}
export interface ArrangementSourceEvidence {
  readonly source: ArrangementSourceIdentity;
  readonly trackName: string;
  readonly listenerId: string;
  readonly listenerDeviceIndex: number;
  /** Actual loaded Set and separately hashed saved Set, not expected manifest hashes. */
  readonly loadedProjectSha256: string;
  readonly savedProjectSha256: string;
  readonly savedClips: readonly (ArrangementRange & {
    readonly savedClipId: string;
    readonly mediaTarget: string;
  })[];
  readonly media: readonly {
    readonly target: string;
    readonly loadedPath: string;
    readonly ownedPath: string;
    readonly sha256: string;
    readonly sampleRate: number;
  }[];
  readonly before: ArrangementLoadedState;
  readonly after: ArrangementLoadedState;
}
export interface ArrangementLoadedState {
  readonly tempoBpm: number;
  readonly tempoAutomation: false;
  readonly currentBeat: number;
  readonly transportPlaying: false;
  readonly loopEnabled: false;
  readonly arrangementRecord: false;
  readonly sessionRecord: false;
  readonly targetRecording: false;
  readonly targetArmed: boolean;
  readonly targetMonitoring: "off";
  readonly backToArrangement: boolean;
  readonly playingSessionClips: 0;
  readonly queuedSessionClips: 0;
}
export interface ArrangementCaptureEvidence {
  readonly stream?: ArrangementStreamProof;
  readonly passId: string;
  readonly operationId: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly listenerId: string;
  readonly source: ArrangementSourceIdentity;
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly spectralCentroidFirstFrameEndSample?: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly failure: string | null;
  /** Counts must be independently declared, not copied from the capture's totals. */
  readonly metrics: readonly {
    readonly name: string;
    readonly passId: string;
    readonly listenerId: string;
    readonly expectedRecords: number;
    readonly receivedRecords: number;
    readonly missingRecords: number;
    readonly startSample: number;
    readonly endSample: number;
    readonly source: ArrangementSourceIdentity;
    readonly nonSilent: boolean;
  }[];
  readonly cleanup: {
    readonly captureReleased: boolean;
    readonly sourceRestored: boolean;
    readonly transportPlaying: boolean;
    readonly failure: string | null;
  };
}
export type ArrangementMetricRecordExpectation = number | "verified-fft-phase";
function integer(value: number, min: number, max: number): void {
  requireCondition(
    Number.isSafeInteger(value) && value >= min && value <= max,
    "Invalid bounded Arrangement integer",
  );
}
function range(value: ArrangementRange): void {
  requireCondition(
    Number.isFinite(value.startBeat) &&
      Number.isFinite(value.endBeat) &&
      value.startBeat >= 0 &&
      value.endBeat > value.startBeat &&
      value.endBeat <= 1_576_800,
    "Invalid Arrangement beat range",
  );
}
function adjacent(
  clips: readonly ArrangementRange[],
  selected: ArrangementRange,
): void {
  range(selected);
  requireCondition(
    clips.length > 0 && clips.length <= 256,
    "Invalid Arrangement clip count",
  );
  let beat = selected.startBeat;
  for (const clip of clips) {
    range(clip);
    requireCondition(
      clip.startBeat === beat,
      "Arrangement clips must exactly tile the range",
    );
    beat = clip.endBeat;
  }
  requireCondition(
    beat === selected.endBeat,
    "Arrangement range differs from clip coverage",
  );
}
export function arrangementExpectedFrames(
  selected: ArrangementRange,
  tempoBpm: number,
  hostSampleRate: number,
): number {
  range(selected);
  requireCondition(
    Number.isFinite(tempoBpm) && tempoBpm >= 20 && tempoBpm <= 999,
    "Invalid fixed tempo",
  );
  integer(hostSampleRate, 8_000, 768_000);
  const frames =
    ((selected.endBeat - selected.startBeat) * 60 * hostSampleRate) / tempoBpm;
  requireCondition(
    Number.isSafeInteger(frames) && frames > 0,
    "Arrangement duration requires exact integral frame coverage",
  );
  return frames;
}
export function validateArrangementDefinition(
  value: ArrangementFixtureSource,
  fixture: Pick<FixtureManifest, "resources" | "listenerBindings">,
): void {
  rejectUnknownFields(value as unknown as Record<string, unknown>, [
    "id",
    "view",
    "trackIndex",
    "trackName",
    "listenerBindingSlot",
    "tempoBpm",
    "startBeat",
    "endBeat",
    "clips",
  ]);
  identifier(value.id);
  integer(value.trackIndex, 0, 255);
  requireCondition(
    value.view === "arrangement" &&
      typeof value.trackName === "string" &&
      value.trackName.length > 0 &&
      value.trackName.length <= 256,
    "Invalid Arrangement selector",
  );
  arrangementExpectedFrames(value, value.tempoBpm, 48_000);
  adjacent(value.clips, value);
  const ids = new Set<string>();
  for (const clip of value.clips) {
    rejectUnknownFields(clip as unknown as Record<string, unknown>, [
      "savedClipId",
      "mediaTarget",
      "startBeat",
      "endBeat",
    ]);
    identifier(clip.savedClipId);
    safeRelativePath(clip.mediaTarget);
    requireCondition(
      !ids.has(clip.savedClipId),
      "Duplicate saved Arrangement clip identity",
    );
    ids.add(clip.savedClipId);
    requireCondition(
      fixture.resources.some(
        (item) =>
          item.target === clip.mediaTarget &&
          /\.(wav|aiff?)$/u.test(item.target),
      ),
      "Undeclared Arrangement media",
    );
  }
  requireCondition(
    fixture.listenerBindings?.some(
      (binding) =>
        binding.slot === value.listenerBindingSlot &&
        binding.trackIndex === value.trackIndex &&
        binding.slot.startsWith("AudioTrack:") &&
        binding.deviceIndex < 8,
    ),
    "Arrangement requires an exact top-level audio listener binding",
  );
}
export function validateArrangementIdentity(
  value: ArrangementSourceIdentity,
): void {
  rejectUnknownFields(value as unknown as Record<string, unknown>, [
    "view",
    "trackId",
    "trackIndex",
    "startBeat",
    "endBeat",
    "clips",
  ]);
  requireCondition(
    value.view === "arrangement",
    "Expected Arrangement identity",
  );
  identifier(value.trackId);
  integer(value.trackIndex, 0, 255);
  adjacent(value.clips, value);
  const liveIds = new Set<string>(),
    savedIds = new Set<string>();
  for (const clip of value.clips) {
    rejectUnknownFields(clip as unknown as Record<string, unknown>, [
      "clipId",
      "savedClipId",
      "mediaSha256",
      "startBeat",
      "endBeat",
    ]);
    identifier(clip.clipId);
    identifier(clip.savedClipId);
    hash(clip.mediaSha256);
    requireCondition(
      !liveIds.has(clip.clipId) && !savedIds.has(clip.savedClipId),
      "Duplicate Arrangement source identity",
    );
    liveIds.add(clip.clipId);
    savedIds.add(clip.savedClipId);
  }
}
export function sameArrangementSource(
  a: ArrangementSourceIdentity,
  b: ArrangementSourceIdentity,
): boolean {
  validateArrangementIdentity(a);
  validateArrangementIdentity(b);
  return (
    a.trackId === b.trackId &&
    a.trackIndex === b.trackIndex &&
    a.startBeat === b.startBeat &&
    a.endBeat === b.endBeat &&
    a.clips.length === b.clips.length &&
    a.clips.every((clip, index) => {
      const other = b.clips[index]!;
      return (
        clip.clipId === other.clipId &&
        clip.savedClipId === other.savedClipId &&
        clip.mediaSha256 === other.mediaSha256 &&
        clip.startBeat === other.startBeat &&
        clip.endBeat === other.endBeat
      );
    })
  );
}
export function verifyArrangementSource(
  fixture: FixtureManifest,
  definition: ArrangementFixtureSource,
  evidence: ArrangementSourceEvidence,
): void {
  validateArrangementDefinition(definition, fixture);
  validateArrangementIdentity(evidence.source);
  hash(evidence.savedProjectSha256);
  hash(evidence.loadedProjectSha256);
  requireCondition(
    evidence.loadedProjectSha256 === evidence.savedProjectSha256,
    "Loaded and inspected saved Set differ",
  );
  listenerIdentifier(evidence.listenerId);
  const binding = fixture.listenerBindings!.find(
    (item) => item.slot === definition.listenerBindingSlot,
  )!;
  requireCondition(
    evidence.source.trackIndex === definition.trackIndex &&
      evidence.trackName === definition.trackName &&
      evidence.listenerDeviceIndex === binding.deviceIndex &&
      evidence.source.startBeat === definition.startBeat &&
      evidence.source.endBeat === definition.endBeat,
    "Loaded Arrangement selector/listener/range differs",
  );
  requireCondition(
    evidence.savedClips.length === definition.clips.length &&
      evidence.source.clips.length === definition.clips.length,
    "Saved/loaded Arrangement clip count differs",
  );
  for (const [index, expected] of definition.clips.entries()) {
    const saved = evidence.savedClips[index]!,
      loaded = evidence.source.clips[index]!;
    const resource = fixture.resources.find(
      (item) => item.target === expected.mediaTarget,
    )!;
    requireCondition(
      saved.savedClipId === expected.savedClipId &&
        saved.mediaTarget === expected.mediaTarget &&
        saved.startBeat === expected.startBeat &&
        saved.endBeat === expected.endBeat &&
        loaded.savedClipId === expected.savedClipId &&
        loaded.startBeat === expected.startBeat &&
        loaded.endBeat === expected.endBeat &&
        loaded.mediaSha256 === resource.sha256,
      "Independent saved/loaded Arrangement clip evidence differs",
    );
  }
  const targets = new Set(definition.clips.map((clip) => clip.mediaTarget));
  requireCondition(
    evidence.media.length === targets.size,
    "Missing or additional loaded Arrangement media",
  );
  for (const target of targets) {
    const matches = evidence.media.filter((item) => item.target === target);
    const resource = fixture.resources.find((item) => item.target === target)!;
    requireCondition(
      matches.length === 1,
      "Ambiguous loaded Arrangement media",
    );
    const media = matches[0]!;
    requireCondition(
      media.loadedPath.startsWith("/") &&
        media.loadedPath.length <= 4096 &&
        media.loadedPath === media.ownedPath &&
        media.sha256 === resource.sha256,
      "Loaded Arrangement media path/hash differs from independently verified owned bytes",
    );
    integer(media.sampleRate, 8_000, 768_000);
  }
  for (const state of [evidence.before, evidence.after]) {
    requireCondition(
      typeof fixture.baseline.currentSongTime === "number" &&
        Number.isFinite(fixture.baseline.currentSongTime) &&
        typeof fixture.baseline.targetArmed === "boolean" &&
        state.tempoBpm === definition.tempoBpm &&
        state.tempoAutomation === false &&
        state.currentBeat === fixture.baseline.currentSongTime &&
        state.targetArmed === fixture.baseline.targetArmed &&
        state.transportPlaying === false &&
        state.loopEnabled === false &&
        state.arrangementRecord === false &&
        state.sessionRecord === false &&
        state.targetRecording === false &&
        state.targetMonitoring === "off" &&
        state.backToArrangement ===
          (fixture.baseline.backToArrangement ?? false) &&
        state.playingSessionClips === 0 &&
        state.queuedSessionClips === 0,
      "Arrangement requires independent loaded stopped, fixed-tempo, nonrecording state; no repair",
    );
  }
}
export function verifyArrangementCapture(
  capture: ArrangementCaptureEvidence,
  baseline: ArrangementSourceEvidence,
  expected: {
    readonly operationId: string;
    readonly traceId: string;
    readonly tempoBpm: number;
    readonly hostSampleRate: number;
    readonly playbackAfterCapture: "playing" | "stopped";
    readonly causationId: string;
    readonly metricRecords: Readonly<
      Record<string, ArrangementMetricRecordExpectation>
    >;
  },
): void {
  for (const id of [
    capture.passId,
    capture.operationId,
    capture.traceId,
    capture.correlationId,
    capture.causationId,
  ])
    identifier(id);
  listenerIdentifier(capture.listenerId);
  const frames = arrangementExpectedFrames(
    baseline.source,
    expected.tempoBpm,
    expected.hostSampleRate,
  );
  requireCondition(
    capture.operationId === expected.operationId &&
      capture.traceId === expected.traceId &&
      capture.correlationId === expected.traceId &&
      capture.causationId === expected.causationId &&
      capture.listenerId === baseline.listenerId &&
      sameArrangementSource(capture.source, baseline.source),
    "Arrangement capture attribution differs",
  );
  integer(capture.startSample, 0, Number.MAX_SAFE_INTEGER);
  integer(capture.endSample, 0, Number.MAX_SAFE_INTEGER);
  requireCondition(
    capture.sampleRate === expected.hostSampleRate &&
      capture.endSample - capture.startSample === frames &&
      capture.complete === true &&
      capture.truncated === false &&
      capture.failure === null,
    "Arrangement capture range or outcome is incomplete",
  );
  const names = Object.keys(expected.metricRecords);
  requireCondition(
    names.length > 0 &&
      names.length <= 64 &&
      capture.metrics.length === names.length,
    "Missing Arrangement metric evidence",
  );
  for (const name of names) {
    identifier(name);
    const declared = expected.metricRecords[name]!;
    let expectedRecords: number;
    if (declared === "verified-fft-phase") {
      requireCondition(
        name === "spectral-centroid" &&
          capture.spectralCentroidFirstFrameEndSample !== undefined,
        "Missing verified spectral-centroid FFT phase",
      );
      const first = capture.spectralCentroidFirstFrameEndSample;
      integer(
        first,
        Math.max(2048, capture.startSample + 1),
        capture.startSample + 2048,
      );
      expectedRecords = Math.max(
        0,
        Math.floor((capture.endSample - first) / 2048) + 1,
      );
    } else {
      integer(declared, 1, Number.MAX_SAFE_INTEGER);
      expectedRecords = declared;
    }
    const entries = capture.metrics.filter((item) => item.name === name);
    requireCondition(
      entries.length === 1,
      "Missing or duplicate Arrangement metric",
    );
    const metric = entries[0]!;
    requireCondition(
      metric.passId === capture.passId &&
        metric.listenerId === capture.listenerId &&
        metric.expectedRecords === expectedRecords &&
        metric.receivedRecords === expectedRecords &&
        metric.missingRecords === 0 &&
        metric.startSample === capture.startSample &&
        metric.endSample === capture.endSample &&
        metric.nonSilent === true &&
        sameArrangementSource(metric.source, baseline.source),
      "Arrangement per-metric coverage/source differs",
    );
  }
  requireCondition(
    capture.cleanup.captureReleased === true &&
      capture.cleanup.sourceRestored === true &&
      capture.cleanup.transportPlaying ===
        (expected.playbackAfterCapture === "playing") &&
      capture.cleanup.failure === null,
    "Arrangement capture cleanup is not independently confirmed",
  );
}
export function verifyArrangementListening(
  input: AssertionInput,
  sourceId: string,
  hostSampleRate: number,
  metricRecords: Readonly<Record<string, ArrangementMetricRecordExpectation>>,
  playbackAfterCapture: "playing" | "stopped",
): void {
  const definition = input.fixture.arrangementSources?.find(
    (item) => item.id === sourceId,
  );
  const baseline = input.baseline.arrangementSources?.[sourceId];
  requireCondition(
    definition && baseline,
    "Missing Arrangement source evidence",
  );
  verifyArrangementSource(input.fixture, definition, baseline);
  const turns = input.turn ? [input.turn] : input.turns;
  const captures = turns.flatMap((turn) => turn.arrangementCaptures ?? []);
  requireCondition(
    captures.length === 1,
    "Arrangement smoke requires exactly one capture",
  );
  if (input.fixture.qualification === "reviewed-live")
    requireCondition(
      captures[0]?.stream !== undefined,
      "Reviewed Arrangement capture requires independently verified persisted original records",
    );
  requireCondition(
    turns.every((turn) => turn.captures.length === 0),
    "Unexpected Session capture during Arrangement smoke",
  );
  if (input.evidence)
    requireCondition(
      input.evidence.capturePassIds?.length === 1 &&
        input.evidence.capturePassIds[0] === captures[0]!.passId,
      "Final Arrangement pass inventory is missing or contains additional captures",
    );
  const owner = turns.find(
    (turn) => turn.operationId === captures[0]!.operationId,
  );
  requireCondition(
    owner &&
      owner.status === "completed" &&
      typeof owner.facts.sdkTurnId === "string" &&
      typeof owner.facts["arrangement.captureCausationId"] === "string",
    "Missing attributable Arrangement turn",
  );
  verifyArrangementCapture(captures[0]!, baseline, {
    operationId: owner.operationId,
    traceId: owner.facts.sdkTurnId,
    causationId: owner.facts["arrangement.captureCausationId"],
    tempoBpm: definition.tempoBpm,
    hostSampleRate,
    playbackAfterCapture,
    metricRecords,
  });
}
