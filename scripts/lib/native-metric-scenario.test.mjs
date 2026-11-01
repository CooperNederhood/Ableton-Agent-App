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
  metricRepeatedSmokePrompt,
  verifyMetricActorSequence,
  verifyRepeatedNativeMetricPasses,
  verifyRepeatedMetricActivity,
  verifyNativeMetricZeroEnergySpectrum,
} from "./native-metric-scenario.mjs";
import {
  reviewNativeScenario,
  admitNativeScenarios,
} from "./native-listening-runner.mjs";
import { createRepeatedSessionApprovals } from "./native-session-listening-scenario.mjs";

const manifest = JSON.parse(
  await readFile(
    new URL(
      "../../integration/live-scenarios/native-metric-session-midi.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const repeatedManifest = async () =>
  JSON.parse(
    await readFile(
      "integration/live-scenarios/native-metric-session-midi-repeat-3.json",
      "utf8",
    ),
  );

it.each(["audio"])(
  "reviews the exact %s silent-tail scene without widening other cases",
  async (kind) => {
    const manifest = JSON.parse(
      await readFile(
        `integration/live-scenarios/native-metric-session-${kind}-silent-tail.json`,
        "utf8",
      ),
    );
    expect(reviewNativeScenario(manifest)).toMatchObject({
      expectedZeroEnergySpectrum: true,
      expectedSpectrum: true,
      capture: { durationBeats: 4, sceneIndex: 0, startBeat: 0, endBeat: 4 },
      sourceRegion: { loopStart: 0, loopEnd: 4 },
    });
    for (const capture of [
      { ...manifest.capture, sceneIndex: 1 },
      { ...manifest.capture, sceneIndex: 2 },
      { ...manifest.capture, durationBeats: 1 },
    ])
      expect(() => reviewNativeScenario({ ...manifest, capture })).toThrow(
        /Unreviewed/,
      );
    expect(() =>
      reviewNativeScenario({
        ...manifest,
        assertions: manifest.assertions.slice(0, -1),
      }),
    ).toThrow(/Unreviewed/);
  },
);

it("requires actual retained silent FFT records, not a complete steady-tone proxy", () => {
  const timeline = {
    status: "complete",
    expectedRecords: 2,
    records: [
      { spectralEnergy: 2, centroidHz: 1000 },
      { spectralEnergy: 0, centroidHz: null },
    ],
    gaps: [],
  };
  expect(verifyNativeMetricZeroEnergySpectrum(timeline)).toBe(1);
  for (const changed of [
    { ...timeline, status: "partial" },
    { ...timeline, expectedRecords: 3 },
    { ...timeline, gaps: [{ reason: "missing-record" }] },
    {
      ...timeline,
      records: [
        { spectralEnergy: 2, centroidHz: 1000 },
        { spectralEnergy: 2, centroidHz: 1000 },
      ],
    },
    {
      ...timeline,
      records: [
        { spectralEnergy: 2, centroidHz: 1000 },
        { spectralEnergy: 0, centroidHz: 1000 },
      ],
    },
  ])
    expect(() => verifyNativeMetricZeroEnergySpectrum(changed)).toThrow();
});

it("reviews three bounded wire5 same-source captures without changing single-pass admission", async () => {
  const repeated = await repeatedManifest();
  expect(repeated.prompt).toBe(metricRepeatedSmokePrompt);
  expect(reviewNativeScenario(repeated)).toMatchObject({
    nativeVersion: 5,
    repeatedSession: true,
    sequence: [0, 0, 0],
    expectedSpectrum: true,
    expectedOutcome: "complete",
    capture: { durationBeats: 1, maximumDurationMs: 30000 },
  });
  for (const change of [
    { nativeVersion: 4 },
    { sequence: [0, 1, 0] },
    { maxToolCalls: 25 },
    { maxMutations: 4 },
    { timeoutMs: 270001 },
    { instancePolicy: "rebind-between-passes" },
    { betweenPasses: { ...repeated.betweenPasses, count: 3 } },
    { betweenPasses: { ...repeated.betweenPasses, retry: true } },
    {
      setupContract: {
        ...repeated.setupContract,
        timingPolicy: {
          mode: "descriptive",
          maxClockDisagreementSamples: 128,
        },
      },
    },
    { requestedMetrics: ["level", "attacks"] },
    { prompt: `${repeated.prompt} Retry.` },
    { assertions: repeated.assertions.slice(1) },
  ])
    expect(() => reviewNativeScenario({ ...repeated, ...change })).toThrow(
      /Unreviewed/,
    );
  await expect(
    admitNativeScenarios({
      manifests: [repeated],
      skipInstall: true,
      computerUse: false,
      approveAll: false,
      inputV4: "not-wire5.json",
    }),
  ).rejects.toThrow("Explicit native-v5 fixture input required");
});

it.each([
  { skipInstall: false, computerUse: false, approveAll: false },
  { skipInstall: true, computerUse: true, approveAll: false },
  { skipInstall: true, computerUse: false, approveAll: true },
])(
  "denies unsafe repeated wire5 admission before fixture reads: %j",
  async (flags) => {
    await expect(
      admitNativeScenarios({
        manifests: [await repeatedManifest()],
        inputV5: "must-not-read.json",
        ...flags,
      }),
    ).rejects.toThrow();
  },
);

it("uses the existing exact one-pass approval scopes for all three wire5 turns", async () => {
  const manifest = await repeatedManifest();
  const target = {
    track: { expectedReference: "owned-track" },
    sceneIndex: 0,
    expectedClipReference: "owned-clip",
  };
  const binding = { listenerId: "native5", sessionTarget: target };
  const approvals = createRepeatedSessionApprovals(
    manifest,
    createNativeScenarioApproval,
  );
  for (const index of [1, 2, 3]) {
    approvals.begin(binding);
    const request = (toolName, risk, arguments_) =>
      approvals.request({
        toolName,
        risk,
        arguments: arguments_,
      });
    expect(
      await request("ableton_listening", "read", {
        action: "inspect-listeners",
      }),
    ).toBe(true);
    expect(
      await request("ableton_listening", "reversible", {
        action: "play-session-and-listen",
        target,
        listenerIds: ["native5"],
        durationBeats: 1,
        maximumDurationMs: 30000,
      }),
    ).toBe(true);
    const job = {
      passId: `pass-${index}`,
      contextIds: [`context-${index}`],
      stage: "completed",
    };
    approvals.registerJob(job);
    expect(
      await request("ableton_listening", "read", {
        action: "get-pass",
        passId: job.passId,
      }),
    ).toBe(true);
    expect(
      await request("ableton_context", "read", {
        action: "get",
        contextId: job.contextIds[0],
        includeHistorical: true,
      }),
    ).toBe(true);
    verifyMetricActorSequence(approvals.decisions.slice((index - 1) * 4));
  }
  expect(approvals.mutationCount).toBe(3);
  expect(() => approvals.begin(binding)).toThrow(/exceed three/);
});

it.each(["repeat-get", "foreign-target", "early-context", "cancel", "seek"])(
  "denies %s in a wire5 turn and never opens a later capture scope",
  async (failure) => {
    const manifest = await repeatedManifest();
    const target = { expectedClipReference: "owned", sceneIndex: 0 };
    const binding = { listenerId: "native5", sessionTarget: target };
    const approvals = createRepeatedSessionApprovals(
      manifest,
      createNativeScenarioApproval,
    );
    approvals.begin(binding);
    const request = (toolName, risk, args) =>
      approvals.request({ toolName, risk, arguments: args });
    await request("ableton_listening", "read", {
      action: "inspect-listeners",
    });
    const playback = {
      action: "play-session-and-listen",
      target,
      listenerIds: ["native5"],
      durationBeats: 1,
      maximumDurationMs: 30000,
    };
    if (failure !== "foreign-target")
      await request("ableton_listening", "reversible", playback);
    approvals.registerJob({
      passId: "pass",
      stage: "queued",
      contextIds: [],
    });
    if (failure === "repeat-get")
      await request("ableton_listening", "read", {
        action: "get-pass",
        passId: "pass",
      });
    const args =
      failure === "foreign-target"
        ? {
            ...playback,
            target: { ...target, expectedClipReference: "foreign" },
          }
        : failure === "early-context"
          ? {
              action: "get",
              contextId: "uncompleted",
              includeHistorical: true,
            }
          : failure === "repeat-get"
            ? { action: "get-pass", passId: "pass" }
            : { action: failure, passId: "pass" };
    expect(
      await request(
        failure === "early-context" ? "ableton_context" : "ableton_listening",
        failure === "foreign-target" ? "reversible" : "read",
        args,
      ),
    ).toBe(false);
    expect(() => approvals.begin(binding)).toThrow(/cannot retry/);
  },
);
it("requires exactly inspect, one playback, one get-pass and at most one completed-context read", () => {
  const decisions = [
    ["ableton_listening", "inspect-listeners"],
    ["ableton_listening", "play-session-and-listen"],
    ["ableton_listening", "get-pass"],
    ["ableton_context", "get"],
  ].map(([toolName, action]) => ({
    approved: true,
    toolName,
    arguments: { action },
  }));
  expect(() => verifyMetricActorSequence(decisions)).not.toThrow();
  expect(() => verifyMetricActorSequence(decisions.slice(0, 3))).not.toThrow();
  for (const invalid of [
    decisions.slice(0, 2),
    [...decisions, decisions[2]],
    [decisions[1], decisions[0], decisions[2]],
    decisions.map((d, i) => (i === 2 ? { ...d, approved: false } : d)),
  ])
    expect(() => verifyMetricActorSequence(invalid)).toThrow(/actor sequence/);
});

function repeatedPasses() {
  const sessionTarget = {
    track: { expectedReference: "track" },
    sceneIndex: 0,
    expectedClipReference: "clip",
  };
  return [1, 2, 3].map((nativeEpoch) => ({
    job: { passId: `pass-${nativeEpoch}`, stage: "completed" },
    sessionTarget: globalThis.structuredClone(sessionTarget),
    nativeEpoch,
    producerIdentity: {
      producer: { producerId: "listener", instanceId: "instance" },
      connectionId: "connection",
      registration: { version: 5, connectionEpoch: 1 },
    },
    evidence: {
      passId: `pass-${nativeEpoch}`,
      contextId: `context-${nativeEpoch}`,
      listenerId: "listener",
      nativeEpoch,
      savedAndReopened: true,
      nativeCleanup: "confirmed-before-terminal-result",
      spectrumPhase: { schema: "synthetic-phase" },
      spectrumCleanup: { status: "completed" },
      spectrum: { status: "complete", expectedRecords: 1, records: [[1]] },
    },
  }));
}

it("requires unique contexts, monotonic native epochs and the identical wire5 producer and source", () => {
  expect(
    verifyRepeatedNativeMetricPasses(repeatedPasses()).passes,
  ).toHaveLength(3);
  for (const mutate of [
    (p) => {
      p[1].job.stage = "failed";
    },
    (p) => {
      p[1].nativeEpoch = 1;
    },
    (p) => {
      p[1].evidence.contextId = p[0].evidence.contextId;
    },
    (p) => {
      p[1].producerIdentity.registration.version = 4;
    },
    (p) => {
      p[1].producerIdentity.connectionId = "new";
    },
    (p) => {
      p[1].producerIdentity.producer.instanceId = "new";
    },
    (p) => {
      p[1].sessionTarget.expectedClipReference = "other";
    },
    (p) => {
      p[1].evidence.spectrumCleanup = null;
    },
    (p) => {
      p[1].evidence.spectrum.records = [];
    },
    (p) => {
      p[1].evidence.savedAndReopened = false;
    },
  ]) {
    const passes = globalThis.structuredClone(repeatedPasses());
    mutate(passes);
    expect(() => verifyRepeatedNativeMetricPasses(passes)).toThrow(
      /Repeated metric/,
    );
  }
});

it("requires measured non-silent nonclipping wire5 level and spectral activity", () => {
  const evidence = {
    level: [{ peak: [0.25, 0.25], rms: [0.125, 0.125] }],
    spectrum: { records: [{ spectralEnergy: 1, centroidHz: 440 }] },
  };
  expect(verifyRepeatedMetricActivity(evidence)).toEqual({
    peak: 0.25,
    energeticWindows: 1,
  });
  for (const mutate of [
    (e) => {
      e.level[0].peak[0] = 1;
    },
    (e) => {
      e.level[0].peak[0] = NaN;
    },
    (e) => {
      e.level[0].rms = [0, 0];
    },
    (e) => {
      e.spectrum.records[0].spectralEnergy = 0;
    },
    (e) => {
      e.spectrum.records[0].centroidHz = 0;
    },
  ]) {
    const changed = globalThis.structuredClone(evidence);
    mutate(changed);
    expect(() => verifyRepeatedMetricActivity(changed)).toThrow(/non-silent/);
  }
});

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

it.each(["midi", "audio"])(
  "reviews the exact four-beat production %s phrase without widening existing scenarios",
  async (kind) => {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          `../../integration/live-scenarios/native-metric-session-${kind}-production-phrase.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(reviewNativeMetricScenario(manifest)).toMatchObject({
      capture: { durationBeats: 4, startBeat: 0, endBeat: 4 },
      expectedSpectrum: true,
      expectedOutcome: "complete",
    });
    expect(() =>
      reviewNativeMetricScenario({
        ...manifest,
        capture: { ...manifest.capture, durationBeats: 5 },
      }),
    ).toThrow();
    expect(() =>
      reviewNativeMetricScenario({ ...manifest, maxMutations: 2 }),
    ).toThrow();
  },
);

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
