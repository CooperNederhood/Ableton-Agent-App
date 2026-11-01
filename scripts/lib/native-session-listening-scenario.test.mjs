import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  nativeSessionListeningPrompt,
  reviewNativeSessionScenario,
  selectSessionFixtureSource,
  createRepeatedSessionApprovals,
} from "./native-session-listening-scenario.mjs";
import {
  reviewNativeScenario,
  admitNativeScenarios,
} from "./native-listening-runner.mjs";
import { createNativeScenarioApproval } from "./native-listening-verification.mjs";

test("reviews only exact three-pass same-instance native4 scope with no actor stop/retry permission", async () => {
  const manifest = JSON.parse(
    await readFile(
      "integration/live-scenarios/native-dual-session-repeat-1-2-1.json",
      "utf8",
    ),
  );
  assert.equal(reviewNativeScenario(manifest).repeatedSession, true);
  for (const change of [
    { nativeVersion: 3 },
    { sequence: [0, 0, 0] },
    { sequence: [0, 1, 0, 1] },
    { instancePolicy: "fresh-instance-per-pass" },
    { maxToolCalls: 25 },
    { maxMutations: 4 },
    { betweenPasses: { ...manifest.betweenPasses, retry: true } },
    {
      setupContract: {
        ...manifest.setupContract,
        baselineFailureEvidence: "accept-later-applied-stop",
      },
    },
    { betweenPasses: { ...manifest.betweenPasses, positionBeat: 8 } },
    { betweenPasses: { ...manifest.betweenPasses, count: 3 } },
    { betweenPasses: { ...manifest.betweenPasses, scope: "any-live-set" } },
    {
      betweenPasses: {
        ...manifest.betweenPasses,
        reviewRevision: "unreviewed",
      },
    },
    {
      betweenPasses: {
        action: "set-playing-false",
        count: 2,
        authorization: "scenario-harness-only-after-verified-completion",
        retry: false,
        seek: false,
      },
    },
    {
      allowedActions: {
        ...manifest.allowedActions,
        ableton_listening: [
          "inspect-listeners",
          "play-session-and-listen",
          "get-pass",
          "cancel",
        ],
      },
    },
    { assertions: manifest.assertions.slice(1) },
    { prompt: manifest.prompt + " Retry." },
    {
      setupContract: {
        ...manifest.setupContract,
        inputOption: "--native-v3-fixture-input",
      },
    },
  ])
    assert.throws(() => reviewNativeScenario({ ...manifest, ...change }));
});

test("repeated native4 admission denies unsafe launch flags and cannot fall back to a v3 fixture", async () => {
  const manifest = JSON.parse(
    await readFile(
      "integration/live-scenarios/native-dual-session-repeat-1-2-1.json",
      "utf8",
    ),
  );
  const base = {
    manifests: [manifest],
    skipInstall: true,
    computerUse: false,
    approveAll: false,
  };
  for (const change of [
    { skipInstall: false },
    { computerUse: true },
    { approveAll: true },
  ])
    await assert.rejects(
      admitNativeScenarios({ ...base, ...change }),
      /unsafe flags denied/,
    );
  await assert.rejects(
    admitNativeScenarios({ ...base, inputV3: "not-a-v4-input.json" }),
    /Explicit native-v4 fixture input required; no fallback/,
  );
});

test("repeated Session approvals are frozen per-pass and reject a wrong next target or stale pass", async () => {
  const manifest = JSON.parse(
    await readFile(
      "integration/live-scenarios/native-dual-session-repeat-1-2-1.json",
      "utf8",
    ),
  );
  const approvals = createRepeatedSessionApprovals(
    manifest,
    createNativeScenarioApproval,
  );
  const binding = {
    listenerId: "listener",
    sessionTarget: { view: "session", sceneIndex: 0 },
  };
  const request = (args, risk = "read") =>
    approvals.request({ toolName: "ableton_listening", risk, arguments: args });
  assert.throws(() => request({ action: "inspect-listeners" }));
  approvals.begin(binding);
  for (const [toolName, args] of [
    ["ableton_transport", { action: "seek", time: 0 }],
    ["ableton_tracks", { action: "stop-clips", target: binding.sessionTarget }],
    ["ableton_listening", { action: "stop" }],
    ["ableton_listening", { action: "retry" }],
  ]) {
    const denied = createRepeatedSessionApprovals(
      manifest,
      createNativeScenarioApproval,
    );
    denied.begin(binding);
    assert.equal(
      await denied.request({
        toolName,
        risk: "reversible",
        arguments: args,
      }),
      false,
    );
    assert.equal(
      await denied.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      }),
      false,
    );
  }
  assert.equal(await request({ action: "inspect-listeners" }), true);
  assert.equal(
    await request(
      {
        action: "play-session-and-listen",
        target: { view: "session", sceneIndex: 1 },
        listenerIds: ["listener"],
        durationBeats: 4,
        maximumDurationMs: 30000,
      },
      "reversible",
    ),
    false,
  );
  assert.throws(() => approvals.begin(binding));
  assert.equal(approvals.mutationCount, 0);
});

test("a later approval scope requires completion and cannot read a prior pass or context", async () => {
  const manifest = JSON.parse(
    await readFile(
      "integration/live-scenarios/native-dual-session-repeat-1-2-1.json",
      "utf8",
    ),
  );
  const approvals = createRepeatedSessionApprovals(
    manifest,
    createNativeScenarioApproval,
  );
  const binding = {
    listenerId: "listener",
    sessionTarget: { view: "session", sceneIndex: 0 },
  };
  const request = (args, risk = "read") =>
    approvals.request({ toolName: "ableton_listening", risk, arguments: args });
  approvals.begin(binding);
  await request({ action: "inspect-listeners" });
  assert.equal(
    await request(
      {
        action: "play-session-and-listen",
        target: binding.sessionTarget,
        listenerIds: ["listener"],
        durationBeats: 4,
        maximumDurationMs: 30000,
      },
      "reversible",
    ),
    true,
  );
  assert.throws(() => approvals.begin(binding));
  approvals.registerJob({
    passId: "pass1",
    stage: "completed",
    contextIds: ["context1"],
  });
  assert.equal(await request({ action: "get-pass", passId: "pass1" }), true);
  approvals.begin({
    ...binding,
    sessionTarget: { view: "session", sceneIndex: 1 },
  });
  assert.equal(await request({ action: "inspect-listeners" }), true);
  assert.equal(await request({ action: "get-pass", passId: "pass1" }), false);
  assert.equal(
    await approvals.request({
      toolName: "ableton_context",
      risk: "read",
      arguments: {
        action: "get",
        contextId: "context1",
        includeHistorical: true,
      },
    }),
    false,
  );
  assert.equal(approvals.mutationCount, 1);
  assert.throws(() => approvals.begin(binding));
});

for (const [id, mode] of [
  ["native-dual-arrangement", "arrangement"],
  ["native-dual-session-midi", "session"],
]) {
  test(`reviews wire4 ${mode} with no mode or version fallback`, async () => {
    const manifest = JSON.parse(
      await readFile(`integration/live-scenarios/${id}.json`, "utf8"),
    );
    const reviewed = reviewNativeScenario(manifest);
    assert.equal(reviewed.nativeVersion, 4);
    assert.equal(reviewed.mode, mode);
    assert.equal(!!reviewed.session, mode === "session");
    for (const change of [
      { nativeVersion: 3 },
      { mode: mode === "session" ? "arrangement" : "session" },
      { modeNegotiation: "automatic" },
      { allowedRisks: ["read", "destructive"] },
      { prompt: `${manifest.prompt} Retry.` },
      {
        setupContract: {
          ...manifest.setupContract,
          inputOption: "--native-v3-fixture-input",
        },
      },
    ])
      assert.throws(() => reviewNativeScenario({ ...manifest, ...change }));
  });
}

for (const [id, kind, durationBeats, loopEnd] of [
  ["native-session-midi", "midi", 4, 8],
  ["native-session-warped-audio", "warped-audio", 4, 4],
  ["native-session-midi-full-loop", "midi", null, 8],
  ["native-session-midi-eight-beats", "midi", 8, 8],
]) {
  test(`reviews exactly the immutable ${kind} scenario`, async () => {
    const manifest = JSON.parse(
      await readFile(`integration/live-scenarios/${id}.json`, "utf8"),
    );
    assert.equal(
      manifest.prompt,
      nativeSessionListeningPrompt(kind, durationBeats),
    );
    const reviewed = reviewNativeSessionScenario(manifest);
    assert.equal(reviewed.nativeVersion, 3);
    assert.equal(reviewed.sourceKind, kind);
    assert.equal(reviewed.capture.endBeat, durationBeats ?? loopEnd);
    assert.equal(reviewed.sourceRegion.loopEnd, loopEnd);
    assert.equal(
      Object.hasOwn(manifest.capture, "durationBeats"),
      durationBeats !== null,
    );
    for (const change of [
      { sourceKind: "unwarped-audio" },
      { maxToolCalls: 9 },
      { maxMutations: 2 },
      { nativeVersion: 2 },
      { capture: { ...manifest.capture, durationBeats: 6 } },
      { sourceRegion: { ...manifest.sourceRegion, loopEnd: loopEnd + 1 } },
      { prompt: `${manifest.prompt} Retry until successful.` },
      { allowedTools: ["ableton_listening", "ableton_context", "bash"] },
      { assertions: manifest.assertions.slice(1) },
      {
        setupContract: {
          ...manifest.setupContract,
          timingPolicy: {
            mode: "descriptive",
            maxClockDisagreementSamples: 128,
          },
        },
      },
    ])
      assert.throws(() =>
        reviewNativeSessionScenario({ ...manifest, ...change }),
      );
    const input = {
      sourceSetSha256: "pinned",
      sessionSources: {
        [kind]: {
          canonicalPath: "live_set tracks 1 devices 1",
          trackName: "Source",
          deviceName: "Listener",
          sceneIndex: 0,
        },
      },
    };
    assert.equal(
      selectSessionFixtureSource(input, reviewed).canonicalPath,
      "live_set tracks 1 devices 1",
    );
    assert.throws(() =>
      selectSessionFixtureSource({ ...input, sessionSources: {} }, reviewed),
    );
    assert.throws(() =>
      selectSessionFixtureSource(
        {
          ...input,
          sessionSources: {
            [kind]: {
              ...input.sessionSources[kind],
              sourceSet: "/outside.als",
            },
          },
        },
        reviewed,
      ),
    );
    for (const canonicalPath of [
      "live_set return_tracks 0 devices 0",
      "live_set tracks 256 devices 0",
      "live_set tracks 1 devices 32",
    ])
      assert.throws(() =>
        selectSessionFixtureSource(
          {
            ...input,
            sessionSources: {
              [kind]: { ...input.sessionSources[kind], canonicalPath },
            },
          },
          reviewed,
        ),
      );
  });
}
