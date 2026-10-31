import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { inspectListeningContextParamsSchema } from "@ableton-agent/protocol";
import { nativeMetricReadyProofSchema } from "@ableton-agent/protocol";
import { createSyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import { createNativeScenarioApproval } from "./native-listening-verification.mjs";
import {
  reviewNativeMetricScenario,
  metricSmokePrompt,
  verifyMetricPublishedObservation,
  metricPartialSmokePrompt,
  metricSpectrumSmokePrompt,
} from "./native-metric-scenario.mjs";
import {
  reviewNativeScenario,
  admitNativeScenarios,
} from "./native-listening-runner.mjs";

const manifest = JSON.parse(
  await readFile(
    new URL(
      "../../integration/live-scenarios/native-metric-session-midi.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

it("reviews the frozen audio Session target with the same all-metric and mutation guards", async () => {
  const audio = JSON.parse(
    await readFile(
      new URL(
        "../../integration/live-scenarios/native-metric-session-audio-spectrum.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(reviewNativeScenario(audio)).toMatchObject({
    sourceKind: "warped-audio",
    sourceRegion: { startMarker: 0, loopStart: 0, loopEnd: 4 },
    expectedSpectrum: true,
    capture: { durationBeats: 1 },
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
  });
  expect(() => reviewNativeScenario({ ...audio, maxMutations: 2 })).toThrow();
  expect(() =>
    reviewNativeScenario({ ...audio, prompt: metricSpectrumSmokePrompt }),
  ).toThrow();
});

it("reviews all-metric physical FFT capture without expanding the source or tool budget", async () => {
  const spectrum = JSON.parse(
    await readFile(
      new URL(
        "../../integration/live-scenarios/native-metric-session-midi-spectrum.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(spectrum.prompt).toBe(metricSpectrumSmokePrompt);
  const reviewed = reviewNativeMetricScenario(spectrum);
  expect(reviewed.requestedMetrics).toEqual([
    "level",
    "spectral-centroid",
    "attacks",
  ]);
  expect(reviewed.expectedOutcome).toBe("complete");
  expect(reviewed.expectedSpectrum).toBe(true);
  expect(() =>
    reviewNativeMetricScenario({ ...spectrum, maxMutations: 2 }),
  ).toThrow();
  expect(() =>
    reviewNativeMetricScenario({
      ...spectrum,
      capture: { ...spectrum.capture, durationBeats: 2 },
    }),
  ).toThrow();
});

it("verifies exact measurements while requiring the canonical added Session source warnings", () => {
  const observation = globalThis.structuredClone(
    createSyntheticMetricWireFixture().observation,
  );
  const warnings = [
    "Message-rate source identity.",
    "Routed contributors are possible.",
  ];
  const stored = {
    ...observation,
    limitations: [...new Set([...observation.limitations, ...warnings])],
  };
  expect(() =>
    verifyMetricPublishedObservation(observation, stored, warnings),
  ).not.toThrow();
  const missing = globalThis.structuredClone(stored);
  missing.limitations.pop();
  expect(() =>
    verifyMetricPublishedObservation(observation, missing, warnings),
  ).toThrow(/limitations/);
  const changed = globalThis.structuredClone(stored);
  changed.metrics.level.records[0].rms[0] /= 2;
  expect(() =>
    verifyMetricPublishedObservation(observation, changed, warnings),
  ).toThrow(/metrics.level.records.0.rms.0/);
  const unexpected = globalThis.structuredClone(stored);
  unexpected.limitations.push("Unreviewed warning");
  expect(() =>
    verifyMetricPublishedObservation(observation, unexpected, warnings),
  ).toThrow(/limitations/);
});

it("attributes a failed shared clock bracket to its exact actual row", () => {
  const { ready } = createSyntheticMetricWireFixture();
  const before = globalThis.structuredClone(ready.before);
  before.frames[3][9] += 64;
  const parsed = nativeMetricReadyProofSchema.shape.before.safeParse(before);
  expect(parsed.success).toBe(false);
  expect(parsed.error.issues[0].path).toEqual(["frames", 3]);
});

it("reviews the distinct partial-spectrum scenario without broadening the first complete capture", async () => {
  const partial = JSON.parse(
    await readFile(
      new URL(
        "../../integration/live-scenarios/native-metric-session-midi-partial-spectrum.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(partial.prompt).toBe(metricPartialSmokePrompt);
  const reviewed = reviewNativeMetricScenario(partial);
  expect(reviewed.expectedOutcome).toBe("partial");
  expect(reviewed.requestedMetrics).toEqual([
    "level",
    "spectral-centroid",
    "attacks",
  ]);
  expect(() =>
    reviewNativeMetricScenario({
      ...partial,
      requestedMetrics: ["level", "attacks"],
    }),
  ).toThrow(/Unreviewed/);
  expect(() =>
    reviewNativeMetricScenario({
      ...manifest,
      requestedMetrics: partial.requestedMetrics,
    }),
  ).toThrow(/Unreviewed/);
});

it("admits only the reviewed short explicit metric selection through the real runner", () => {
  expect(manifest.prompt).toBe(metricSmokePrompt);
  const reviewed = reviewNativeScenario(manifest);
  expect(reviewed).toMatchObject({
    nativeVersion: 5,
    session: true,
    sourceKind: "midi",
    requestedMetrics: ["level", "attacks"],
    capture: { durationBeats: 1 },
  });
  expect(Object.isFrozen(reviewed.requestedMetrics)).toBe(true);
});

it.each([
  { nativeVersion: 4 },
  { requestedMetrics: ["level", "spectral-centroid", "attacks"] },
  { capture: { ...manifest.capture, durationBeats: 4 } },
  { allowedRisks: ["read", "reversible", "destructive"] },
  { maxMutations: 2 },
  { prompt: `${metricSmokePrompt} Retry failures.` },
  {
    setupContract: {
      ...manifest.setupContract,
      inputOption: "--native-v4-fixture-input",
    },
  },
])("rejects broadened or unmatched metric scenario: %j", (change) => {
  expect(() => reviewNativeMetricScenario({ ...manifest, ...change })).toThrow(
    "Unreviewed metric listening scenario contract",
  );
});

it("does not fall back to another version's fixture", async () => {
  await expect(
    admitNativeScenarios({
      manifests: [manifest],
      skipInstall: true,
      computerUse: false,
      approveAll: false,
      inputV4: "not-an-authorized-v5-fixture.json",
    }),
  ).rejects.toThrow("Explicit native-v5 fixture input required");
});

it("provides an exact typed inspection range before native preparation", () => {
  const { capture } = reviewNativeScenario(manifest);
  expect(
    inspectListeningContextParamsSchema.safeParse({
      schemaVersion: 1,
      bindingQueryId: "00000000-0000-4000-8000-000000000001",
      listeners: [{ canonicalPath: "live_set tracks 0 devices 1" }],
      range: { startBeat: capture.startBeat, endBeat: capture.endBeat },
      maxClips: 32,
      maxParameters: 16,
    }).success,
  ).toBe(true);
});

it("uses exact Session approval and counts one mutation for the v5 pass", async () => {
  const target = {
    view: "session",
    sceneIndex: 0,
    expectedClipReference: "00000000-0000-4000-8000-000000000001",
    expectedClipName: "Fixture",
    track: {
      kind: "regular",
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Fixture",
    },
  };
  const binding = {
    listenerId: "listener",
    sessionTarget: target,
    passIds: new Set(),
    contextIds: new Set(),
    completedContextIds: new Set(),
  };
  const approval = createNativeScenarioApproval(manifest, binding);
  await approval.request({
    toolName: "ableton_listening",
    risk: "read",
    arguments: { action: "inspect-listeners" },
  });
  const args = {
    action: "play-session-and-listen",
    target,
    listenerIds: ["listener"],
    durationBeats: 1,
    maximumDurationMs: 30000,
  };
  const accepted = await approval.request({
    toolName: "ableton_listening",
    risk: "reversible",
    arguments: args,
  });
  expect(accepted).toBe(true);
  expect(approval.mutationCount).toBe(1);
  const repeated = await approval.request({
    toolName: "ableton_listening",
    risk: "reversible",
    arguments: args,
  });
  expect(repeated).toBe(false);
  expect(approval.mutationCount).toBe(1);
});
