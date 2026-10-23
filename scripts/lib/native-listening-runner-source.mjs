import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const nativeSourceTransitions = Object.freeze({
  "native-source-baseline": "baseline",
  "native-source-arrangement-edit": "arrangement-duplicate-delete",
  "native-source-session-override": "session-override",
  "native-source-explicit-return": "explicit-return",
});

export const nativeSourceSetupActions = Object.freeze({
  baseline: Object.freeze([]),
  "arrangement-duplicate-delete": Object.freeze([
    "duplicate",
    "delete-duplicate",
  ]),
  "session-override": Object.freeze([
    "session-launch",
    "explicit-stop-before-new-pass",
  ]),
  "explicit-return": Object.freeze([
    "session-launch",
    "explicit-track-return",
    "explicit-stop-before-new-pass",
  ]),
});

export const nativeSourceOverrideRefusal =
  "arrangement_session_override: A Session source override was detected for at least one selected listener. Return to Arrangement in Live for that track, then explicitly request a new listening pass. No capture was published.";

export function nativeSourcePrompt(transition) {
  return transition === "session-override"
    ? " The runner has explicitly launched the identity-bound Session source. This is an expected refusal investigation, not a request to repair it. Make the one reviewed playback request, then report its terminal refusal. Do not return to Arrangement, stop, retry, or fetch context."
    : transition === "explicit-return"
      ? " The runner has explicitly launched Session, returned this exact track to Arrangement and stopped transport as reviewed preparation. This request is a new explicit pass in a fresh disposable fixture, never a retry or continuation of a refused pass."
      : " The runner independently verifies source state; do not change or repair the source.";
}

/** Only the copied, exact-PID owned fixture reaches these typed setup actions.
 * Mutation receipts are not source evidence: every boundary gets a fresh read. */
export async function prepareNativeSourceTransition({
  transition,
  ableton,
  inspect,
  target,
  runId,
  validateOwnership,
  stage,
  evidence = { reads: [], mutations: [] },
}) {
  check(
    Object.values(nativeSourceTransitions).includes(transition),
    "Unreviewed native source transition",
  );
  const track = target.binding.track;
  check(track.kind === "regular", "Source investigation needs a regular track");
  const trackTarget = {
    index: track.index,
    expectedReference: track.expectedReference,
    expectedName: track.expectedName,
  };
  const { reads, mutations } = evidence;
  const read = async (label, override) => {
    const attributes = { transition, label, expectedSessionOverride: override };
    return stage(
      `source-${label}`,
      async () => {
        await validateOwnership();
        const bindingQueryId = randomUUID();
        const value = await inspect(bindingQueryId);
        check(
          value.bindingQueryId === bindingQueryId,
          "Stale source investigation binding query",
        );
        const current = value.listeners[0];
        const observation = {
          label,
          bindingQueryId,
          recording: value.transport.recording,
          playing: value.transport.playing,
          sourceEvidence: current?.sourceEvidence,
          sessionOverride: current?.sessionOverride,
        };
        reads.push(observation);
        attributes.observation = observation;
        check(
          value.listeners.length === 1 &&
            isDeepStrictEqual(current.binding, target.binding) &&
            current.canonicalPath === target.canonicalPath &&
            current.enabled === true &&
            !current.clipsTruncated &&
            !current.dependenciesTruncated,
          "Source transition changed the exact listener binding",
        );
        check(
          Object.keys(value.transport.recording).length === 4 &&
            Object.values(value.transport.recording).every(
              (flag) => flag === false,
            ),
          "Source transition recording state must be independently known off",
        );
        const source = current.sourceEvidence;
        check(
          current.sessionOverride === override &&
            source?.schemaVersion === 1 &&
            source.state === (override ? "session-override" : "arrangement"),
          `Unexpected source state after ${label}; no automatic repair`,
        );
        return value;
      },
      attributes,
    );
  };
  const mutate = (name, operation) => {
    const attributes = { transition, action: name, track: trackTarget };
    return stage(
      `source-${name}`,
      async () => {
        await validateOwnership();
        check(
          nativeSourceSetupActions[transition][mutations.length] === name,
          "Source transition setup action/order/budget exceeded",
        );
        const receipt = await operation();
        mutations.push({ name, receipt });
        attributes.receipt = receipt;
        check(
          name === "explicit-track-return"
            ? receipt?.action === "back-to-arrangement" &&
                receipt.result?.verified === true
            : receipt?.verified === true,
          `Unverified source ${name}`,
        );
        return receipt;
      },
      attributes,
    );
  };
  await read("baseline", false);
  if (transition !== "baseline") {
    const snapshot = await ableton.inspectSession();
    const candidates = (snapshot.clips ?? []).filter(
      (clip) =>
        clip.trackReference === track.expectedReference &&
        clip.trackIndex === track.index,
    );
    check(
      candidates.length === 1 && candidates[0].length <= 16,
      "Pinned source investigation fixture must contain exactly one bounded Session source on the listener track",
    );
    const source = candidates[0];
    const sourceTarget = {
      ...trackTarget,
      sceneIndex: source.sceneIndex,
      expectedClipReference: source.reference,
    };
    if (transition === "arrangement-duplicate-delete") {
      const before = await ableton.inspectArrangement({
        offset: 0,
        limit: 100,
      });
      check(
        before.total === before.clips.length &&
          before.clips.length < 100 &&
          before.clips
            .filter((clip) => clip.trackReference === track.expectedReference)
            .every((clip) => clip.endTime <= 128),
        "Source edit destination is not independently empty",
      );
      const created = await mutate("duplicate", () =>
        ableton.duplicateClipToArrangement({
          ...sourceTarget,
          destinationTime: 128,
        }),
      );
      check(
        created.clip.trackReference === track.expectedReference &&
          created.clip.startTime === 128 &&
          created.clip.endTime === 128 + source.length &&
          !before.clips.some(
            (clip) => clip.reference === created.clip.reference,
          ),
        "Unexpected Arrangement duplicate identity or range",
      );
      await read("arrangement-duplicate", false);
      await mutate("delete-duplicate", () =>
        ableton.deleteArrangementClip({
          ...trackTarget,
          expectedClipReference: created.clip.reference,
          expectedStartTime: 128,
        }),
      );
      const restored = await ableton.inspectArrangement({
        offset: 0,
        limit: 100,
      });
      check(
        isDeepStrictEqual(restored, before),
        "Arrangement source edit did not restore exact clip identities",
      );
      await read("arrangement-delete", false);
    } else {
      await mutate("session-launch", () =>
        ableton.launchSessionClip(sourceTarget),
      );
      const launched = await read("session-launch", true);
      check(
        launched.listeners[0].sourceEvidence.playingSlotIndex ===
          source.sceneIndex ||
          launched.listeners[0].sourceEvidence.firedSlotIndex ===
            source.sceneIndex,
        "Session takeover does not identify the launched source slot",
      );
      if (transition === "explicit-return") {
        await mutate("explicit-track-return", () =>
          ableton.executeTracksOperation({
            action: "back-to-arrangement",
            target: { kind: "regular", ...trackTarget },
          }),
        );
        await read("explicit-track-return", false);
      }
      // Reviewed stopped preflight; stopping must not silently return the source.
      await mutate("explicit-stop-before-new-pass", () =>
        ableton.setPlaying(false),
      );
      await read(
        "explicit-stop-before-new-pass",
        transition === "session-override",
      );
    }
  }
  const inspected = await read(
    "before-explicit-pass",
    transition === "session-override",
  );
  check(
    inspected.transport.playing === false,
    "Source investigation must establish a stopped explicit-pass preflight",
  );
  check(
    mutations.length === nativeSourceSetupActions[transition].length,
    "Source transition did not execute its exact reviewed setup actions",
  );
  return {
    inspected,
    beforePass: async () => {
      const latest = await read(
        "immediately-before-actor-request",
        transition === "session-override",
      );
      check(
        latest.transport.playing === false &&
          latest.transport.safeToStart === true,
        "Source changed before the explicit actor request; no retry",
      );
      return latest;
    },
    afterPass: () =>
      read("after-terminal-pass", transition === "session-override"),
    evidence: {
      schema: "native-source-investigation/v1",
      transition,
      runId,
      originalCause: "not-reconstructable",
      bugSpecificReproduction: "unproven-not-claimed",
      reads,
      mutations,
    },
  };
}

export function verifyNativeSourceRefusal({
  job,
  pass,
  entries,
  links,
  received,
  before,
  after,
  listener,
  finalListener,
  baselineSnapshot,
  finalSnapshot,
}) {
  check(
    job.stage === "failed" &&
      job.error === nativeSourceOverrideRefusal &&
      job.contextIds.length === 0,
    "Expected the exact known Session-override terminal refusal",
  );
  check(
    pass === undefined &&
      entries.length === 0 &&
      links.length === 0 &&
      received.length === 0,
    "Refused source pass published context, links, a pass or native completion",
  );
  check(
    finalListener?.phase === "idle" &&
      finalListener.passId === undefined &&
      finalListener.jobId === undefined &&
      finalListener.connectionId === listener.connectionId &&
      isDeepStrictEqual(finalListener.registration, listener.registration) &&
      isDeepStrictEqual(finalListener.binding, listener.binding),
    "Refused source pass did not release exact listener ownership",
  );
  check(
    isDeepStrictEqual(before.listeners, after.listeners) &&
      isDeepStrictEqual(
        before.transport.recording,
        after.transport.recording,
      ) &&
      Object.values(after.transport.recording).every(
        (flag) => flag === false,
      ) &&
      before.transport.playing === after.transport.playing &&
      isDeepStrictEqual(baselineSnapshot, finalSnapshot),
    "Refusal mutated source, binding, recording, transport or Set",
  );
  return {
    expectedRefusal: "arrangement_session_override",
    noPublication: true,
    listenerReleased: true,
    unchangedSetAndSource: true,
    recordingInactive: true,
  };
}
