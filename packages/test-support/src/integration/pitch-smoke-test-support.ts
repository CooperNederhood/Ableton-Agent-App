import type { TelemetryEventPage } from "@ableton-agent/observability";
import {
  flatnessHistory,
  flatnessOwner,
} from "./flatness-smoke-test-support.js";
import {
  FLUCOMA_DEPENDENCY_FILES,
  FLUCOMA_PITCH_BUNDLE,
} from "@ableton-agent/shared/m4l-devices";
import type { MetricAudioObservation } from "@ableton-agent/protocol";
import type { Facts } from "./contracts.js";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import { projectPitchSmoke } from "./pitch-smoke.js";

/** Synthetic proof shape; only the packaged loader can attest a real process. */
export function pitchBinaryFacts(
  phase: "baseline" | "capture-completed",
  owner?: MetricAudioObservation["ownership"],
): Facts {
  const name = `${FLUCOMA_PITCH_BUNDLE}/Contents/MacOS/fluid.pitch~`;
  const pin = FLUCOMA_DEPENDENCY_FILES.find((entry) => entry.name === name)!;
  return {
    pitchLoadedBinaryVerified: true,
    pitchLoadedBinarySchema: "owned-mapped-flucoma-pitch/v1",
    pitchLoadedBinaryPath: `/owned/frozen/${name}`,
    pitchLoadedBinarySha256: pin.sha256,
    pitchLoadedBinaryPids: "98766",
    pitchLoadedBinaryInode: "123",
    pitchLoadedBinaryDevice: "456",
    pitchLoadedBinaryPhase: phase,
    pitchLoadedBinaryState: "completed",
    pitchLoadedBinaryDurationMs: 1,
    ...(owner
      ? Object.fromEntries(
          Object.entries(owner).map(([key, value]) => [
            `pitchLoadedBinary${key[0]!.toUpperCase()}${key.slice(1)}`,
            value,
          ]),
        )
      : {}),
  };
}

export function pitchSmokeFixture() {
  const f = melSmokeFixture();
  const owner = f.observation.ownership;
  const history = pitchHistory({
    traceId: owner.traceId,
    correlationId: owner.correlationId,
    passId: owner.passId,
    listenerId: owner.listenerId,
    native: {
      generation: owner.generation,
      nativeEpoch: owner.nativeEpoch,
      connectionId: owner.connectionId,
      connectionEpoch: owner.connectionEpoch,
    },
  });
  const pitch = projectPitchSmoke(history, {
    traceId: owner.traceId,
    correlationId: owner.correlationId,
    passId: owner.passId,
    listenerId: owner.listenerId,
    native: f.turn.captures[0]!.native!,
  });
  Object.assign(f.input.baseline.facts, pitchBinaryFacts("baseline"));
  Object.assign(f.turn.facts, pitchBinaryFacts("capture-completed", owner));
  Object.assign(f.turn, { pitchSmoke: [pitch] });
  return { ...f, pitch, pitchHistory: history };
}

/** Transport fixtures only, never a pitch or confidence accuracy oracle. */
export function pitchHistory(
  owner = flatnessOwner,
): TelemetryEventPage["items"] {
  return flatnessHistory(owner).map((event, index) => {
    if (index === 0) return event;
    const lifecycle = event.attributes.lifecycle as Record<string, unknown>;
    event.id = event.id.replace("b000", "a300");
    if (index > 1)
      event.causationId = event.causationId!.replace("b000", "a300");
    event.trace = { traceId: owner.traceId, spanId: event.id };
    event.name = event.name.replace("spectral-flatness", "monophonic-pitch");
    const values = {
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
      "pitch.leftDeliveries": index < 3 ? 0 : 2,
      "pitch.rightDeliveries": index < 3 ? 0 : 1,
      "pitch.leftCandidates": index < 3 ? 0 : 1,
      "pitch.rightCandidates": index < 3 ? 0 : 1,
      "pitch.cleanup":
        index < 5 ? "not-started" : index === 7 ? "completed" : "pending",
    };
    Object.assign(lifecycle, {
      metric: "monophonic-pitch",
      eventId: event.id,
      causationId: event.causationId,
      reason: String(lifecycle.reason).replace("flatness", "pitch"),
      facts: [
        ...Object.entries(values).map(([field, value]) => ({
          field,
          actual: { state: "observed", value },
        })),
        ...["left", "right"].flatMap((channel) =>
          ["Hz", "Confidence", "Class"].map((suffix) => ({
            field: `pitch.${channel}${suffix}`,
            actual:
              index < (suffix === "Class" ? 2 : 3)
                ? { state: "unavailable", reason: "not-reported" }
                : {
                    state: "observed",
                    value:
                      suffix === "Class"
                        ? "fluid.pitch~"
                        : suffix === "Confidence"
                          ? channel === "left"
                            ? 0.6
                            : 0.3
                          : channel === "left"
                            ? 110
                            : 220,
                  },
          })),
        ),
      ],
    });
    return event;
  });
}
