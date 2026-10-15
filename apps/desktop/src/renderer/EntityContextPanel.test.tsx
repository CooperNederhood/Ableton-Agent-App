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
import { audioObservationV2Schema } from "@ableton-agent/protocol";

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
  it.each([
    [44_100, 64, "1.451", 128, "2.902", "0.726"],
    [48_000, 64, "1.333", 128, "2.667", "0.667"],
    [44_100, 0, "0.000", 0, "0.000", "0.000"],
    [48_000, 0, "0.000", 0, "0.000", "0.000"],
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
      const row = (label: string) =>
        [...container.querySelectorAll("dt")].find(
          (item) => item.textContent === label,
        )?.nextElementSibling?.textContent;
      expect(row("Configured acceptance limit")).toContain(
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
