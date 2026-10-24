import { describe, expect, it } from "vitest";
import { createSyntheticNativeListeningFixtureV2 } from "./testing.js";
import {
  audioObservationV2Schema,
  mapSessionAudioObservation,
  sessionAudioObservationSchema,
  storedAudioObservationSchema,
} from "./audio-observation-schemas.js";

function fixture() {
  return {
    ...createSyntheticNativeListeningFixtureV2().observation,
    schema: "session-audio-observation/v1",
    source: {
      view: "session",
      target: {
        view: "session",
        track: {
          kind: "regular",
          index: 0,
          expectedReference: "00000000-0000-4000-8000-000000000001",
          expectedName: "Track",
        },
        sceneIndex: 1,
        expectedClipReference: "00000000-0000-4000-8000-000000000002",
        expectedClipName: "Clip",
      },
      kind: "midi",
      coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
      transport: { startBeat: 100, endBeat: 104 },
      origin: {
        evidence: "message-rate-start-time-with-native-transport",
        clipStartTimeBeats: 100,
        observedAtGlobalBeat: 101,
      },
      continuity: {
        evidence: "message-rate-monitored",
        followActions: "unknown",
      },
    },
  };
}

describe("historical Session observations", () => {
  it("maps global descriptor beats from one frozen origin while preserving DSP sample indices and timing limitations", () => {
    const source = sessionAudioObservationSchema.parse(fixture()).source;
    const global = createSyntheticNativeListeningFixtureV2().observation;
    global.startSample += 120_000;
    global.endSample += 120_000;
    global.startBeat += source.transport.startBeat;
    global.endBeat += source.transport.startBeat;
    global.samples = global.samples.map((point) => ({
      ...point,
      sample: point.sample + 120_000,
      beat: point.beat + source.transport.startBeat,
    }));
    global.attacks = global.attacks.map((point) => ({
      ...point,
      sample: point.sample + 120_000,
      beat: point.beat + source.transport.startBeat,
    }));
    const before = structuredClone({ global, source });
    const local = mapSessionAudioObservation(global, source);
    expect(local.startBeat).toBe(0);
    expect(local.endBeat).toBe(4);
    expect(local.startSample).toBe(global.startSample);
    expect(local.endSample).toBe(global.endSample);
    expect(local.samples).toEqual(
      global.samples.map((point) => ({
        ...point,
        beat: point.beat - source.transport.startBeat,
      })),
    );
    expect(local.attacks).toEqual(
      global.attacks.map((point) => ({
        ...point,
        beat: point.beat - source.transport.startBeat,
      })),
    );
    expect(local.alignment).toEqual(global.alignment);
    expect(local.limitations).toEqual(global.limitations);
    expect(local.source).toEqual(source);
    expect({ global, source }).toEqual(before);
    expect(audioObservationV2Schema.parse(global)).toEqual(global);
  });

  it("rejects mismatched frozen origin rather than clamping negative local beats", () => {
    const source = sessionAudioObservationSchema.parse(fixture()).source;
    expect(() =>
      mapSessionAudioObservation(
        createSyntheticNativeListeningFixtureV2().observation,
        source,
      ),
    ).toThrow();
  });

  it("maps rounded physical endpoints above four beats without replacing actual coverage with nominal duration", () => {
    const source = sessionAudioObservationSchema.parse(fixture()).source;
    const global = createSyntheticNativeListeningFixtureV2().observation;
    global.sampleRate = global.alignment.sampleRate = 44_100;
    global.endSample =
      global.startSample + Math.round((4 * 60 * global.sampleRate) / 128);
    global.startBeat = source.transport.startBeat;
    global.endBeat =
      global.startBeat +
      ((global.endSample - global.startSample) * 128) /
        (60 * global.sampleRate);
    global.samples = [
      {
        ...global.samples.at(-1)!,
        sample: global.endSample,
        beat: global.endBeat,
      },
    ];
    global.attacks = [
      { sample: global.endSample, beat: global.endBeat, strength: 0.5 },
    ];
    global.reduction.originalSamples = global.reduction.originalAttacks = 1;
    source.transport.endBeat = global.endBeat;
    expect(() => mapSessionAudioObservation(global, source)).toThrow(
      "clip-local coverage",
    );
    source.coordinate.endBeat = global.endBeat - source.transport.startBeat;
    const local = mapSessionAudioObservation(global, source);
    expect(local.endBeat).toBeGreaterThan(4);
    expect(local.samples[0]?.beat).toBe(local.endBeat);
    expect(local.attacks[0]?.beat).toBe(local.endBeat);
    expect(local.endSample).toBe(global.endSample);
  });

  it.each([(Math.round((4 * 60 * 44_100) / 128) * 128) / (60 * 44_100), 4.001])(
    "retains rounded physical coverage through %s beats without clamping points",
    (endBeat) => {
      const value = fixture();
      value.sampleRate = value.alignment.sampleRate = 44_100;
      value.endSample =
        value.startSample + Math.round((endBeat * 60 * value.sampleRate) / 128);
      value.endBeat = value.source.coordinate.endBeat = endBeat;
      value.source.transport.endBeat =
        value.source.transport.startBeat + endBeat;
      value.samples = [
        {
          ...value.samples.at(-1)!,
          sample: value.endSample,
          beat: endBeat,
        },
      ];
      value.attacks = [
        {
          sample: value.endSample,
          beat: endBeat,
          strength: 0.5,
        },
      ];
      value.reduction.originalSamples = value.reduction.originalAttacks = 1;
      const stored = sessionAudioObservationSchema.parse(value);
      expect(stored).toEqual(value);
      expect(stored.samples.at(-1)?.beat).toBeGreaterThan(4);
      expect(stored.attacks.at(-1)?.beat).toBe(endBeat);
    },
  );

  it("rejects historical coverage beyond the rounding allowance", () => {
    const value = fixture();
    value.endBeat = value.source.coordinate.endBeat = 4.001001;
    value.source.transport.endBeat = 100 + value.endBeat;
    expect(sessionAudioObservationSchema.safeParse(value).success).toBe(false);
  });

  it("keeps local beats separate from nonzero native sample clocks and global transport", () => {
    const value = fixture();
    value.startSample += 120_000;
    value.endSample += 120_000;
    value.samples = value.samples.map((point) => ({
      ...point,
      sample: point.sample + 120_000,
    }));
    value.attacks = value.attacks.map((point) => ({
      ...point,
      sample: point.sample + 120_000,
    }));
    expect(storedAudioObservationSchema.parse(value)).toEqual(value);
    expect(audioObservationV2Schema.safeParse(value).success).toBe(false);
  });

  it.each([
    (v: ReturnType<typeof fixture>) => {
      v.startBeat = 1;
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.coordinate.endBeat = 5;
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.coordinate.iteration = 1;
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.coordinate.unit = "seconds";
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.transport.endBeat = 105;
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.origin.clipStartTimeBeats = 99;
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.target.track.index = 256;
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.kind = "unwarped-audio";
    },
    (v: ReturnType<typeof fixture>) => {
      v.source.origin.observedAtGlobalBeat = Infinity;
    },
    (v: ReturnType<typeof fixture>) => {
      v.samples[0]!.beat = 100;
    },
    (v: ReturnType<typeof fixture>) => {
      v.alignment.sampleRate = 44_100;
    },
  ])(
    "rejects invalid units, ranges, mapping or descriptor invariants %#",
    (change) => {
      const value = fixture();
      change(value);
      expect(sessionAudioObservationSchema.safeParse(value).success).toBe(
        false,
      );
    },
  );

  it("accepts signed message-rate history and tolerant duration comparison without granting precision", () => {
    const value = fixture();
    value.source.origin.observedAtGlobalBeat = -1;
    value.source.transport.endBeat += 1e-9;
    value.source.kind = "warped-audio";
    expect(
      sessionAudioObservationSchema.parse(value).alignment
        .verifiedAbsoluteErrorBoundSamples,
    ).toBeNull();
  });
});
