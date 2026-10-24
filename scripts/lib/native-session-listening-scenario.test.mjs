import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  nativeSessionListeningPrompt,
  reviewNativeSessionScenario,
  selectSessionFixtureSource,
} from "./native-session-listening-scenario.mjs";

for (const [id, kind] of [
  ["native-session-midi", "midi"],
  ["native-session-warped-audio", "warped-audio"],
]) {
  test(`reviews exactly the immutable ${kind} scenario`, async () => {
    const manifest = JSON.parse(
      await readFile(`integration/live-scenarios/${id}.json`, "utf8"),
    );
    assert.equal(manifest.prompt, nativeSessionListeningPrompt(kind));
    const reviewed = reviewNativeSessionScenario(manifest);
    assert.equal(reviewed.nativeVersion, 3);
    assert.equal(reviewed.sourceKind, kind);
    for (const change of [
      { sourceKind: "unwarped-audio" },
      { maxToolCalls: 9 },
      { maxMutations: 2 },
      { nativeVersion: 2 },
      { capture: { ...manifest.capture, durationBeats: 8 } },
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
