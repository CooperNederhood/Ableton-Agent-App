// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopContextDetail,
  DesktopContextPage,
  DesktopEntityContextApi,
} from "../context-contracts.js";
import { EntityContextPanel } from "./EntityContextPanel.js";
import {
  audioObservationV2Schema,
  createMetricObservationReportRows,
  metricAudioObservationSchema,
  MEL_BAND_PROFILE,
  melBandTimelineSchema,
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  classifyPitchEstimate,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  type MetricAudioObservation,
} from "@ableton-agent/protocol";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";

function metricFixture(endBeat = 4): MetricAudioObservation {
  return createSyntheticMetricListeningObservation({ endBeat });
}

function metricDetail(value: MetricAudioObservation): DesktopContextDetail {
  value.rows = createMetricObservationReportRows(value);
  return {
    action: "get",
    entry: { ...entry, kind: value.schema },
    observation: metricAudioObservationSchema.parse(value),
  };
}

function melFixture(missing: "none" | "one" | "all" = "none", endBeat = 0.2) {
  const value = metricFixture(endBeat);
  const expectedRecords = Math.floor(value.geometry.totalSamples / 2_048);
  const frames = Array.from({ length: expectedRecords }, (_, index) => ({
    index,
    support: {
      startSample: value.geometry.startSample + index * 2_048,
      endSample: value.geometry.startSample + (index + 1) * 2_048,
    },
    magnitudes: [
      Array.from({ length: 24 }, (_, band) => (index === 0 ? band + 1 : 0)),
      Array.from({ length: 24 }, (_, band) =>
        index === 0 ? band + 101 : band === 2 ? 1e-12 : 1,
      ),
    ],
  }));
  const retained = (index: number) =>
    missing === "none" || (missing === "one" && index !== 0);
  value.requestedMetrics.push("mel-bands");
  value.metrics["mel-bands"] = melBandTimelineSchema.parse({
    schema: "mel-band-timeline/v1",
    status:
      expectedRecords === 0 || missing === "none"
        ? "complete"
        : missing === "all"
          ? "failed"
          : "partial",
    sampleRate: value.geometry.sampleRate,
    sourceSupport: value.sourceCoverage,
    profile: MEL_BAND_PROFILE,
    expectedRecords,
    frames: frames.filter((frame) => retained(frame.index)),
    gaps: frames
      .filter((frame) => !retained(frame.index))
      .map((frame) => ({
        firstIndex: frame.index,
        count: 1,
        support: frame.support,
        reason: "drain-timeout",
      })),
  });
  value.outcome =
    missing === "none" || expectedRecords === 0 ? "complete" : "partial";
  return value;
}

function analyzerFixture() {
  const value = metricFixture(0.2);
  const start = value.geometry.startSample;
  const supports = [0, 1].map((index) => ({
    startSample: start + index * 2048,
    endSample: start + (index + 1) * 2048,
  }));
  const common = {
    sampleRate: value.geometry.sampleRate,
    sourceSupport: value.sourceCoverage,
    expectedRecords: 2,
    trailingSupport: {
      startSample: start + 4096,
      endSample: value.geometry.endSample,
    },
  };
  value.requestedMetrics.push("pitch", "spectral-shape");
  value.metrics.pitch = pitchTimelineSchema.parse({
    ...common,
    schema: "pitch-timeline/v1",
    status: "partial",
    profile: PITCH_PROFILE,
    frames: [
      {
        index: 1,
        support: supports[1],
        channels: [
          classifyPitchEstimate(440, 0.99),
          classifyPitchEstimate(220, 0.25),
        ],
      },
    ],
    gaps: [
      {
        firstIndex: 0,
        count: 1,
        support: supports[0],
        reason: "sequence-gap",
      },
    ],
  });
  value.metrics["spectral-shape"] = spectralShapeTimelineSchema.parse({
    ...common,
    schema: "spectral-shape-timeline/v1",
    status: "complete",
    profile: SPECTRAL_SHAPE_PROFILE,
    frames: supports.map((support, index) => ({
      index,
      support,
      channels: [
        {
          state: "valid",
          flatnessDb: -120 + index,
          spreadHz: 0,
          rolloffHz: 1000,
        },
        { state: "silence", flatnessDb: null, spreadHz: null, rolloffHz: null },
      ],
    })),
    gaps: [],
  });
  value.outcome = "partial";
  return value;
}

const entry: DesktopContextPage["entries"][number] = {
  contextId: "context",
  passId: "pass",
  listenerId: "listener",
  subjectId: "subject",
  kind: "audio-observation/v1",
  createdAt: "2026-10-12T00:00:00.000Z",
  freshness: "unknown",
  summary: "Known source; attribution unknown; RMS is not LUFS",
};
const page: DesktopContextPage = { action: "list", entries: [entry] };
function detail(
  contextId = entry.contextId,
  frequency = 440,
): DesktopContextDetail {
  return {
    action: "get",
    entry: { ...entry, contextId },
    observation: {
      schema: "audio-observation/v1",
      listenerId: entry.listenerId,
      passId: entry.passId,
      sampleRate: 48_000,
      startSample: 0,
      endSample: 96_000,
      startBeat: 0,
      endBeat: 4,
      complete: true,
      limitations: ["Synthetic UI fixture"],
      algorithm: {
        name: "synthetic",
        version: "1",
        windowSamples: 2048,
        hopSamples: 4800,
        settings: { attackThresholdDb: 6, minAttackSpacingSamples: 6000 },
        units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
        timingUncertaintySamples: 64,
      },
      summaries: {
        peak: [0.5, 0.5],
        rmsDbfs: [-12, -12],
        centroidHz: frequency,
      },
      samples: [],
      attacks: [],
      reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
    },
  };
}
function api() {
  return {
    list: vi.fn<DesktopEntityContextApi["list"]>(async () => page),
    get: vi.fn<DesktopEntityContextApi["get"]>(async ({ contextId }) =>
      detail(contextId),
    ),
  };
}
let root: Root;
let container: HTMLDivElement;
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
};
const previousActFlag = environment.IS_REACT_ACT_ENVIRONMENT;
beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
});
async function render(
  sessionId: string | undefined,
  source: DesktopEntityContextApi | undefined,
  contextEpoch = 0,
) {
  await act(async () => {
    root.render(
      <EntityContextPanel
        sessionId={sessionId}
        api={source}
        contextEpoch={contextEpoch}
      />,
    );
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === text,
  );
  if (button === undefined) throw new Error(`Missing button ${text}`);
  await act(async () => button.click());
}

describe("stored listening context presentation", () => {
  it.each(["pending", "ready", "failed", "cancelled"])(
    "keeps measured observations readable when derived features are %s",
    async (status) => {
      const source = api();
      const summary = `Known source. Derived features ${status}; measured observation retained`;
      source.list.mockResolvedValue({
        action: "list",
        entries: [{ ...entry, summary }],
      });
      source.get.mockResolvedValue({
        ...detail(),
        entry: { ...entry, summary },
      });
      await render("session", source);
      expect(container.textContent).toContain(`Derived features ${status}`);
      await click("View observation context");
      expect(container.textContent).toContain("440");
      expect(source.get).toHaveBeenCalledTimes(1);
    },
  );

  it("opens authoritative analyzer timelines while preserving healthy measurements and independent gaps", async () => {
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(analyzerFixture()));
    await render("session", source);
    await click("View observation context");
    const pitch = container.querySelector('[aria-label="pitch metric"]');
    const shape = container.querySelector(
      '[aria-label="spectral-shape metric"]',
    );
    expect(pitch?.textContent).toContain("pitch: partial");
    expect(pitch?.textContent).toContain("1/2 validated acquisition frames");
    expect(pitch?.textContent).toContain("Frame 1:");
    expect(pitch?.textContent).toContain("Low confidence estimate");
    expect(pitch?.textContent).toContain("sequence-gap");
    expect(pitch?.textContent).toContain("220");
    expect(shape?.textContent).toContain("spectral-shape: complete");
    expect(shape?.textContent).toContain("-120");
    expect(shape?.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("level: complete");
    await click("Next spectral-shape frame");
    expect(shape?.textContent).toContain("Frame 1:");
    expect(shape?.textContent).toContain("-119");
    expect(pitch?.textContent).toContain("Frame 1:");
    expect(source.get).toHaveBeenCalledTimes(1);
  });

  it("renders all 24 independent mel bands, pinned units and actual source support", async () => {
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(melFixture()));
    await render("session", source);
    await click("View observation context");
    const mel = container.querySelector('[aria-label="mel-bands metric"]');
    expect(mel?.textContent).toContain("mel-bands: complete");
    expect(mel?.textContent).toContain("Uncalibrated linear FFT magnitudes");
    expect(mel?.textContent).toContain("independent-stereo");
    expect(mel?.textContent).toContain("normalize 0; scale 0");
    expect(mel?.textContent).toContain("2/2 retained frames");
    expect(mel?.textContent).toContain("samples [10000, 14800)");
    expect(mel?.textContent).toContain("samples [14096, 14800)");
    const table = mel?.querySelector('[aria-label="Mel-band magnitudes"]');
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(24);
    const last = table?.querySelector("tbody tr:last-child");
    expect(last?.textContent).toContain("23");
    expect(last?.textContent).toContain("20000");
    expect(last?.querySelector('[data-channel="left"]')?.textContent).toBe(
      "24.000000",
    );
    expect(last?.querySelector('[data-channel="right"]')?.textContent).toBe(
      "124.00000",
    );
    expect(container.textContent).not.toContain("warmth");
    expect(container.textContent).not.toContain("muddiness");
  });

  it("pages retained frames without dropping bands and distinguishes zero and below-floor ratios", async () => {
    const value = melFixture();
    const mel = value.metrics["mel-bands"]!;
    value.metrics["mel-bands"] = melBandTimelineSchema.parse({
      ...mel,
      frames: mel.frames.map((frame) =>
        frame.index === 0
          ? frame
          : {
              ...frame,
              magnitudes: [
                Array<number>(24).fill(0),
                Array.from({ length: 24 }, (_, band) =>
                  band === 2 ? 1e-12 : band >= 2 && band < 9 ? 0 : 1,
                ),
              ],
            },
      ),
    });
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(value));
    await render("session", source);
    await click("View observation context");
    await click("Next mel-band frame");
    const section = container.querySelector('[aria-label="mel-bands metric"]');
    expect(section?.textContent).toContain("Frame 1");
    expect(section?.textContent).toContain("samples [12048, 14096)");
    expect(section?.textContent).toContain("Unavailable (zero-denominator)");
    expect(section?.textContent).toContain("Unavailable (below-floor)");
    expect(
      section?.querySelectorAll('[aria-label="Mel-band magnitudes"] tbody tr'),
    ).toHaveLength(24);
    expect(
      section?.querySelector<HTMLButtonElement>(
        '[aria-label="Next mel-band frame"]',
      )?.disabled,
    ).toBe(true);
    await click("Previous mel-band frame");
    expect(section?.textContent).toContain("Frame 0");
    expect(section?.textContent).not.toContain(
      "Unavailable (zero-denominator)",
    );
  });

  it.each(["one", "all"] as const)(
    "shows %s missing mel frame coverage independently of healthy native metrics",
    async (missing) => {
      const source = api();
      source.get.mockResolvedValueOnce(metricDetail(melFixture(missing)));
      await render("session", source);
      await click("View observation context");
      const section = container.querySelector(
        '[aria-label="mel-bands metric"]',
      );
      expect(section?.textContent).toContain(
        missing === "one" ? "mel-bands: partial" : "mel-bands: failed",
      );
      expect(section?.textContent).toContain("drain-timeout");
      expect(section?.textContent).toContain("not silence");
      expect(
        section?.querySelectorAll(
          '[aria-label="Mel-band magnitudes"] tbody tr',
        ),
      ).toHaveLength(missing === "one" ? 24 : 0);
      expect(container.textContent).toContain("level: complete");
    },
  );

  it("shows a valid zero numerator ratio as zero with a healthy mid denominator", async () => {
    const value = melFixture();
    const mel = value.metrics["mel-bands"]!;
    value.metrics["mel-bands"] = melBandTimelineSchema.parse({
      ...mel,
      frames: mel.frames.map((frame) => ({
        ...frame,
        magnitudes: Array.from({ length: 2 }, () =>
          Array.from({ length: 24 }, (_, band) =>
            band >= 2 && band < 9 ? 1 : 0,
          ),
        ),
      })),
    });
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(value));
    await render("session", source);
    await click("View observation context");
    const ratios = container.querySelector(
      '[aria-label="Mel-band frame ratios"]',
    );
    expect(
      [...ratios!.querySelectorAll("tbody td")].map((cell) => cell.textContent),
    ).toEqual(["0", "0", "0", "0"]);
    expect(ratios?.textContent).not.toContain("Unavailable");
  });

  it("labels mel no-frame captures and omits the section when mel was not requested", async () => {
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(melFixture("none", 0.01)));
    await render("session", source);
    await click("View observation context");
    const section = container.querySelector('[aria-label="mel-bands metric"]');
    expect(section?.textContent).toContain("no-frame is not silence");
    expect(section?.querySelector("table")).toBeNull();
    source.get.mockResolvedValueOnce(metricDetail(metricFixture()));
    await click("View observation context");
    expect(
      container.querySelector('[aria-label="mel-bands metric"]'),
    ).toBeNull();
  });

  it("clears selected mel frame on context switching and rejects malformed typed detail", async () => {
    const source = api();
    source.list.mockResolvedValueOnce({
      action: "list",
      entries: [entry, { ...entry, contextId: "second" }],
    });
    source.get.mockResolvedValueOnce(metricDetail(melFixture()));
    await render("session", source);
    await click("View observation context");
    await click("Next mel-band frame");
    const second = metricDetail(melFixture());
    second.entry.contextId = "second";
    source.get.mockResolvedValueOnce(second);
    await click("View observation second");
    expect(
      container.querySelector('[aria-label="mel-bands metric"]')?.textContent,
    ).toContain("Frame 0");
    const invalid = metricDetail(melFixture());
    if (invalid.observation.schema !== "metric-audio-observation/v1")
      throw new Error("Expected metric fixture");
    invalid.observation.requestedMetrics.push("mel-bands");
    source.get.mockResolvedValueOnce(invalid);
    await click("View observation context");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="mel-bands metric"]'),
    ).toBeNull();
  });
  it("shows unknown spectral timing as unavailable, not no-frame or measured silence", async () => {
    const observation = metricFixture(1);
    observation.outcome = "partial";
    const spectrum = observation.metrics["spectral-centroid"];
    if (!spectrum.algorithm)
      throw new Error("Expected spectral fixture algorithm");
    spectrum.algorithm.firstFrameEndSample = null;
    spectrum.status = "failed";
    spectrum.expectedRecords = 0;
    spectrum.records = [];
    spectrum.gaps = [];
    spectrum.limitations = [
      "FFT phase unavailable; timed supports cannot be established.",
    ];
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(observation));
    await render("session", source);
    await click("View observation context");
    const rows = container.querySelector('[aria-label="Report rows"]');
    expect(rows?.textContent).toContain(
      "spectral-centroid: unknown-phase; record indices none",
    );
    expect(rows?.textContent).not.toContain("spectral-centroid: no-frame");
    expect(container.textContent).toContain("FFT phase unavailable");
    expect(container.textContent).not.toContain(
      "Silence (measured zero spectral energy)",
    );
  });
  it("labels a report interval with no FFT frame without inventing a silent measurement", async () => {
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(metricFixture(0.01)));
    await render("session", source);
    await click("View observation context");
    const rows = container.querySelector('[aria-label="Report rows"]');
    expect(rows?.textContent).toContain("beats [0, 0.01)");
    expect(rows?.textContent).toContain(
      "spectral-centroid: no-frame; record indices none",
    );
    expect(
      container.querySelector('[aria-label="spectral-centroid records"]')
        ?.textContent,
    ).toContain("No retained data");
    expect(container.textContent).not.toContain(
      "Silence (measured zero spectral energy)",
    );
  });

  it("renders metric completeness, measured values and actual support with accessible bounded pages", async () => {
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(metricFixture()));
    await render("session", source);
    await click("View observation context");
    const text = container.textContent;
    expect(text).toContain("Complete; requested metrics only");
    expect(text).toContain("level: complete");
    expect(text).toContain("-12.04 dBFS");
    expect(text).toContain("500.0 Hz");
    expect(text).toContain("1 estimated attacks in validated window");
    expect(text).toContain("samples [10000, 12048)");
    expect(text).toContain("samples [10000, 14800)");
    expect(text).toContain("not averaged or duplicated measurements");
    expect(text).toContain("Attack windows are independent");
    expect(text).toContain("Approximate; descriptive-only");
    const rows = container.querySelector('[aria-label="Report rows"]');
    expect(rows?.querySelectorAll("li")).toHaveLength(10);
    expect(rows?.textContent).not.toContain("Row 10:");
    const next = rows?.querySelector<HTMLButtonElement>(
      '[aria-label="Next Report rows"]',
    );
    if (!next) throw new Error("Missing row pagination");
    await act(async () => next.click());
    expect(rows?.querySelectorAll("li")).toHaveLength(6);
    expect(rows?.textContent).toContain("Row 10:");
    expect(rows?.textContent).not.toContain("Row 0:");
    const previous = rows?.querySelector<HTMLButtonElement>(
      '[aria-label="Previous Report rows"]',
    );
    if (!previous) throw new Error("Missing previous row page");
    await act(async () => previous.click());
    expect(rows?.textContent).toContain("Row 0:");
    expect(container.textContent).not.toContain("silence/below floor");
  });

  it("distinguishes partial, failed and not-requested metrics from silence and retains gap reasons", async () => {
    const value = metricFixture();
    const removed = value.metrics.level.records.pop()!;
    value.metrics.level.status = "partial";
    value.metrics.level.gaps = [
      {
        firstIndex: removed.index,
        count: 1,
        ...removed.support,
        reason: "sequence-gap",
        detail: "Missing level packet",
      },
    ];
    value.metrics.level.limitations = ["Last reporting interval unavailable"];
    const spectral = value.metrics["spectral-centroid"];
    spectral.status = "failed";
    spectral.gaps = [
      {
        firstIndex: 0,
        count: spectral.expectedRecords,
        startSample: spectral.records[0]!.support.startSample,
        endSample: spectral.records.at(-1)!.support.endSample,
        reason: "drain-timeout",
        detail: "No validated FFT frames",
      },
    ];
    spectral.records = [];
    value.metrics.attacks = {
      status: "not-requested",
      expectedRecords: 0,
      algorithm: null,
      records: [],
      gaps: [],
      limitations: [],
    };
    value.requestedMetrics = ["level", "spectral-centroid"];
    value.outcome = "partial";
    const source = api();
    source.get.mockResolvedValueOnce(metricDetail(value));
    await render("session", source);
    await click("View observation context");
    expect(container.textContent).toContain("Partial; requested metrics only");
    expect(container.textContent).toContain("15/16 validated records");
    expect(container.textContent).toContain("level: partial");
    expect(container.textContent).toContain(
      "sequence-gap: Missing level packet",
    );
    expect(container.textContent).toContain(
      "Last reporting interval unavailable",
    );
    expect(container.textContent).toContain("spectral-centroid: failed");
    expect(container.textContent).toContain(
      "No trustworthy data available; not silence",
    );
    expect(container.textContent).toContain(
      "drain-timeout: No validated FFT frames",
    );
    expect(container.textContent).toContain("attacks: not-requested");
    expect(container.textContent).not.toContain("silence (measured zero)");
    expect(container.textContent).not.toContain("500.0 Hz");
  });

  it("shows measured zero as silence only on measured support and preserves historical metric detail", async () => {
    const value = metricFixture();
    value.metrics.level.records.forEach((record) => {
      record.peak = [0, 0];
      record.rms = [0, 0];
    });
    value.metrics["spectral-centroid"].records.forEach((record) => {
      record.centroidHz = null;
      record.spectralEnergy = 0;
    });
    value.metrics.attacks.records.forEach((window) => {
      window.inputLevel = { peak: [0, 0], rms: [0, 0] };
      window.events = [];
    });
    const source = api();
    source.get.mockResolvedValueOnce({
      ...metricDetail(value),
      entry: { ...entry, kind: value.schema, freshness: "historical" },
    });
    await render("session", source);
    const checkbox = container.querySelector<HTMLInputElement>(
      "input[type=checkbox]",
    )!;
    await act(async () => checkbox.click());
    await click("View observation context");
    expect(source.get).toHaveBeenLastCalledWith({
      sessionId: "session",
      contextId: "context",
      includeHistorical: true,
    });
    expect(container.textContent).toContain("Freshnesshistorical");
    expect(container.textContent).toContain("silence (measured zero)");
    expect(container.textContent).toContain(
      "Silence (measured zero spectral energy); centroid undefined",
    );
    expect(container.textContent).toContain(
      "0 estimated attacks in validated window",
    );
    expect(container.textContent).not.toContain("Infinity");
    expect(container.textContent).not.toContain("Not observed");
  });

  it("rejects observations with no trustworthy metric data instead of inventing silence", async () => {
    const value = metricFixture();
    value.requestedMetrics = ["level"];
    value.metrics.level.status = "failed";
    value.metrics.level.gaps = [
      {
        firstIndex: 0,
        count: 16,
        ...value.sourceCoverage,
        reason: "unavailable",
        detail: "No data",
      },
    ];
    value.metrics.level.records = [];
    for (const name of ["spectral-centroid", "attacks"] as const) {
      value.metrics[name] = {
        status: "not-requested",
        algorithm: null,
        expectedRecords: 0,
        records: [],
        gaps: [],
        limitations: [],
      };
    }
    value.outcome = "partial";
    value.rows = createMetricObservationReportRows(value);
    const source = api();
    source.get.mockResolvedValueOnce({
      action: "get",
      entry: { ...entry, kind: value.schema },
      observation: value,
    });
    await render("session", source);
    await click("View observation context");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.textContent).not.toContain("silence (measured zero)");
    expect(container.querySelector('[aria-label="level metric"]')).toBeNull();
  });

  it.each([
    [44_100, 64, "1.451", 128, "2.902", "0.726"],
    [48_000, 64, "1.333", 128, "2.667", "0.667"],
    [44_100, 0, "0.000", 0, "0.000", "0.000"],
    [48_000, 0, "0.000", 0, "0.000", "0.000"],
    [48_000, 4_800, "100.000", 64, "1.333", "50.000"],
    [48_000, 9_600, "200.000", 64, "1.333", "100.000"],
  ])(
    "shows v2 approximate descriptive quality at actual %i Hz and %i observed samples",
    async (
      sampleRate,
      samples,
      milliseconds,
      configured,
      configuredMs,
      beatMs,
    ) => {
      const source = api();
      const legacy = detail();
      if (legacy.observation.schema !== "audio-observation/v1") {
        throw new Error("Expected legacy observation fixture");
      }
      const { timingUncertaintySamples, ...algorithm } =
        legacy.observation.algorithm;
      expect(timingUncertaintySamples).toBe(64);
      const observation = audioObservationV2Schema.parse({
        ...legacy.observation,
        schema: "audio-observation/v2",
        sampleRate,
        algorithm,
        alignment: {
          schema: "listening-alignment/v2",
          policy: {
            mode: samples === 0 ? "strict" : "descriptive",
            maxClockDisagreementSamples: configured,
          },
          sampleRate,
          vectorSize: 64,
          observedClockDisagreementSamples: samples,
          observedBeatDisagreementSamples: samples / 2,
          alignment: "approximate",
          intendedUse: "descriptive-only",
          estimatedAbsoluteErrorSamples: null,
          verifiedAbsoluteErrorBoundSamples: null,
        },
      });
      source.list.mockResolvedValueOnce({
        ...page,
        entries: [{ ...entry, kind: "audio-observation/v2" }],
      });
      source.get.mockResolvedValueOnce({
        ...legacy,
        entry: { ...entry, kind: "audio-observation/v2" },
        observation,
      });
      await render("session", source);
      await click("View observation context");
      expect(container.textContent).toContain("Approximate; descriptive-only");
      expect(container.textContent).toContain(
        "Constant tempo assumed; stability not independently verified",
      );
      expect(container.textContent).toContain(
        "Tempo automation is unsupported",
      );
      const row = (label: string) =>
        [...container.querySelectorAll("dt")].find(
          (item) => item.textContent === label,
        )?.nextElementSibling?.textContent;
      expect(
        row(
          samples === 0
            ? "Configured acceptance limit"
            : "Advisory timing target",
        ),
      ).toContain(
        `${configured} samples (${configuredMs} ms at ${sampleRate} Hz)`,
      );
      expect(row("Observed clock disagreement")).toBe(
        `${samples} samples (${milliseconds} ms at ${sampleRate} Hz)`,
      );
      expect(row("Observed beat disagreement")).toBe(
        `${samples / 2} samples (${beatMs} ms at ${sampleRate} Hz)`,
      );
      expect(container.textContent).toContain(
        "Estimated absolute timing errorUnknown (not estimated)",
      );
      expect(container.textContent).toContain(
        "Verified absolute error boundUnknown (not verified)",
      );
      expect(container.textContent).not.toContain(
        "Timing uncertainty (legacy v1)",
      );
      if (samples === 0) expect(container.textContent).toContain("no fallback");
      else expect(container.textContent).toContain("not a capture limit");
    },
  );

  it("distinguishes unavailable storage and no App session without fabricating results", async () => {
    await render(undefined, undefined);
    expect(container.textContent).toContain("No active App session");
    await render("session", undefined);
    expect(container.textContent).toContain("storage is unavailable");
  });

  it("clears copied session IDs and late results when the profile epoch changes", async () => {
    const source = api();
    let finish: (value: DesktopContextPage) => void = () => {
      throw new Error("Pending query has not started");
    };
    source.list.mockImplementationOnce(
      async () =>
        new Promise<DesktopContextPage>((resolve) => {
          finish = resolve;
        }),
    );
    await render("same-session-id", source, 1);
    source.list.mockResolvedValueOnce({
      action: "list",
      entries: [{ ...entry, summary: "New-profile observation" }],
    });
    await render("same-session-id", source, 2);
    await act(async () => finish(page));
    expect(container.textContent).toContain("New-profile observation");
    expect(container.textContent).not.toContain("Known source");
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it("shows unknown freshness and requests detail only on demand", async () => {
    const source = api();
    await render("session", source);
    expect(source.list).toHaveBeenCalledWith({
      sessionId: "session",
      includeHistorical: false,
      limit: 20,
    });
    expect(container.textContent).toContain("unknown");
    expect(container.textContent).toContain("Known source");
    expect(source.get).not.toHaveBeenCalled();
    await click("View observation context");
    expect(source.get).toHaveBeenCalledWith({
      sessionId: "session",
      contextId: "context",
      includeHistorical: false,
    });
    expect(container.textContent).toContain("440.0 Hz");
    expect(container.textContent).toContain("not LUFS");
    expect(container.textContent).toContain("Synthetic UI fixture");
    expect(container.textContent).toContain("Timing uncertainty (legacy v1)");
    expect(container.textContent).toContain(
      "64 samples (legacy reported value)",
    );
    expect(container.textContent).not.toContain(
      "Approximate; descriptive-only",
    );
  });

  it("exposes failed queries and recovery without presenting an empty successful inventory", async () => {
    const source = api();
    source.list.mockRejectedValueOnce(
      new Error("Declared context file missing"),
    );
    await render("session", source);
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "file missing",
    );
    expect(container.textContent).not.toContain("No stored observations");
    await click("Retry context query");
    expect(container.textContent).toContain("Known source");
  });

  it("makes historical inclusion explicit and keeps pages bounded rather than appending forever", async () => {
    const source = api();
    source.list.mockResolvedValueOnce({ ...page, nextCursor: "cursor" });
    await render("session", source);
    source.list.mockResolvedValueOnce({
      action: "list",
      entries: [
        { ...entry, contextId: "next", summary: "Next-page observation" },
      ],
    });
    await click("Next context page");
    expect(source.list).toHaveBeenLastCalledWith({
      sessionId: "session",
      includeHistorical: false,
      limit: 20,
      cursor: "cursor",
    });
    expect(container.textContent).toContain("Next-page observation");
    expect(container.textContent).not.toContain("Known source");
    const checkbox = container.querySelector<HTMLInputElement>(
      "input[type=checkbox]",
    );
    if (checkbox === null) throw new Error("Missing historical checkbox");
    await act(async () => checkbox.click());
    expect(source.list).toHaveBeenLastCalledWith({
      sessionId: "session",
      includeHistorical: true,
      limit: 20,
    });
  });

  it("never reveals a late result from a previously selected App session", async () => {
    const source = api();
    let finish: (value: DesktopContextPage) => void = () => {
      throw new Error("Pending query has not started");
    };
    source.list.mockImplementationOnce(
      async () =>
        new Promise<DesktopContextPage>((resolve) => {
          finish = resolve;
        }),
    );
    await render("first-session", source);
    source.list.mockResolvedValueOnce({
      action: "list",
      entries: [{ ...entry, summary: "Second-session observation" }],
    });
    await render("second-session", source);
    await act(async () => finish(page));
    expect(container.textContent).toContain("Second-session observation");
    expect(container.textContent).not.toContain("Known source");
    expect(source.list).toHaveBeenLastCalledWith({
      sessionId: "second-session",
      includeHistorical: false,
      limit: 20,
    });
  });

  it("rejects mismatched detail identity and clears old detail on a session switch", async () => {
    const source = api();
    await render("session", source);
    source.get.mockResolvedValueOnce(detail("foreign-context"));
    await click("View observation context");
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "different observation",
    );
    expect(container.textContent).not.toContain("440.0 Hz");
    await click("View observation context");
    expect(container.textContent).toContain("440.0 Hz");
    await render("other-session", source);
    expect(container.textContent).not.toContain("440.0 Hz");
  });
});
