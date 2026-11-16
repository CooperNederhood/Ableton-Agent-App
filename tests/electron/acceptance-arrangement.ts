import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  verifyArrangementSource,
  midiNotesSha256,
  type ArrangementFixtureSource,
  type ArrangementSourceEvidence,
  type DriverContext,
  type LifecycleEvent,
  type SetupEvidence,
  type Submission,
} from "@ableton-agent/test-support/integration";
import type { DesktopAppEvent } from "../../apps/desktop/src/contracts.js";
import { readAcceptanceProjectReferences } from "./acceptance-project.js";
import type {
  InspectArrangementListeningSourceResult,
  InspectArrangementListeningSourceParams,
  TransportOperationResult,
  MetricRecordStreamDescriptor,
  InspectMidiNotesResult,
} from "@ableton-agent/protocol";
import { midiNoteSchema } from "@ableton-agent/protocol";
import type {
  MetricCaptureRecord,
  MetricChunkPage,
} from "@ableton-agent/project-state";
import { metricChunkPageSchema } from "@ableton-agent/project-state";

/** Public typed read-only Desktop context boundary; no renderer filesystem or SQL access. */
export interface ArrangementContextReadApi {
  getMetricCapture(request: {
    sessionId: string;
    contextId: string;
  }): Promise<MetricCaptureRecord | undefined>;
  listMetricChunks(request: {
    sessionId: string;
    captureId: string;
    afterSequence?: number;
    limit: number;
    maxBytes: number;
  }): Promise<MetricChunkPage>;
}
export interface ArrangementLoadedReadApi {
  inspectArrangementListeningSource(
    request: InspectArrangementListeningSourceParams,
  ): Promise<InspectArrangementListeningSourceResult>;
}
export function arrangementCaptureToolCausation(
  events: readonly DesktopAppEvent[],
  owner: Submission & { sdkTurnId: string },
): string {
  const causes = events.flatMap((event) =>
    event.type === "approval.requested" &&
    event.operationId === owner.operationId &&
    event.appSessionId === owner.appSessionId &&
    event.agentInstanceId === owner.agentId &&
    event.sdkSessionId === owner.conversationId &&
    event.trace?.traceId === owner.sdkTurnId &&
    event.trace.correlationId === owner.sdkTurnId &&
    event.approval.tool?.name === "ableton_listening" &&
    event.approval.tool.action === "play-arrangement-and-listen"
      ? [event.trace.causationId]
      : [],
  );
  if (causes.length !== 1)
    throw new Error(
      "Missing or ambiguous attributable Arrangement capture tool call",
    );
  return causes[0]!;
}
export function arrangementSourceStateAllowed(
  state: Pick<
    InspectArrangementListeningSourceResult["before"],
    | "arrangementEligible"
    | "globalBackToArrangement"
    | "playingSessionClips"
    | "queuedSessionClips"
  >,
  allowSessionOverride: boolean,
  ownsStoppedSessionOverride: boolean,
): boolean {
  return (
    state.arrangementEligible === true ||
    (allowSessionOverride &&
      (state.arrangementEligible === false ||
        (ownsStoppedSessionOverride &&
          state.arrangementEligible === null &&
          state.globalBackToArrangement === true &&
          state.playingSessionClips === 0 &&
          state.queuedSessionClips === 0)))
  );
}

export function arrangementOwnerReleased(
  attributes: Readonly<Record<string, unknown>>,
  ownership: MetricRecordStreamDescriptor["ownership"],
): boolean {
  const rows = attributes.listeners;
  return (
    attributes.passId === ownership.passId &&
    attributes.cleanupPolicy === "leave-running" &&
    attributes.sourceOwnership === "authenticated-listener-registry" &&
    attributes.listenerOwnerReleased === true &&
    Array.isArray(rows) &&
    rows.length === 1 &&
    rows.some(
      (row: unknown) =>
        row !== null &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        ["listenerId", "connectionId", "connectionEpoch"].every(
          (field) =>
            Object.prototype.hasOwnProperty.call(row, field) &&
            Reflect.get(row, field) === Reflect.get(ownership, field),
        ) &&
        ["generation", "nativeEpoch"].every(
          (field) =>
            Object.prototype.hasOwnProperty.call(row, field) &&
            Reflect.get(row, field) === Reflect.get(ownership, field),
        ),
    )
  );
}

export async function* readArrangementMetricChunks(
  read: ArrangementContextReadApi["listMetricChunks"],
  input: {
    sessionId: string;
    captureId: string;
    signal: AbortSignal;
    deadlineAt: number;
  },
) {
  let afterSequence = -1;
  for (let count = 0; count < 4096; count++) {
    input.signal.throwIfAborted();
    if (Date.now() >= input.deadlineAt)
      throw new Error("Arrangement chunk read deadline exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let raw: unknown;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => {
          input.signal.throwIfAborted();
          return read({
            sessionId: input.sessionId,
            captureId: input.captureId,
            afterSequence,
            limit: 16,
            maxBytes: 1024 * 1024,
          });
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("Arrangement chunk read cancelled"));
          input.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(
            () => reject(new Error("Arrangement chunk read deadline exceeded")),
            Math.max(1, input.deadlineAt - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) input.signal.removeEventListener("abort", onAbort);
    }
    const result = metricChunkPageSchema.parse(raw);
    input.signal.throwIfAborted();
    if (result.encodedBytes !== Buffer.byteLength(JSON.stringify(result.items)))
      throw new Error("Arrangement chunk page byte evidence differs");
    for (const chunk of result.items) yield chunk;
    if (result.nextSequence === undefined) return;
    if (!result.items.length || result.nextSequence <= afterSequence)
      throw new Error("Arrangement chunk cursor is nonmonotone or duplicated");
    afterSequence = result.nextSequence;
  }
  throw new Error("Arrangement chunk page inventory exceeds bound");
}

/** Constant saved tempo envelope plus independently loaded tempo/native extrema, never an inferred global record state. */
export function verifySavedArrangementTempo(
  bytes: Uint8Array,
  tempoBpm: number,
): void {
  readAcceptanceProjectReferences(bytes);
  const xml = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString(
    "utf8",
  );
  const tempos = [...xml.matchAll(/<Tempo>([\s\S]*?)<\/Tempo>/gu)];
  if (
    tempos.length !== 1 ||
    Number(/<Manual Value="([^"]+)"/u.exec(tempos[0]![1]!)?.[1]) !== tempoBpm
  )
    throw new Error("Saved tempo differs from approved fixed tempo");
  const target = /<AutomationTarget Id="(\d+)"/u.exec(tempos[0]![1]!)?.[1];
  if (!target) throw new Error("Saved tempo automation target missing");
  for (const match of xml.matchAll(
    /<AutomationEnvelope\b[^>]*>([\s\S]*?)<\/AutomationEnvelope>/gu,
  )) {
    if (!match[1]!.includes(`<PointeeId Value="${target}"`)) continue;
    const events = /<Events>([\s\S]*?)<\/Events>/u.exec(match[1]!)?.[1];
    if (!events)
      throw new Error("Saved tempo envelope has no inspectable events");
    const tags = [...events.matchAll(/<([A-Za-z]+)\b([^>]*)\/>/gu)];
    if (
      !tags.length ||
      tags.some(
        (tag) =>
          tag[1] !== "FloatEvent" ||
          Number(/\bValue="([^"]+)"/u.exec(tag[2]!)?.[1]) !== tempoBpm,
      )
    )
      throw new Error("Saved tempo automation is not constant");
  }
}

function assertLoadedArrangementState(
  state: InspectArrangementListeningSourceResult["before"],
  clips: InspectArrangementListeningSourceResult["clips"],
  requireArrangementSource = true,
  rememberedSessionClipCount = 0,
): asserts state is InspectArrangementListeningSourceResult["before"] & {
  currentBeat: number;
  tempoBpm: number;
  targetArmed: boolean;
  globalBackToArrangement: boolean;
} {
  if (
    state.transportPlaying !== false ||
    state.loopEnabled !== false ||
    state.arrangementRecord !== false ||
    state.sessionRecord !== false ||
    state.overdub !== false ||
    state.sessionAutomationRecord !== false ||
    (requireArrangementSource
      ? state.globalBackToArrangement !== false
      : typeof state.globalBackToArrangement !== "boolean") ||
    !(
      state.targetMonitoring === 2 ||
      (state.targetMonitoring === 1 && state.targetArmed === false)
    ) ||
    (requireArrangementSource && state.arrangementEligible !== true) ||
    typeof state.targetArmed !== "boolean" ||
    state.currentBeat === null ||
    state.tempoBpm === null ||
    state.playingSessionClips !== rememberedSessionClipCount ||
    state.queuedSessionClips !== 0 ||
    clips.some((clip) => clip.recording !== false)
  )
    throw new Error(
      `Loaded Arrangement state unavailable, recording, overridden, queued, or not stopped: ${JSON.stringify(
        {
          ...state,
          recordingClipCount: clips.filter((clip) => clip.recording !== false)
            .length,
        },
      )}`,
    );
}

export async function handoffArrangementSource(input: {
  read(): Promise<InspectArrangementListeningSourceResult>;
  restore(): Promise<TransportOperationResult>;
  signal: AbortSignal;
  rememberedSessionClipCount?: number;
}): Promise<NonNullable<SetupEvidence["arrangementSource"]>> {
  input.signal.throwIfAborted();
  const remembered = input.rememberedSessionClipCount ?? 0;
  if (!Number.isInteger(remembered) || remembered < 0 || remembered > 8)
    throw new Error("Invalid owned remembered Session count");
  const before = await input.read();
  assertLoadedArrangementState(before.before, before.clips, false, remembered);
  if (JSON.stringify(before.before) !== JSON.stringify(before.after))
    throw new Error("Arrangement source changed during handoff admission");
  input.signal.throwIfAborted();
  const result = await input.restore();
  if (
    result.action !== "back-to-arrangement" ||
    !("before" in result) ||
    result.verified !== true ||
    result.before.isPlaying !== false ||
    result.after.isPlaying !== false ||
    result.before.backToArrangement !== before.after.globalBackToArrangement ||
    result.after.backToArrangement !== false
  )
    throw new Error("Arrangement source handoff was not verified");
  if (
    JSON.stringify({ ...result.before, backToArrangement: false }) !==
    JSON.stringify(result.after)
  )
    throw new Error("Arrangement handoff changed protected transport state");
  input.signal.throwIfAborted();
  const after = await input.read();
  for (const state of [after.before, after.after])
    assertLoadedArrangementState(state, after.clips);
  const unaffected = (
    state: InspectArrangementListeningSourceResult["before"],
  ) => ({
    ...state,
    globalBackToArrangement: false,
    arrangementEligible: false,
    playingSessionClips: 0,
  });
  if (
    JSON.stringify(before.clips) !== JSON.stringify(after.clips) ||
    JSON.stringify(unaffected(before.after)) !==
      JSON.stringify(unaffected(after.before)) ||
    JSON.stringify(after.before) !== JSON.stringify(after.after) ||
    JSON.stringify(before.track) !== JSON.stringify(after.track) ||
    JSON.stringify(before.range) !== JSON.stringify(after.range) ||
    before.projectPath !== after.projectPath
  )
    throw new Error("Arrangement handoff changed protected source state");
  input.signal.throwIfAborted();
  return {
    command: "transport.back_to_arrangement",
    dispatchedCount: 1,
    beforeBackToArrangement: before.before.globalBackToArrangement,
    afterBackToArrangement: false,
    transportStopped: true,
    verified: true,
  };
}

export function loadedArrangementState(
  state: InspectArrangementListeningSourceResult["before"],
  clips: InspectArrangementListeningSourceResult["clips"],
  expectedBackToArrangement = false,
): ArrangementSourceEvidence["before"] {
  assertLoadedArrangementState(state, clips, !expectedBackToArrangement);
  if (state.globalBackToArrangement !== expectedBackToArrangement)
    throw new Error(
      "Loaded Arrangement override differs from reviewed baseline",
    );
  return {
    tempoBpm: state.tempoBpm,
    tempoAutomation: false,
    currentBeat: state.currentBeat,
    transportPlaying: false,
    loopEnabled: false,
    arrangementRecord: false,
    sessionRecord: false,
    targetRecording: false,
    targetArmed: state.targetArmed,
    targetMonitoring: state.targetMonitoring === 1 ? "auto" : "off",
    backToArrangement: state.globalBackToArrangement,
    playingSessionClips: 0,
    queuedSessionClips: 0,
  };
}

/** Saved ranges/media references only; not a substitute for loaded global record reads. */
export function readSavedArrangementSource(
  bytes: Uint8Array,
  trackIndex: number,
  trackName: string,
  range?: { startBeat: number; endBeat: number },
): {
  readonly savedProjectSha256: string;
  readonly creator: string;
  readonly savedClips: ArrangementSourceEvidence["savedClips"];
} {
  readAcceptanceProjectReferences(bytes);
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > 255)
    throw new Error("Invalid saved Arrangement track index");
  const xml = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString(
    "utf8",
  );
  const creator = /<Ableton\b[^>]*\bCreator="([^"]+)"/u.exec(xml)?.[1];
  if (!creator || !/^Ableton Live 11\.\d+\.\d+$/u.test(creator))
    throw new Error("Saved Arrangement inspection requires Live 11 provenance");
  const stack: string[] = [];
  let track = -1;
  const names: string[] = [];
  const clips: {
    savedClipId: string;
    mediaTarget: string | null;
    midiNotesSha256?: string;
    startBeat: number;
    endBeat: number;
  }[] = [];
  let active:
    | { id: string; kind: string; offset: number; values: Map<string, string> }
    | undefined;
  for (const match of xml.matchAll(
    /<\/?([A-Za-z][A-Za-z0-9_]*)(?:\s[^<>]*?)?\/?>/gu,
  )) {
    const tag = match[0],
      name = match[1]!;
    if (tag.startsWith("</")) {
      if (stack.pop() !== name)
        throw new Error("Unbalanced saved Arrangement document");
      if (active && name === active.kind) {
        const get = (path: string) => {
          const value = active!.values.get(path);
          if (value === undefined)
            throw new Error("Missing saved Arrangement clip field");
          return value;
        };
        const mediaTarget =
          name === "MidiClip" ? null : get("SampleRef/FileRef/RelativePath");
        if (
          mediaTarget !== null &&
          (get("SampleRef/FileRef/RelativePathType") !== "3" ||
            !mediaTarget ||
            /[\\:\0]/u.test(mediaTarget) ||
            mediaTarget.startsWith("/") ||
            mediaTarget
              .split("/")
              .some((part) => !part || part === "." || part === ".."))
        )
          throw new Error("Saved Arrangement media is not project-local");
        const startBeat = Number(get("CurrentStart")),
          endBeat = Number(get("CurrentEnd"));
        if (
          !Number.isFinite(startBeat) ||
          !Number.isFinite(endBeat) ||
          startBeat < 0 ||
          endBeat <= startBeat ||
          endBeat > 1_576_800
        )
          throw new Error("Invalid saved Arrangement clip range");
        if (!range || (endBeat > range.startBeat && startBeat < range.endBeat))
          clips.push({
            savedClipId: active.id,
            mediaTarget,
            startBeat,
            endBeat,
            ...(name === "MidiClip"
              ? {
                  midiNotesSha256: readSavedMidiNotesHash(
                    xml.slice(active.offset, match.index),
                  ),
                }
              : {}),
          });
        if (clips.length > 256)
          throw new Error("Saved Arrangement clip bound exceeded");
        active = undefined;
      }
      continue;
    }
    if (
      stack.join("/") === "Ableton/LiveSet/Tracks" &&
      /^(Audio|Midi|Group)Track$/u.test(name)
    )
      track++;
    const selected =
      track === trackIndex && /^(Audio|Midi)Track$/u.test(stack[3] ?? "");
    const parent = stack.slice(4).join("/");
    if (selected && parent === "Name" && name === "EffectiveName")
      names.push(decode(/\sValue="([^"]*)"/u.exec(tag)?.[1] ?? ""));
    if (
      selected &&
      ((parent ===
        "DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events" &&
        name === "AudioClip") ||
        (parent ===
          "DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events" &&
          name === "MidiClip"))
    ) {
      const id = /\sId="(\d+)"/u.exec(tag)?.[1];
      if (!id || active) throw new Error("Ambiguous saved Arrangement clip");
      active = { id, kind: name, offset: match.index, values: new Map() };
    } else if (active) {
      const clipAt = stack.indexOf(active.kind);
      const value = /\sValue="([^"]*)"/u.exec(tag)?.[1];
      const path = [...stack.slice(clipAt + 1), name].join("/");
      if (
        value !== undefined &&
        [
          "CurrentStart",
          "CurrentEnd",
          "SampleRef/FileRef/RelativePath",
          "SampleRef/FileRef/RelativePathType",
        ].includes(path)
      ) {
        if (active.values.has(path))
          throw new Error("Duplicate saved Arrangement field");
        active.values.set(path, decode(value));
      }
    }
    if (!tag.endsWith("/>")) stack.push(name);
    if (stack.length > 128)
      throw new Error("Saved Arrangement nesting bound exceeded");
  }
  if (
    stack.length ||
    active ||
    names.length !== 1 ||
    names[0] !== trackName ||
    !clips.length ||
    new Set(clips.map((clip) => clip.savedClipId)).size !== clips.length
  )
    throw new Error("Missing or ambiguous saved Arrangement source");
  return {
    creator,
    savedProjectSha256: createHash("sha256").update(bytes).digest("hex"),
    savedClips: clips,
  };
}
function readSavedMidiNotesHash(xml: string): string {
  const notes: InspectMidiNotesResult["notes"] = [];
  for (const match of xml.matchAll(
    /<KeyTrack\b[^>]*>([\s\S]*?)<\/KeyTrack>/gu,
  )) {
    const track = match[1]!;
    const keys = [...track.matchAll(/<MidiKey Value="([^"]+)"\s*\/>/gu)];
    if (keys.length !== 1)
      throw new Error("Missing or ambiguous saved MIDI pitch");
    for (const note of track.matchAll(/<MidiNoteEvent\b([^>]*)\/>/gu)) {
      const attr = (name: string) => {
        const value = new RegExp(`\\b${name}="([^"]+)"`, "u").exec(
          note[1]!,
        )?.[1];
        if (value === undefined)
          throw new Error("Missing saved MIDI note field");
        return value;
      };
      const enabled = attr("IsEnabled");
      if (enabled !== "true" && enabled !== "false")
        throw new Error("Invalid saved MIDI note mute");
      notes.push(
        midiNoteSchema.parse({
          pitch: Number(keys[0]![1]),
          startTime: Number(attr("Time")),
          duration: Number(attr("Duration")),
          velocity: Number(attr("Velocity")),
          mute: enabled === "false",
        }),
      );
      if (notes.length > 2048)
        throw new Error("Saved MIDI note bound exceeded");
    }
  }
  return midiNotesSha256(notes);
}

function decode(value: string): string {
  if (/&(?!amp;|quot;|apos;|lt;|gt;)/u.test(value))
    throw new Error("Unsupported saved Arrangement entity");
  return value.replace(
    /&(amp|quot|apos|lt|gt);/gu,
    (_, entity: string) =>
      ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity]!,
  );
}

export interface ArrangementEvidenceReads {
  /** Must use the verified loaded/prepared Set bytes, never fixture expectations. */
  saved(
    this: void,
    context: DriverContext,
  ): Promise<
    Pick<ArrangementSourceEvidence, "savedProjectSha256" | "savedClips">
  >;
  /** Missing public typed loaded source/recording reads must fail, not infer defaults. */
  loaded(
    this: void,
    context: DriverContext,
  ): Promise<
    Omit<
      ArrangementSourceEvidence,
      "savedProjectSha256" | "savedClips" | "media"
    >
  >;
  /** Independently verify owned path, bytes/hash and media header sample rate. */
  media(
    this: void,
    context: DriverContext,
  ): Promise<ArrangementSourceEvidence["media"]>;
  /** Release observers/handles even when admission fails or is cancelled. */
  close(this: void): Promise<void>;
}
/** Adapter seam only: production typed Arrangement reads are not wired yet. */
export async function readArrangementAcceptanceSource(
  context: DriverContext,
  definition: ArrangementFixtureSource,
  reads: ArrangementEvidenceReads,
  emit: (event: LifecycleEvent) => void,
): Promise<ArrangementSourceEvidence> {
  const began = Date.now();
  const event = (stage: string, phase: LifecycleEvent["phase"]) =>
    emit({
      schemaVersion: 1,
      runId: context.runId,
      traceId: context.traceId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      stage,
      phase,
      timestamp: Date.now(),
      durationMs: Math.max(0, Date.now() - began),
    });
  const check = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= context.deadlineAt)
      throw new Error("Arrangement evidence deadline exceeded");
  };
  const bounded = async <T>(
    action: () => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Arrangement evidence deadline exceeded")),
            Math.max(0, timeoutMs),
          );
          if (signal) {
            abort = () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("Arrangement evidence cancelled"),
              );
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && abort) signal.removeEventListener("abort", abort);
    }
  };
  const read = <T>(action: () => Promise<T>) =>
    bounded(action, context.deadlineAt - Date.now(), context.signal);
  event("arrangement.preconditions", "queued");
  event("arrangement.preconditions", "started");
  let evidence: ArrangementSourceEvidence | undefined;
  let failure: unknown;
  try {
    check();
    const saved = await read(() => reads.saved(context));
    check();
    event("arrangement.preconditions", "progress");
    const loaded = await read(() => reads.loaded(context));
    check();
    event("arrangement.preconditions", "progress");
    const media = await read(() => reads.media(context));
    check();
    evidence = { ...loaded, ...saved, media };
    const expectedProject =
      context.dependencyInventory?.preparedProject?.sha256 ??
      context.fixture.resources.find((item) => item.target === "project.als")
        ?.sha256;
    if (evidence.savedProjectSha256 !== expectedProject)
      throw new Error(
        "Inspected saved Arrangement Set differs from verified staged/prepared Set",
      );
    verifyArrangementSource(context.fixture, definition, evidence);
  } catch (error) {
    failure = error;
  }
  event("arrangement.preconditions.cleanup", "queued");
  event("arrangement.preconditions.cleanup", "started");
  try {
    await bounded(() => reads.close(), context.scenario.budget.cleanupMs);
    event("arrangement.preconditions.cleanup", "completed");
  } catch (error) {
    event("arrangement.preconditions.cleanup", "failed");
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Arrangement evidence and cleanup failed",
        )
      : error;
  }
  if (failure === undefined) {
    try {
      check();
    } catch (error) {
      failure = error;
    }
  }
  if (failure !== undefined) {
    event(
      "arrangement.preconditions",
      context.signal.aborted ? "cancelled" : "failed",
    );
    throw failure instanceof Error
      ? failure
      : new Error("Arrangement evidence read failed");
  }
  event("arrangement.preconditions", "completed");
  return evidence!;
}
