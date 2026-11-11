import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  validateFixture,
  validateScenario,
} from "../../packages/test-support/src/integration/validation.js";
import { ScopedApprovalPolicy } from "../../tests/electron/acceptance-approvals.js";

const root = new URL("../../integration/", import.meta.url);
const id = "session-two-midi-listening";
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

describe("reviewed two-MIDI listener smoke contract", () => {
  it("registers exactly two source-bound captures with STOP but no reset or restart", async () => {
    const scenario = readJson(`acceptance-scenarios/${id}.json`);
    const suite = readJson("acceptance-scenarios/suite.json");
    const [value, catalog, fixture] = await Promise.all([
      scenario,
      suite,
      readJson(`fixtures/${id}/fixture.json`),
    ]);
    validateFixture(fixture);
    validateScenario(value, fixture);
    if (
      typeof catalog !== "object" ||
      catalog === null ||
      !("scenarios" in catalog) ||
      !Array.isArray(catalog.scenarios)
    )
      throw new Error("Invalid acceptance catalog");
    expect(
      catalog.scenarios.filter((entry: unknown) => entry === id),
    ).toHaveLength(1);
    expect(value.requiredCapabilities).toEqual(["automation", "session-midi"]);
    expect(value.steps.map((step) => step.sourceId)).toEqual(["a", "b"]);
    expect(value.steps.map((step) => step.setupActions ?? [])).toEqual([
      [],
      ["stop-transport"],
    ]);
    expect(value.steps.map((step) => step.timeoutMs)).toEqual([300000, 300000]);
    expect(value.budget.runMs).toBe(630000);
    expect(value.permissions).toHaveLength(2);
    for (const [index, step] of value.steps.entries()) {
      expect(step.message).toContain("without retrying");
      expect(value.permissions[index]).toMatchObject({
        tool: "ableton_listening",
        action: "play-session-and-listen",
        maxUses: 1,
        stepIds: [step.id],
        arguments: { "target.track.index": index },
      });
      expect(step.assertions).toContainEqual({
        name: "capture",
        parameters: {
          sourceId: index === 0 ? "a" : "b",
          sampleRate: 48000,
          expectedFrames: 90000,
          metricFamilies:
            "level,spectral-centroid,attacks,mel-bands,pitch,spectral-shape",
        },
      });
    }
    expect(value.assertions).toContainEqual({
      name: "capture-count",
      parameters: { expected: 2 },
    });
    expect(value.assertions).toContainEqual({
      name: "native-freshness",
      parameters: {},
    });
  });

  it("pins the approved Set and distinct MIDI/listener identities without redistributing factory samples", async () => {
    const fixture = await readJson(`fixtures/${id}/fixture.json`);
    validateFixture(fixture);
    expect(fixture.resources).toHaveLength(1);
    const bytes = await readFile(new URL(`fixtures/${id}/project.als`, root));
    expect(fixture.resources[0]).toMatchObject({
      path: "project.als",
      target: "project.als",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(fixture.resources[0]!.sha256).toBe(
      "0f7c19b91a2716eb05efd1e24ac4f3032767ff598d50d31918b2df2ea34d0e16",
    );
    expect(
      fixture.sources!.map((source) =>
        "trackIndex" in source ? source.trackIndex : undefined,
      ),
    ).toEqual([0, 1]);
    expect(
      fixture.sources!.every(
        (source) => "midi" in source && !("mediaTarget" in source),
      ),
    ).toBe(true);
    expect(
      fixture.listenerBindings!.map((binding) => [
        binding.trackIndex,
        binding.deviceIndex,
      ]),
    ).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(
      new Set(fixture.listenerBindings!.map((binding) => binding.slot)).size,
    ).toBe(2);
    expect(fixture.coreLibraryResources).toHaveLength(69);
    expect(fixture.builtinResources).toHaveLength(2);
    expect(fixture.baseline).toMatchObject({
      currentSongTime: 0,
      transportPlaying: false,
      rememberedSessionClips: 2,
      tempo: 128,
    });
  });

  it("approves exactly four beats once per source and rejects changed duration, source or turn", async () => {
    const [scenario, fixture] = await Promise.all([
      readJson(`acceptance-scenarios/${id}.json`),
      readJson(`fixtures/${id}/fixture.json`),
    ]);
    validateFixture(fixture);
    validateScenario(scenario, fixture);
    const policy = new ScopedApprovalPolicy(scenario.permissions);
    const owner = {
      operationId: "operation",
      appSessionId: "session",
      agentId: "agent",
      conversationId: "conversation",
    };
    for (const [index, step] of scenario.steps.entries()) {
      const source = {
        source: {
          trackId: `track-${index}`,
          clipId: `clip-${index}`,
          slotIndex: 0,
          mediaSha256: "0".repeat(64),
        },
        listenerId: `listener-${index}`,
        loadedMediaPath: `/owned/source-${index}.wav`,
        facts: {},
      };
      const arguments_ = {
        action: "play-session-and-listen",
        target: {
          view: "session",
          track: {
            kind: "regular",
            index,
            expectedReference: source.source.trackId,
            expectedName: index === 0 ? "1-Operator" : "2-808 Core Kit",
          },
          sceneIndex: 0,
          expectedClipReference: source.source.clipId,
          expectedClipName: index === 0 ? "clip-1" : "clip-2",
        },
        listenerIds: [source.listenerId],
        durationBeats: 4,
      };
      const request = {
        ...owner,
        tool: "ableton_listening",
        action: "play-session-and-listen",
        risk: "medium",
        destructive: false,
        arguments: arguments_,
      };
      for (const durationBeats of [0, 3, 5, 8, null])
        expect(
          policy.decide(
            {
              ...request,
              arguments: { ...arguments_, durationBeats },
            },
            owner,
            source,
            step.id,
          ),
        ).toBe(false);
      expect(policy.decide(request, owner, source, "wrong-step")).toBe(false);
      expect(
        policy.decide(
          request,
          owner,
          { ...source, listenerId: "other-listener" },
          step.id,
        ),
      ).toBe(false);
      expect(policy.decide(request, owner, source, step.id)).toBe(true);
      expect(policy.decide(request, owner, source, step.id)).toBe(false);
    }
  });
});
