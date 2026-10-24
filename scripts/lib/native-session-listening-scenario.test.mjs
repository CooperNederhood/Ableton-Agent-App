import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  nativeSessionListeningPrompt,
  reviewNativeSessionScenario,
  selectSessionFixtureSource,
} from "./native-session-listening-scenario.mjs";
import { reviewNativeScenario } from "./native-listening-runner.mjs";

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
