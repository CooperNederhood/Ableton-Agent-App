// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  classifyPitchEstimate,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  type PitchTimeline,
  type SpectralShapeTimeline,
} from "@ableton-agent/protocol";
import { AnalyzerTimelineDetail } from "./AnalyzerTimelineDetail.js";

function pitchFixture(): PitchTimeline {
  return pitchTimelineSchema.parse({
    schema: "pitch-timeline/v1",
    status: "partial",
    profile: PITCH_PROFILE,
    sampleRate: 48000,
    sourceSupport: { startSample: 10000, endSample: 16151 },
    expectedRecords: 3,
    trailingSupport: { startSample: 16144, endSample: 16151 },
    frames: [
      {
        index: 0,
        support: { startSample: 10000, endSample: 12048 },
        channels: [
          classifyPitchEstimate(440, 0.99),
          classifyPitchEstimate(0, 0),
        ],
      },
      {
        index: 2,
        support: { startSample: 14096, endSample: 16144 },
        channels: [
          { state: "silence", hz: null, confidence: null },
          classifyPitchEstimate(220, 0.25),
        ],
      },
    ],
    gaps: [
      {
        firstIndex: 1,
        count: 1,
        support: { startSample: 12048, endSample: 14096 },
        reason: "sequence-gap",
      },
    ],
  });
}
function shapeFixture(): SpectralShapeTimeline {
  return spectralShapeTimelineSchema.parse({
    schema: "spectral-shape-timeline/v1",
    status: "complete",
    profile: SPECTRAL_SHAPE_PROFILE,
    sampleRate: 48000,
    sourceSupport: { startSample: 10000, endSample: 12048 },
    expectedRecords: 1,
    trailingSupport: null,
    gaps: [],
    frames: [
      {
        index: 0,
        support: { startSample: 10000, endSample: 12048 },
        channels: [
          { state: "valid", flatnessDb: -120, spreadHz: 0, rolloffHz: 1000 },
          {
            state: "undefined",
            flatnessDb: null,
            spreadHz: null,
            rolloffHz: null,
          },
        ],
      },
    ],
  });
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(
  timeline: PitchTimeline | SpectralShapeTimeline,
  contextId = "source",
) {
  await act(async () =>
    root.render(
      <AnalyzerTimelineDetail
        contextId={contextId}
        timeline={timeline}
        gapDetails={<p>Explicit acquisition gap details</p>}
      />,
    ),
  );
}
function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (found === null) throw new Error(`Missing ${label}`);
  return found;
}

describe("authoritative analyzer context presentation", () => {
  it("keeps raw rejected pitch, undefined zero and independent confidence visible", async () => {
    await render(pitchFixture());
    expect(container.textContent).toContain("2/3 validated acquisition frames");
    expect(container.textContent).toContain("1 missing");
    expect(container.textContent).toContain("[16144, 16151)");
    expect(container.textContent).toContain("not probability");
    expect(container.textContent).toContain("known 2000 Hz sine");
    const table = container.querySelector(
      'table[aria-label="Pitch estimates and confidence"]',
    );
    expect(table?.textContent).toContain(
      "Accepted estimate (not verified pitch)",
    );
    expect(table?.textContent).toContain("0 (undefined sentinel)");
    expect(
      table?.querySelectorAll("tbody tr")[1]?.lastElementChild?.textContent,
    ).toBe("0");
    expect(button("Previous pitch frame").disabled).toBe(true);
    await act(async () => button("Next pitch frame").click());
    expect(container.textContent).toContain(
      "Frame 2: source samples [14096, 16144)",
    );
    expect(table?.textContent).toContain("Measured silence; no pitch estimate");
    expect(table?.textContent).toContain("Low confidence estimate");
    expect(table?.textContent).toContain("220");
    expect(table?.textContent).toContain("0.25");
    expect(button("Next pitch frame").disabled).toBe(true);
    await act(async () => button("Previous pitch frame").click());
    expect(container.textContent).toContain("Frame 0:");
  });

  it("distinguishes signed flatness and measured zero from undefined descriptors", async () => {
    await render(shapeFixture());
    expect(container.textContent).toContain(
      "Acquisition completeness does not imply usable descriptors",
    );
    expect(container.textContent).toContain("95-percent rolloff");
    const rows = container.querySelectorAll(
      'table[aria-label="Spectral shape measurements"] tbody tr',
    );
    expect(
      [...rows[0]!.querySelectorAll("td")].map((cell) => cell.textContent),
    ).toEqual(["valid", "-120", "0", "1000"]);
    expect(
      [...rows[1]!.querySelectorAll("td")].map((cell) => cell.textContent),
    ).toEqual(["undefined", "Unavailable", "Unavailable", "Unavailable"]);
    expect(button("Next spectral-shape frame").disabled).toBe(true);
  });

  it("shows failed acquisition without substituting silence or retaining another context's frame", async () => {
    await render(pitchFixture());
    await act(async () => button("Next pitch frame").click());
    const failed = pitchTimelineSchema.parse({
      ...pitchFixture(),
      status: "failed",
      frames: [],
      gaps: [
        {
          firstIndex: 0,
          count: 3,
          support: { startSample: 10000, endSample: 16144 },
          reason: "drain-timeout",
        },
      ],
    });
    await render(failed, "failed-source");
    expect(container.textContent).toContain(
      "No retained pitch frames; descriptors unavailable",
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Explicit acquisition gap details");
    await render(pitchFixture(), "different-source");
    expect(container.textContent).toContain("Frame 0:");
    expect(button("Previous pitch frame").disabled).toBe(true);
  });
});
