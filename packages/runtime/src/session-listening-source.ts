import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ListeningPassContext } from "@ableton-agent/application";
import {
  captureFailureEvidence,
  denyListening as deny,
  failureFact,
  ListeningRuntimeRejection,
} from "./listening-failure.js";
import {
  inspectSessionListeningSourceResultSchema,
  type InspectSessionListeningSourceParams,
  type InspectSessionListeningSourceResult,
  type NativeListeningGeometry,
  readListeningFailureEvidence,
  type ListeningFailureEvidence,
} from "@ableton-agent/protocol";

type Source = InspectSessionListeningSourceResult;
type Target = InspectSessionListeningSourceParams["target"];

export function immutableSessionEvidence(
  evidence: ListeningFailureEvidence,
): ListeningFailureEvidence {
  const freeze = (value: object): void => {
    for (const child of Object.values(value) as unknown[])
      if (child !== null && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(evidence);
  return evidence;
}

export function attributeSessionRejection(
  error: unknown,
  pass: ListeningPassContext,
  phase: ListeningFailureEvidence["phase"],
  signal?: AbortSignal,
): void {
  if (
    !(error instanceof Error) ||
    !Object.isExtensible(error) ||
    readListeningFailureEvidence(error).status !== "absent"
  )
    return;
  let rejection: unknown = error;
  for (let depth = 0; depth < 8; depth++) {
    if (rejection instanceof ListeningRuntimeRejection) {
      const facts = rejection.rejectionFacts;
      const truncated = facts.some(
        (fact) =>
          ["source.omittedChangeCount", "schema.omittedIssueCount"].includes(
            fact.field,
          ) &&
          fact.actual.state === "observed" &&
          typeof fact.actual.value === "number" &&
          fact.actual.value > 0,
      );
      const partial = facts.some((fact) => fact.actual.state === "unavailable");
      const evidence = immutableSessionEvidence(
        captureFailureEvidence({
          code: rejection.code,
          message: rejection.message,
          phase,
          component: "session-source",
          checkId: `session.${phase}.${rejection.code}`,
          trace: pass.trace,
          passId: pass.passId,
          facts,
          coverage: partial || truncated ? "partial" : "complete",
          coverageReasons: [
            ...(partial ? ["missing-operands" as const] : []),
            ...(truncated ? ["diagnostic-truncated" as const] : []),
          ],
        }),
      );
      Object.defineProperty(error, "failureEvidence", {
        value: evidence,
        writable: false,
        configurable: false,
      });
      return;
    }
    if (!(rejection instanceof Error)) break;
    rejection =
      rejection instanceof AggregateError
        ? rejection.errors[0]
        : Object.getOwnPropertyDescriptor(rejection, "cause")?.value;
  }
  if (signal?.aborted) {
    const evidence = immutableSessionEvidence(
      captureFailureEvidence({
        code: "cancelled",
        message: "Session operation cancelled",
        phase,
        component: "session-source",
        checkId: `session.${phase}.cancelled`,
        trace: pass.trace,
        passId: pass.passId,
        facts: [failureFact("signal.aborted", signal.aborted, false)],
        coverage: "complete",
        coverageReasons: [],
      }),
    );
    Object.defineProperty(error, "failureEvidence", {
      value: evidence,
      writable: false,
      configurable: false,
    });
  }
}

export interface SessionSourceExpectation {
  readonly source: Readonly<Source>;
  readonly startBeat: number;
  readonly endBeat: number;
  readonly durationBeats: number;
  readonly firstIterationEndBeat: number;
  readonly fingerprint: string;
  readonly followActions: "disabled" | "unknown";
  readonly limitations: readonly string[];
}

export interface SessionSourceOrigin {
  readonly clipReference: string;
  readonly playingSlotIndex: number;
  readonly clipStartTimeBeats: number;
  readonly observedAtGlobalBeat: number;
}

/** Preserve validator error identity while exposing the rejected predicate to stage(). */
export function validateSessionEvidence<T>(
  check: string,
  operation: () => T,
  raw?: unknown,
): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      Object.isExtensible(error) &&
      !Object.getOwnPropertyDescriptor(error, "cause")
    ) {
      const issues: unknown = Object.getOwnPropertyDescriptor(
        error,
        "issues",
      )?.value;
      const facts = [failureFact("schema.valid", false, true)];
      if (Array.isArray(issues)) {
        for (const [index, issue] of issues.slice(0, 5).entries()) {
          if (issue === null || typeof issue !== "object") continue;
          const item = issue as Record<string, unknown>;
          const path = Array.isArray(item.path) ? item.path : [];
          let actual = raw;
          for (const key of path) {
            if (
              actual === null ||
              typeof actual !== "object" ||
              (typeof key !== "string" && typeof key !== "number")
            ) {
              actual = undefined;
              break;
            }
            actual = Object.getOwnPropertyDescriptor(actual, key)?.value;
          }
          const values = Array.isArray(item.values) ? item.values : [];
          const expected: unknown =
            values.length === 1
              ? values[0]
              : (item.expected ?? item.minimum ?? item.maximum);
          facts.push(
            failureFact(`schema.issue.${index}.path`, path.join(".")),
            failureFact(`schema.issue.${index}.code`, item.code),
            failureFact(
              `schema.issue.${index}.value`,
              actual,
              expected,
              typeof item.minimum === "number"
                ? { comparison: "at-least" }
                : typeof item.maximum === "number"
                  ? { comparison: "at-most" }
                  : {},
            ),
            failureFact(`schema.issue.${index}.rule`, item.message),
          );
        }
        if (issues.length > 5)
          facts.push(
            failureFact("schema.omittedIssueCount", issues.length - 5),
          );
      }
      Object.defineProperty(error, "cause", {
        value: new ListeningRuntimeRejection(check, undefined, facts),
        configurable: true,
      });
    }
    throw error;
  }
}

export function assertSessionSignal(signal: AbortSignal, check: string): void {
  if (!signal.aborted) return;
  try {
    signal.throwIfAborted();
  } catch (error) {
    if (
      error instanceof Error &&
      Object.isExtensible(error) &&
      !Object.getOwnPropertyDescriptor(error, "cause")
    )
      Object.defineProperty(error, "cause", {
        value: new ListeningRuntimeRejection("cancelled", undefined, [
          failureFact("signal.aborted", signal.aborted, false),
          failureFact("signal.check", check),
        ]),
      });
    throw error;
  }
}

function fingerprint(source: Source): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: source.target,
        kind: source.sourceKind,
        unit: source.positionUnit,
        settings: source.settings,
      }),
    )
    .digest("hex");
}

/** Frozen source expectations precede launch; deferred metadata is not timing proof. */
export function freezeSessionSourceExpectation(
  raw: Source,
  target: Target,
  requestedDurationBeats?: number,
): Readonly<SessionSourceExpectation> {
  const source = validateSessionEvidence(
    "session.source.schema",
    () => inspectSessionListeningSourceResultSchema.parse(raw),
    raw,
  );
  if (!isDeepStrictEqual(source.target, target))
    deny("stale_session_target", undefined, [
      ...(
        ["expectedClipReference", "expectedClipName", "sceneIndex"] as const
      ).map((key) =>
        failureFact(`source.target.${key}`, source.target[key], target[key]),
      ),
      ...(["kind", "index", "expectedReference", "expectedName"] as const).map(
        (key) =>
          failureFact(
            `source.target.track.${key}`,
            source.target.track[key],
            target.track[key],
          ),
      ),
    ]);
  if (
    (requestedDurationBeats !== undefined &&
      (!Number.isFinite(requestedDurationBeats) ||
        requestedDurationBeats <= 0)) ||
    !["midi", "warped-audio"].includes(source.sourceKind) ||
    source.positionUnit !== "beats"
  )
    deny(
      "unsupported_session_source",
      "Session listening supports positive beat ranges for MIDI and warped audio.",
      [
        failureFact(
          "request.durationBeats",
          requestedDurationBeats,
          "positive finite or omitted",
          { unit: "beats" },
        ),
        failureFact("source.kind", source.sourceKind, "midi|warped-audio"),
        failureFact("source.positionUnit", source.positionUnit, "beats"),
      ],
    );
  const { before, after, settings } = source;
  if (
    [before, after].some(
      (state) =>
        state.transportPlaying !== false ||
        state.targetPlaying !== false ||
        state.targetTriggered !== false ||
        state.targetRecording !== false ||
        state.firedSlotIndex !== -1 ||
        state.playingSlotIndex === null ||
        state.globalBeat === null ||
        state.globalBeat < 0,
    )
  )
    deny(
      "session_launch_state_unknown_or_active",
      "Transport must be stopped with known recording-off clip state and no queued launch; nothing was launched.",
      (["before", "after"] as const).flatMap((phase) => {
        const state = source[phase];
        return [
          ...(
            [
              "transportPlaying",
              "targetPlaying",
              "targetTriggered",
              "targetRecording",
            ] as const
          ).map((key) =>
            failureFact(`source.${phase}.${key}`, state[key], false),
          ),
          failureFact(
            `source.${phase}.firedSlotIndex`,
            state.firedSlotIndex,
            -1,
          ),
          failureFact(
            `source.${phase}.playingSlotIndex`,
            state.playingSlotIndex,
            "known",
          ),
          failureFact(`source.${phase}.globalBeat`, state.globalBeat, 0, {
            comparison: "at-least",
            unit: "beats",
          }),
        ];
      }),
    );
  if (before.globalBeat !== after.globalBeat)
    deny("session_transport_changed", undefined, [
      failureFact(
        "source.after.globalBeat",
        after.globalBeat,
        before.globalBeat,
        { unit: "beats" },
      ),
    ]);
  const startBeat = after.globalBeat!;
  if (
    settings.tempoBpm === null ||
    settings.signatureNumerator !== 4 ||
    settings.signatureDenominator !== 4 ||
    settings.launchMode !== 0 ||
    settings.legato !== false ||
    settings.launchQuantization !== 0 ||
    (settings.globalQuantization !== 0 && settings.globalQuantization !== 4) ||
    settings.startMarker !== 0 ||
    settings.loopStart !== 0 ||
    settings.looping === null ||
    settings.endMarker === null ||
    settings.loopEnd === null
  )
    deny(
      "unsupported_session_launch_settings",
      "Requires Trigger mode, legato off, clip Global quantization, a qualified global launch case in 4/4, and zero start/loop offsets. No settings were changed.",
      [
        failureFact("source.settings.tempoBpm", settings.tempoBpm, "known"),
        ...(["signatureNumerator", "signatureDenominator"] as const).map(
          (key) => failureFact(`source.settings.${key}`, settings[key], 4),
        ),
        ...(
          [
            "launchMode",
            "launchQuantization",
            "startMarker",
            "loopStart",
          ] as const
        ).map((key) => failureFact(`source.settings.${key}`, settings[key], 0)),
        failureFact("source.settings.legato", settings.legato, false),
        failureFact(
          "source.settings.globalQuantization",
          settings.globalQuantization,
          "0|4",
        ),
        ...(["looping", "endMarker", "loopEnd"] as const).map((key) =>
          failureFact(`source.settings.${key}`, settings[key], "known"),
        ),
      ],
    );
  if (settings.followActionEnabled === true)
    deny(
      "session_follow_actions_enabled",
      "Known-enabled follow actions are unsupported. No clip was launched or edited.",
      [
        failureFact(
          "source.settings.followActionEnabled",
          settings.followActionEnabled,
          "false|unknown",
        ),
      ],
    );
  if (startBeat !== 0 || settings.globalQuantization !== 0)
    deny(
      "session_launch_case_unqualified",
      "Only global None from stopped beat zero has real-host Session qualification. One-bar and nonzero stopped anchors are refused; the App does not seek or change launch settings.",
      [
        failureFact("source.startBeat", startBeat, 0, { unit: "beats" }),
        failureFact(
          "source.settings.globalQuantization",
          settings.globalQuantization,
          0,
        ),
      ],
    );
  const firstIterationEndBeat = settings.looping
    ? settings.loopEnd
    : settings.endMarker;
  const durationBeats = requestedDurationBeats ?? firstIterationEndBeat;
  if (firstIterationEndBeat < durationBeats)
    deny(
      "session_first_iteration_exceeded",
      "Capture exceeds the active loop or nonlooping start/end region; it was not silently shortened.",
      [
        failureFact(
          "request.durationBeats",
          durationBeats,
          firstIterationEndBeat,
          { comparison: "at-most", unit: "beats" },
        ),
      ],
    );
  if ((durationBeats * 60) / settings.tempoBpm > 30)
    deny(
      "native_capture_quota",
      "The full requested range exceeds thirty seconds; it was not truncated.",
      [
        failureFact(
          "capture.durationMs",
          (durationBeats * 60_000) / settings.tempoBpm,
          30_000,
          { comparison: "at-most", unit: "ms" },
        ),
        failureFact("request.durationBeats", durationBeats, undefined, {
          unit: "beats",
        }),
        failureFact("source.settings.tempoBpm", settings.tempoBpm),
      ],
    );
  Object.freeze(source.target.track);
  Object.freeze(source.target);
  Object.freeze(source.before);
  Object.freeze(source.after);
  Object.freeze(source.settings);
  Object.freeze(source);
  const followActions =
    settings.followActionEnabled === false ? "disabled" : "unknown";
  return Object.freeze({
    source,
    startBeat,
    endBeat: startBeat + durationBeats,
    durationBeats,
    firstIterationEndBeat,
    fingerprint: fingerprint(source),
    followActions,
    limitations: Object.freeze([
      "Clip launch and continuity use message-rate LOM evidence, not sample-accurate source identity.",
      "The listener signal can contain instrument/effect latency, tails, inputs and routed contributors.",
      ...(followActions === "unknown"
        ? [
            "Follow-action settings are unavailable; observed source changes invalidate the pass, but changes between deferred observations may not be detected.",
          ]
        : []),
    ]),
  });
}

export function assertSessionSourceUnchanged(
  expected: SessionSourceExpectation,
  latest: Source,
): void {
  const current = validateSessionEvidence(
    "session.source.continuity.schema",
    () => inspectSessionListeningSourceResultSchema.parse(latest),
    latest,
  );
  const actualFingerprint = fingerprint(current);
  if (actualFingerprint !== expected.fingerprint) {
    const changes = [
      ...(
        ["expectedClipReference", "expectedClipName", "sceneIndex"] as const
      ).map((key) =>
        failureFact(
          `source.target.${key}`,
          current.target[key],
          expected.source.target[key],
        ),
      ),
      ...(["kind", "index", "expectedReference", "expectedName"] as const).map(
        (key) =>
          failureFact(
            `source.target.track.${key}`,
            current.target.track[key],
            expected.source.target.track[key],
          ),
      ),
      failureFact(
        "source.kind",
        current.sourceKind,
        expected.source.sourceKind,
      ),
      failureFact(
        "source.positionUnit",
        current.positionUnit,
        expected.source.positionUnit,
      ),
      ...(Object.keys(current.settings) as (keyof Source["settings"])[]).map(
        (key) =>
          failureFact(
            `source.settings.${key}`,
            current.settings[key],
            expected.source.settings[key],
          ),
      ),
    ].filter((fact) => !isDeepStrictEqual(fact.actual, fact.expected));
    deny("session_source_changed", undefined, [
      failureFact(
        "source.fingerprint",
        actualFingerprint,
        expected.fingerprint,
      ),
      ...changes.slice(0, 22),
      ...(changes.length > 22
        ? [failureFact("source.omittedChangeCount", changes.length - 22)]
        : []),
    ]);
  }
}

export function assertSessionFirstIterationCoverage(
  expected: SessionSourceExpectation,
  geometry: Pick<
    NativeListeningGeometry,
    "startBeat" | "endBeat" | "tempoBpm" | "totalSamples" | "sampleRate"
  >,
): void {
  const actualBeats =
    geometry.totalSamples / ((geometry.sampleRate * 60) / geometry.tempoBpm);
  if (
    geometry.startBeat !== expected.startBeat ||
    geometry.endBeat !== expected.endBeat ||
    geometry.tempoBpm !== expected.source.settings.tempoBpm ||
    actualBeats - expected.firstIterationEndBeat >
      geometry.tempoBpm / (120 * geometry.sampleRate) + 1e-10
  )
    deny(
      "session_first_iteration_exceeded",
      "The native sample-rounded range would cross the first clip iteration; no clip was launched.",
      [
        failureFact(
          "geometry.startBeat",
          geometry.startBeat,
          expected.startBeat,
          { unit: "beats" },
        ),
        failureFact("geometry.endBeat", geometry.endBeat, expected.endBeat, {
          unit: "beats",
        }),
        failureFact(
          "geometry.tempoBpm",
          geometry.tempoBpm,
          expected.source.settings.tempoBpm,
        ),
        failureFact(
          "geometry.iterationExcessBeats",
          actualBeats - expected.firstIterationEndBeat,
          geometry.tempoBpm / (120 * geometry.sampleRate) + 1e-10,
          { comparison: "at-most", unit: "beats" },
        ),
        failureFact("geometry.totalSamples", geometry.totalSamples, undefined, {
          unit: "samples",
        }),
        failureFact("geometry.sampleRate", geometry.sampleRate),
      ],
    );
}

export function assertTransportCoupledSessionOrigin(
  expected: SessionSourceExpectation,
  origin: SessionSourceOrigin,
): void {
  if (
    origin.clipReference !== expected.source.target.expectedClipReference ||
    origin.playingSlotIndex !== expected.source.target.sceneIndex ||
    !Number.isFinite(origin.clipStartTimeBeats) ||
    Math.abs(origin.clipStartTimeBeats - expected.startBeat) > 1e-8 ||
    !Number.isFinite(origin.observedAtGlobalBeat) ||
    origin.observedAtGlobalBeat < expected.startBeat ||
    origin.observedAtGlobalBeat >=
      expected.startBeat + expected.firstIterationEndBeat
  )
    deny(
      "session_native_origin_mismatch",
      "The observed clip/source epoch did not match the frozen native transport anchor. No context was published; playback is left running.",
      [
        failureFact(
          "origin.clipReference",
          origin.clipReference,
          expected.source.target.expectedClipReference,
        ),
        failureFact(
          "origin.playingSlotIndex",
          origin.playingSlotIndex,
          expected.source.target.sceneIndex,
        ),
        failureFact(
          "origin.clipStartTimeBeats",
          origin.clipStartTimeBeats,
          expected.startBeat,
          { unit: "beats" },
        ),
        failureFact("origin.anchorToleranceBeats", 1e-8, undefined, {
          unit: "beats",
        }),
        failureFact(
          "origin.observedAtGlobalBeat",
          origin.observedAtGlobalBeat,
          expected.startBeat,
          { comparison: "at-least", unit: "beats" },
        ),
        failureFact(
          "origin.iterationEndBeatExclusive",
          origin.observedAtGlobalBeat,
          expected.startBeat + expected.firstIterationEndBeat,
          { unit: "beats" },
        ),
      ],
    );
}
