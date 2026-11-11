import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MEL_BAND_PROFILE,
  projectMetricListeningReport,
} from "@ableton-agent/protocol";
import { createDefaultAssertions } from "./assertions.js";
import { verifyAgentListeningResult } from "./agent-listening-result.js";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import {
  projectMelSmoke,
  validateMelSmoke,
  verifyMelSmoke,
  type MelSmokeEvidence,
} from "./mel-smoke.js";
import {
  validateEvidence,
  validateScenario,
  validateTurn,
} from "./validation.js";
import type {
  FixtureManifest,
  RunEvidence,
  ScenarioManifest,
} from "./contracts.js";

function reportPages(evidence: MelSmokeEvidence) {
  return evidence.reportProjection.pages.map(({ offset }) =>
    projectMetricListeningReport(evidence.observation, { offset, limit: 32 }),
  );
}

describe("bounded Session mel smoke (synthetic, not acoustic qualification)", () => {
  it("bounds derivable report-page receipts without discarding the complete observation", () => {
    const f = melSmokeFixture();
    expect(
      Buffer.byteLength(JSON.stringify(f.smoke.reportProjection)),
    ).toBeLessThan(2048);
    expect(f.smoke.observation).toEqual(f.observation);
    expect(() => validateMelSmoke(f.smoke)).not.toThrow();
    expect(f.smoke.reportProjection.pages.map((page) => page.sha256)).toEqual(
      reportPages(f.smoke).map((page) =>
        createHash("sha256").update(JSON.stringify(page)).digest("hex"),
      ),
    );
  });
  it("adds exactly one approved scenario without changing rolloff guards or fixture", async () => {
    const read = async (path: string): Promise<unknown> =>
      JSON.parse(
        await readFile(
          new URL(`../../../../integration/${path}`, import.meta.url),
          "utf8",
        ),
      );
    const previous = (await read(
      "acceptance-scenarios/session-flucoma-rolloff-smoke.json",
    )) as ScenarioManifest;
    const scenario = (await read(
      "acceptance-scenarios/session-flucoma-melbands-smoke.json",
    )) as ScenarioManifest;
    const fixture = (await read(
      "fixtures/session-clip-identify/fixture.json",
    )) as FixtureManifest;
    const suite = (await read("acceptance-scenarios/suite.json")) as {
      scenarios: string[];
    };
    const registry = createDefaultAssertions();
    validateScenario(scenario, fixture, registry.names);
    for (const assertion of [
      ...scenario.assertions,
      ...scenario.steps.flatMap((step) => step.assertions),
    ])
      registry.validate(assertion);
    expect(suite.scenarios.filter((id) => id === scenario.id)).toHaveLength(1);
    expect(scenario.fixtureId).toBe("session-clip-identify");
    expect(scenario.permissions).toEqual(previous.permissions);
    expect(scenario.budget).toEqual(previous.budget);
    expect(scenario.requiredCapabilities).toEqual(
      previous.requiredCapabilities,
    );
    expect(scenario.steps).toHaveLength(1);
    expect(scenario.steps[0]!.message).toBe(
      "Listen to the first Session clip on track audio-track, including mel bands and low/mid and high/mid ratios.",
    );
    expect(
      scenario.assertions.filter(({ name }) => name !== "melbands-smoke"),
    ).toEqual(previous.assertions);
    const before = structuredClone(previous.steps[0]!.assertions);
    Object.assign(before.find(({ name }) => name === "capture")!.parameters, {
      metricFamilies: "level,spectral-centroid,attacks,mel-bands",
    });
    expect(
      scenario.steps[0]!.assertions.filter(
        ({ name }) => name !== "melbands-smoke",
      ),
    ).toEqual(before);
  });
  it.each(["get", "report"] as const)(
    "requires same-agent actual %s consumption and typed persistence",
    (action) => {
      const f = melSmokeFixture(action);
      validateTurn(f.turn);
      verifyMelSmoke(f.input, "a", false);
      verifyAgentListeningResult(f.input, "a");
      const evidence: RunEvidence = {
        schemaVersion: 1,
        facts: f.turn.facts,
        unchanged: [],
        contexts: f.turn.contexts.map((entry) => ({
          ...entry,
          afterOwnedRestart: true,
        })),
        melSmoke: [
          projectMelSmoke(f.observation, f.contextId, true, f.history, true),
        ],
      };
      validateEvidence(evidence);
      verifyMelSmoke({ ...f.input, evidence }, "a", true);
      expect(f.smoke.observation.metrics["mel-bands"]!.frames).toHaveLength(43);
      expect(
        reportPages(f.smoke)[0]!.metricMetadata["mel-bands"]!.trailingSupport,
      ).toEqual({ startSample: 88064, endSample: 90000 });
      expect(f.smoke.reportProjection.provenance).toBe(
        "typed-desktop-context-projection",
      );
      expect(f.smoke.reportProjection.pages.length).toBeGreaterThan(1);
      expect(
        reportPages(f.smoke)
          .flatMap((page) =>
            page.rows.flatMap((row) => row["mel-bands"]!.frames),
          )
          .map((frame) => ({
            index: frame.index,
            support: frame.support,
            magnitudes: frame.analysis.magnitudes,
          })),
      ).toEqual(f.observation.metrics["mel-bands"]!.frames);
    },
  );
  it.each([
    [
      "absent mel",
      (f: ReturnType<typeof melSmokeFixture>) => {
        delete f.smoke.observation.metrics["mel-bands"];
      },
    ],
    [
      "short vector",
      (f: ReturnType<typeof melSmokeFixture>) => {
        (
          f.smoke.observation.metrics["mel-bands"]!.frames[0]!
            .magnitudes[0] as unknown as number[]
        ).pop();
      },
    ],
    [
      "stale profile",
      (f: ReturnType<typeof melSmokeFixture>) => {
        Object.assign(f.smoke.observation.metrics["mel-bands"]!.profile, {
          normalize: 1,
        });
      },
    ],
    [
      "missing frame",
      (f: ReturnType<typeof melSmokeFixture>) => {
        (f.smoke.observation.metrics["mel-bands"]!.frames as unknown[]).pop();
      },
    ],
    [
      "wrong support",
      (f: ReturnType<typeof melSmokeFixture>) => {
        Object.assign(
          f.smoke.observation.metrics["mel-bands"]!.frames[0]!.support,
          { startSample: 1 },
        );
      },
    ],
    [
      "silent right",
      (f: ReturnType<typeof melSmokeFixture>) => {
        for (const frame of f.smoke.observation.metrics["mel-bands"]!.frames)
          (frame.magnitudes[1] as unknown as number[]).fill(0);
      },
    ],
    [
      "cleanup pending",
      (f: ReturnType<typeof melSmokeFixture>) => {
        Object.assign(f.smoke, { cleanupComplete: false });
      },
    ],
    [
      "truncated page",
      (f: ReturnType<typeof melSmokeFixture>) => {
        Object.assign(f.smoke.reportProjection.pages[0]!, { rowCount: 0 });
      },
    ],
    [
      "missing page",
      (f: ReturnType<typeof melSmokeFixture>) => {
        (f.smoke.reportProjection.pages as unknown[]).pop();
      },
    ],
  ])("rejects %s independently of healthy old metrics", (_name, mutate) => {
    const f = structuredClone(melSmokeFixture());
    mutate(f);
    expect(() => validateMelSmoke(f.smoke)).toThrow();
  });
  it.each([
    "traceId",
    "correlationId",
    "passId",
    "listenerId",
    "generation",
    "nativeEpoch",
    "connectionId",
    "connectionEpoch",
  ])("rejects foreign %s", (key) => {
    const f = structuredClone(melSmokeFixture());
    Object.assign(f.smoke.observation.ownership, {
      [key]: key === "nativeEpoch" ? 9 : "foreign",
    });
    expect(() => verifyMelSmoke(f.input, "a", false)).toThrow();
  });
  it("rejects changed valid report vectors and derived ratios instead of trusting old statuses", () => {
    const f = structuredClone(melSmokeFixture("report"));
    const wrong = structuredClone(f.observation);
    Object.assign(wrong.metrics["mel-bands"]!.frames[0]!.magnitudes[0], {
      0: 50,
    });
    Object.assign(f.context, { report: projectMetricListeningReport(wrong) });
    expect(() => verifyAgentListeningResult(f.input, "a")).toThrow(
      /matching mel/,
    );
    Object.assign(f.smoke.reportProjection, {
      pages: [projectMetricListeningReport(wrong, { limit: 32 })],
    });
    expect(() => validateMelSmoke(f.smoke)).toThrow();
  });
  it("rejects a fabricated ratio even when raw vectors and all metric statuses remain healthy", () => {
    const f = structuredClone(melSmokeFixture("report"));
    if (!("report" in f.context)) throw new Error("Missing synthetic report");
    const frame = f.context.report.rows.flatMap(
      (row) => row["mel-bands"]!.frames,
    )[0]!;
    Object.assign(frame.analysis.ratios[0].lowMid, { value: 12345 });
    expect(() => verifyAgentListeningResult(f.input, "a")).toThrow();
    const changedPage = structuredClone(reportPages(f.smoke)[0]!);
    const projected = changedPage.rows.flatMap(
      (row) => row["mel-bands"]!.frames,
    )[0]!;
    Object.assign(projected.analysis.ratios[0].lowMid, { value: 12345 });
    Object.assign(f.smoke.reportProjection.pages[0]!, {
      sha256: createHash("sha256")
        .update(JSON.stringify(changedPage))
        .digest("hex"),
    });
    expect(() => validateMelSmoke(f.smoke)).toThrow();
  });
  it.each([
    ["zero-denominator", 0],
    ["below-floor", 1e-14],
  ] as const)(
    "accepts explicitly derived %s ratios without inventing a numeric value",
    (reason, mid) => {
      const f = melSmokeFixture();
      const observation = structuredClone(f.observation);
      for (const frame of observation.metrics["mel-bands"]!.frames)
        for (const vector of frame.magnitudes)
          for (const band of MEL_BAND_PROFILE.bands)
            if (band.region === "mid")
              Object.assign(vector, { [band.index]: mid });
      const evidence = projectMelSmoke(
        observation,
        f.contextId,
        true,
        f.history,
      );
      const ratios = reportPages(evidence).flatMap((page) =>
        page.rows.flatMap((row) =>
          row["mel-bands"]!.frames.flatMap((frame) => frame.analysis.ratios),
        ),
      );
      expect(ratios.length).toBe(86);
      expect(
        ratios.every(
          (entry) =>
            entry.lowMid.reason === reason &&
            entry.highMid.reason === reason &&
            entry.lowMid.value === null &&
            entry.highMid.value === null,
        ),
      ).toBe(true);
    },
  );
  it.each(["refused", "failed", "cancelled"])(
    "rejects %s turns and missing smoke evidence",
    (status) => {
      const f = melSmokeFixture();
      Object.assign(f.turn, { status });
      expect(() => verifyMelSmoke(f.input, "a", false)).toThrow();
      Object.assign(f.turn, { status: "completed", melSmoke: undefined });
      expect(
        createDefaultAssertions().evaluate(
          {
            name: "melbands-smoke",
            parameters: { sourceId: "a", afterRestart: false },
          },
          f.input,
        ).passed,
      ).toBe(false);
    },
  );
  it.each([
    ["melLoadedBinaryVerified", false],
    ["melLoadedBinarySchema", "owned-mapped-flucoma/v1"],
    ["melLoadedBinarySha256", "0".repeat(64)],
    ["melLoadedBinaryPath", "/global/fluid.spectralshape~"],
    ["melLoadedBinaryPids", "1,1"],
    ["melLoadedBinaryInode", "0"],
    ["melLoadedBinaryDevice", ""],
    ["melLoadedBinaryDurationMs", -1],
    ["melLoadedBinaryPhase", "baseline"],
    ["melLoadedBinaryState", "cancelled"],
    ["melLoadedBinaryPassId", "foreign"],
    ["melLoadedBinaryTraceId", "foreign"],
    ["melLoadedBinaryNativeEpoch", 99],
    ["melLoadedBinaryGeneration", "foreign"],
    ["melLoadedBinaryConnectionId", "foreign"],
  ])(
    "rejects missing or foreign mapped acquisition proof %s despite healthy mel receipt",
    (key, value) => {
      const f = melSmokeFixture();
      Object.assign(f.turn.facts, { [key]: value });
      expect(() => verifyMelSmoke(f.input, "a", false)).toThrow();
    },
  );
  it("requires independent pinned baseline mapping and stable capture identity", () => {
    const f = melSmokeFixture();
    Object.assign(f.input.baseline.facts, { melLoadedBinaryVerified: false });
    expect(() => verifyMelSmoke(f.input, "a", false)).toThrow();
    Object.assign(f.input.baseline.facts, {
      melLoadedBinaryVerified: true,
      melLoadedBinaryInode: "124",
    });
    expect(() => verifyMelSmoke(f.input, "a", false)).toThrow(
      /changed between/,
    );
  });
  it("retains the original capture mapping binding after restart without claiming remapping", () => {
    const f = melSmokeFixture();
    expect(() =>
      verifyMelSmoke(
        {
          ...f.input,
          evidence: {
            schemaVersion: 1,
            facts: { ...f.turn.facts, melLoadedBinaryPassId: "foreign" },
            unchanged: [],
            melSmoke: [{ ...f.smoke, afterOwnedRestart: true }],
            contexts: f.turn.contexts.map((entry) => ({
              ...entry,
              afterOwnedRestart: true,
            })),
          },
        },
        "a",
        true,
      ),
    ).toThrow(/mapped acquisition proof changed/);
  });
});
