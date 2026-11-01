import { randomUUID, createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import * as protocol from "@ableton-agent/protocol";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";
import {
  metricLongCases,
  metricLongFixtureContract,
  metricLongSmokePrompt,
  verifyMetricRetainedCoverage,
  verifyNativeMetricLongSource,
  admitNativeMetricLongFixture,
  verifyMetricPublishedObservation,
} from "./native-metric-scenario.mjs";
import {
  admitNativeScenarios,
  reviewNativeScenario,
  runNativeScenarioGroup,
} from "./native-listening-runner.mjs";
import {
  createNativeScenarioApproval,
  snapshotNativeSessionSource,
  inspectNativeStoppedPreflight,
} from "./native-listening-verification.mjs";

const manifests = await Promise.all(
  Object.keys(metricLongCases).map(async (id) =>
    JSON.parse(await readFile(`integration/live-scenarios/${id}.json`, "utf8")),
  ),
);
const cleanup = [];
afterEach(async () => {
  for (const root of cleanup.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("places only the four explicitly reviewed longer cases in their separately pinned owning group", async () => {
  const suite = JSON.parse(
    await readFile("integration/live-scenarios/suite.json", "utf8"),
  );
  expect(
    suite.groups
      .find((g) => g.id === "native-listening-metric-long")
      .scenarios.sort(),
  ).toEqual(Object.keys(metricLongCases).sort());
  for (const manifest of manifests) {
    const c = metricLongCases[manifest.id];
    expect(manifest.prompt).toBe(metricLongSmokePrompt(c.kind, c.beats));
    expect(reviewNativeScenario(manifest)).toMatchObject({
      nativeVersion: 5,
      longMetric: true,
      expectedTempoBpm: 128,
      sourceKind: c.kind === "audio" ? "warped-audio" : "midi",
      expectedSpectrum: true,
      capture: {
        startBeat: 0,
        endBeat: c.beats,
        durationBeats: c.beats,
        maximumDurationMs: 30000,
      },
      sourceRegion: {
        startMarker: 0,
        loopStart: 0,
        loopEnd: 64,
        endMarker: 64,
      },
    });
    expect((c.beats * 60) / 128).toBe(c.seconds);
    for (const change of [
      { group: "native-listening-metric" },
      { capture: { ...manifest.capture, durationBeats: 65 } },
      { maxMutations: 2 },
      { maxToolCalls: 9 },
      { timeoutMs: 90001 },
      { requestedMetrics: ["level", "attacks"] },
      { prompt: `${manifest.prompt} Retry.` },
      {
        setupContract: {
          ...manifest.setupContract,
          longFixture: { ...metricLongFixtureContract, tempoBpm: 120 },
        },
      },
      {
        setupContract: {
          ...manifest.setupContract,
          longFixture: {
            ...metricLongFixtureContract,
            firstIterationEndBeat: 8,
          },
        },
      },
      { assertions: manifest.assertions.slice(0, -1) },
    ])
      expect(() => reviewNativeScenario({ ...manifest, ...change })).toThrow(
        /Unreviewed/,
      );
  }
});

it.each(manifests)(
  "retains one exact actor mutation and denies retries, stop, seek, cancellation, and foreign duration for $id",
  async (manifest) => {
    const target = {
      view: "session",
      sceneIndex: 0,
      expectedClipReference: randomUUID(),
      track: { expectedReference: randomUUID() },
    };
    const binding = {
      listenerId: "owned-native5",
      sessionTarget: target,
      passIds: new Set(),
      contextIds: new Set(),
      completedContextIds: new Set(),
    };
    const approved = createNativeScenarioApproval(manifest, binding);
    const request = (args, risk = "read", toolName = "ableton_listening") =>
      approved.request({ toolName, risk, arguments: args });
    expect(await request({ action: "inspect-listeners" })).toBe(true);
    const playback = {
      action: "play-session-and-listen",
      target,
      listenerIds: ["owned-native5"],
      durationBeats: manifest.capture.durationBeats,
      maximumDurationMs: 30000,
    };
    expect(await request(playback, "reversible")).toBe(true);
    binding.passIds.add("owned-pass");
    expect(await request({ action: "get-pass", passId: "owned-pass" })).toBe(
      true,
    );
    binding.contextIds.add("owned-context");
    binding.completedContextIds.add("owned-context");
    expect(
      await request(
        { action: "get", contextId: "owned-context", includeHistorical: true },
        "read",
        "ableton_context",
      ),
    ).toBe(true);
    expect(approved.mutationCount).toBe(1);
    for (const args of [
      { ...playback, durationBeats: 1 },
      { action: "stop" },
      { action: "seek", beat: 0 },
      { action: "cancel", passId: "owned-pass" },
    ]) {
      const denied = createNativeScenarioApproval(manifest, binding);
      await denied.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      });
      expect(
        await denied.request({
          toolName: "ableton_listening",
          risk: "reversible",
          arguments: args,
        }),
      ).toBe(false);
      expect(
        await denied.request({
          toolName: "ableton_listening",
          risk: "reversible",
          arguments: playback,
        }),
      ).toBe(false);
      expect(denied.mutationCount).toBe(0);
    }
    expect(await request(playback, "reversible")).toBe(false);
    expect(await request({ action: "get-pass", passId: "owned-pass" })).toBe(
      false,
    );
  },
);

it.each([44100, 48000])(
  "counts every row, 100ms detector input, and phase-sensitive FFT at %sHz for both durations",
  (sampleRate) => {
    for (const beats of [32, 64]) {
      for (const offset of [1, 1024, 2048]) {
        const observation = createSyntheticMetricListeningObservation({
          sampleRate,
          tempoBpm: 128,
          endBeat: beats,
          startSample: 200000,
        });
        const spectral = observation.metrics["spectral-centroid"];
        spectral.algorithm.firstFrameEndSample =
          observation.geometry.startSample + offset;
        spectral.records = [];
        for (
          let end = spectral.algorithm.firstFrameEndSample;
          end <= observation.geometry.endSample;
          end += 2048
        )
          spectral.records.push({
            index: spectral.records.length,
            support: { startSample: end - 2048, endSample: end },
            spectralEnergy: 2,
            centroidHz: 500,
          });
        spectral.expectedRecords = spectral.records.length;
        observation.rows =
          protocol.createMetricObservationReportRows(observation);
        const result = verifyMetricRetainedCoverage(observation, protocol);
        expect(result.reportRows).toBe(beats * 4);
        expect(result.attackInputRecords).toBe(beats === 32 ? 150 : 300);
        expect(result.fftRecords).toBe(
          Math.floor(((sampleRate * beats * 60) / 128 - offset) / 2048) + 1,
        );
        expect(result.firstFrameEndSample).toBe(200000 + offset);
        for (const mutate of [
          (o) => o.rows.pop(),
          (o) => o.rows.reverse(),
          (o) => {
            o.reduction.mode = "selected-report-rows";
          },
          (o) => {
            o.rows[0].attacks.recordIndices = [];
          },
          (o) => o.metrics.attacks.records.pop(),
          (o) => {
            o.metrics.attacks.records[0].support.endSample--;
          },
          (o) => {
            o.metrics.attacks.expectedRecords--;
          },
          (o) => o.metrics["spectral-centroid"].records.pop(),
          (o) => {
            o.metrics["spectral-centroid"].expectedRecords =
              o.geometry.budgets.spectrumRecords;
          },
          (o) => {
            o.metrics["spectral-centroid"].algorithm.firstFrameEndSample++;
          },
          (o) => {
            o.metrics.level.records[0].support.startSample++;
          },
        ]) {
          const invalid = globalThis.structuredClone(observation);
          mutate(invalid);
          expect(() => verifyMetricRetainedCoverage(invalid, protocol)).toThrow(
            /coverage mismatch/,
          );
        }
      }
    }
  },
);

it.each([32, 64])(
  "preserves every metric row and trace/source identity in published and reopened %s-beat payloads",
  (beats) => {
    const raw = createSyntheticMetricListeningObservation({
      tempoBpm: 128,
      endBeat: beats,
    });
    protocol.metricAudioObservationSchema.parse(raw);
    const warnings = [
      "Message-rate source identity.",
      "Routed contributors are possible.",
    ];
    const persisted = {
      ...globalThis.structuredClone(raw),
      limitations: [...new Set([...raw.limitations, ...warnings])],
    };
    const reopened = globalThis.structuredClone(persisted);
    expect(() =>
      verifyMetricPublishedObservation(raw, persisted, warnings),
    ).not.toThrow();
    expect(() =>
      verifyMetricPublishedObservation(raw, reopened, warnings),
    ).not.toThrow();
    for (const mutate of [
      (o) => {
        o.rows.pop();
      },
      (o) => {
        o.metrics.attacks.records.pop();
      },
      (o) => {
        o.metrics["spectral-centroid"].records[0].centroidHz++;
      },
      (o) => {
        o.ownership.traceId = randomUUID();
      },
      (o) => {
        o.ownership.correlationId = randomUUID();
      },
      (o) => {
        o.ownership.causationId = randomUUID();
      },
      (o) => {
        o.source.target.expectedReference = randomUUID();
      },
      (o) => {
        o.limitations.pop();
      },
    ]) {
      const invalid = globalThis.structuredClone(reopened);
      mutate(invalid);
      expect(() =>
        verifyMetricPublishedObservation(raw, invalid, warnings),
      ).toThrow(/Native terminal result mismatch/);
    }
  },
);

function sourceFixture(kind = "midi", beats = 64) {
  const target = {
    view: "session",
    sceneIndex: 0,
    track: {
      kind: "regular",
      index: kind === "midi" ? 0 : 2,
      expectedReference: randomUUID(),
      expectedName: "Owned",
    },
    expectedClipReference: randomUUID(),
    expectedClipName:
      kind === "midi"
        ? metricLongFixtureContract.midiClipName
        : metricLongFixtureContract.audioClipName,
  };
  const state = {
    transportPlaying: false,
    globalBeat: 0,
    startTimeBeats: 0,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: target.expectedClipReference,
  };
  const settings = {
    tempoBpm: 128,
    signatureNumerator: 4,
    signatureDenominator: 4,
    globalQuantization: 4,
    launchQuantization: 0,
    launchMode: 0,
    legato: false,
    followActionEnabled: false,
    startMarker: 0,
    loopStart: 0,
    loopEnd: 64,
    endMarker: 64,
    looping: true,
  };
  const source = {
    schemaVersion: 1,
    queryId: randomUUID(),
    target,
    projectRevision: 1,
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    sourceKind: kind,
    positionUnit: "beats",
    before: { ...state },
    after: { ...state },
    settings,
  };
  const body =
    kind === "midi"
      ? {
          totalNotes: 64,
          truncated: false,
          notes: Array.from({ length: 64 }, (_, i) => ({
            startTime: i + 0.5,
            duration: i === 63 ? 0.5 : 0.75,
          })),
        }
      : {
          audio: { clip: { sampleRate: 48000, sampleLength: 1536000 } },
          markers: {
            markers: [
              { beatTime: 0, sampleTime: 0 },
              { beatTime: 64, sampleTime: 32 },
            ],
          },
        };
  const content = { clips: [{ target, sourceKind: kind, settings, body }] };
  const geometry = protocol.createNativeListeningGeometry({
    sampleRate: 48000,
    vectorSize: 64,
    tempoBpm: 128,
    startBeat: 0,
    endBeat: beats,
  });
  return {
    source,
    target,
    sourceKind: kind,
    content,
    geometry,
    durationBeats: beats,
    sourceRegion: { startMarker: 0, loopStart: 0, loopEnd: 64, endMarker: 64 },
    expectedTempoBpm: 128,
  };
}

it.each(["midi", "warped-audio"])(
  "keeps all first-iteration launch, recording, source identity and tempo guards for long %s",
  (kind) => {
    for (const beats of [32, 64]) {
      const f = sourceFixture(kind, beats);
      expect(
        snapshotNativeSessionSource(f, protocol).firstIterationEndBeat,
      ).toBe(64);
      expect(() =>
        snapshotNativeSessionSource(
          { ...f, expectedTempoBpm: undefined },
          protocol,
        ),
      ).toThrow(/first-iteration/);
      expect(() =>
        verifyNativeMetricLongSource(
          { longMetric: true, sourceKind: kind },
          f.source,
          f.content,
        ),
      ).not.toThrow();
      for (const mutate of [
        (s) => {
          s.settings.loopEnd = 8;
        },
        (s) => {
          s.settings.endMarker = 31;
        },
        (s) => {
          s.settings.startMarker = 1;
        },
        (s) => {
          s.settings.tempoBpm = 120;
        },
        (s) => {
          s.settings.signatureNumerator = 3;
        },
        (s) => {
          s.settings.followActionEnabled = true;
        },
        (s) => {
          s.settings.legato = true;
        },
        (s) => {
          s.after.targetRecording = true;
        },
        (s) => {
          s.before.firedSlotIndex = 0;
        },
      ]) {
        const invalid = globalThis.structuredClone(f);
        mutate(invalid.source);
        expect(() => snapshotNativeSessionSource(invalid, protocol)).toThrow(
          /first-iteration/,
        );
      }
      const wrong = globalThis.structuredClone(f);
      if (kind === "midi") wrong.content.clips[0].body.notes.pop();
      else wrong.content.clips[0].body.audio.clip.sampleLength = 192000;
      expect(() =>
        verifyNativeMetricLongSource(
          { longMetric: true, sourceKind: kind },
          wrong.source,
          wrong.content,
        ),
      ).toThrow(/source\/content pin/);
    }
  },
);

it("uses only the reviewed128 preflight while original modes remain pinned120", () => {
  const value = {
    expectedTempoBpm: 128,
    inspected: { transport: { tempo: 128 } },
    input: {},
  };
  expect(inspectNativeStoppedPreflight(value, (s) => s).checks.tempo128).toBe(
    true,
  );
  expect(
    inspectNativeStoppedPreflight(
      { ...value, expectedTempoBpm: undefined },
      (s) => s,
    ).checks.tempo120,
  ).toBe(false);
  expect(
    inspectNativeStoppedPreflight(
      { ...value, inspected: { transport: { tempo: 120 } } },
      (s) => s,
    ).checks.tempo128,
  ).toBe(false);
});

it.each(manifests)(
  "denies original short inputs for $id before process launch, never repairing or retrying",
  async (manifest) => {
    const root = resolve(
      ".test-artifacts",
      `long-admission-unit-${randomUUID()}`,
    );
    cleanup.push(root);
    await mkdir(root, { recursive: true });
    const path = join(root, "input.json");
    await writeFile(path, JSON.stringify({ nativeVersion: 5 }));
    await expect(
      admitNativeScenarios({
        manifests: [manifest],
        inputV5: path,
        skipInstall: true,
        computerUse: false,
        approveAll: false,
      }),
    ).rejects.toThrow(/64-beat long metric fixture/);
    const launch = vi.fn();
    await expect(
      runNativeScenarioGroup({
        manifests: [manifest],
        controller: {
          assertNoPreExistingLive: vi.fn(),
          launch,
          publicRecord: () => undefined,
        },
        applicationPath: "must-not-launch",
        createRunner: () => admitNativeMetricLongFixture({}),
      }),
    ).rejects.toThrow(/64-beat/);
    expect(launch).not.toHaveBeenCalled();
  },
);

it("admits only actual hash-pinned prepared Set and full-length PCM, rejecting marker-only tags", async () => {
  const root = resolve(".test-artifacts", `long-pin-unit-${randomUUID()}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  // Deliberately synthetic filesystem contract fixture, never a playable Set.
  const set = gzipSync(
    '<Ableton Creator="Ableton Live 11.3.43"><Tempo><Manual Value="128"/></Tempo><MidiClip><Name Value="AA_METRIC_MIDI_64BEATS"/><LoopEnd Value="64"/><OutMarker Value="64"/></MidiClip><AudioClip><Name Value="AA_METRIC_AUDIO_64BEATS"/><LoopEnd Value="64"/><OutMarker Value="64"/></AudioClip></Ableton>',
  );
  const audio = Buffer.alloc(44 + 1536000 * 4);
  audio.write("RIFF");
  audio.write("WAVE", 8);
  audio.write("fmt ", 12);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt32LE(48000, 24);
  audio.writeUInt16LE(2, 22);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(1536000 * 4, 40);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const input = {
    sourceSet: join(root, "set.als"),
    sourceSetSha256: hash(set),
    audioFiles: [{ path: join(root, "audio.wav"), sha256: hash(audio) }],
  };
  input.longMetricFixture = {
    ...metricLongFixtureContract,
    preparedSetSha256: input.sourceSetSha256,
    preparedAudioSha256: input.audioFiles[0].sha256,
  };
  await writeFile(input.sourceSet, set);
  await writeFile(input.audioFiles[0].path, audio);
  await expect(admitNativeMetricLongFixture(input)).resolves.toEqual(
    input.longMetricFixture,
  );
  for (const mutate of [
    (i) => {
      i.longMetricFixture.firstIterationEndBeat = 8;
    },
    (i) => {
      i.audioFiles = [];
    },
    (i) => {
      i.longMetricFixture.preparedAudioSha256 = "a".repeat(64);
    },
  ]) {
    const invalid = globalThis.structuredClone(input);
    mutate(invalid);
    await expect(admitNativeMetricLongFixture(invalid)).rejects.toThrow(
      /fixture required/,
    );
  }
  audio.writeUInt32LE(192000 * 4, 40);
  await writeFile(input.audioFiles[0].path, audio);
  input.audioFiles[0].sha256 = hash(audio);
  input.longMetricFixture.preparedAudioSha256 = hash(audio);
  await expect(admitNativeMetricLongFixture(input)).rejects.toThrow(
    /PCM duration/,
  );
});
