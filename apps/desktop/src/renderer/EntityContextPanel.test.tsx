// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyntheticMetricRecordStreamFixture } from "@ableton-agent/protocol/testing";
import type {
  DesktopContextDetail,
  DesktopContextPage,
  DesktopEntityContextApi,
} from "../context-contracts.js";
import { EntityContextPanel } from "./EntityContextPanel.js";

const entry: DesktopContextPage["entries"][number] = {
  contextId: "context",
  passId: "pass",
  listenerId: "listener",
  subjectId: "subject",
  kind: "metric-record-stream-context/v1",
  createdAt: "2026-10-12T00:00:00.000Z",
  freshness: "unknown",
  summary: "Known source; attribution unknown",
};
const page: DesktopContextPage = { action: "list", entries: [entry] };
let observation: DesktopContextDetail["observation"];
function detail(contextId = entry.contextId): DesktopContextDetail {
  return {
    action: "get",
    entry: { ...entry, contextId },
    observation,
  };
}
function api() {
  return {
    getMetricCapture: vi.fn<DesktopEntityContextApi["getMetricCapture"]>(
      async () => undefined,
    ),
    listMetricChunks: vi.fn<DesktopEntityContextApi["listMetricChunks"]>(
      async () => ({ items: [], encodedBytes: 2 }),
    ),
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
beforeEach(async () => {
  const fixture = await createSyntheticMetricRecordStreamFixture();
  const { rows, ...geometry } = fixture.descriptor.geometry;
  void rows;
  observation = {
    schema: "metric-record-stream-context/v1",
    captureId: "stream-capture",
    descriptorDigest: fixture.state.descriptorDigest,
    descriptor: { ...fixture.descriptor, geometry },
  };
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

describe("stored stream context presentation", () => {
  it("requests detail only on demand without inventing legacy summaries or loading chunks", async () => {
    const source = api();
    await render("session", source);
    expect(source.list).toHaveBeenCalledWith({
      sessionId: "session",
      includeHistorical: false,
      limit: 20,
    });
    expect(container.textContent).toContain("unknown");
    expect(source.get).not.toHaveBeenCalled();
    await click("View observation context");
    expect(source.get).toHaveBeenCalledWith({
      sessionId: "session",
      contextId: "context",
      includeHistorical: false,
    });
    const view = container.querySelector('[aria-label="Observation detail"]');
    expect(view?.textContent).toContain("stream-capture");
    expect(view?.textContent).toContain("48000 Hz");
    expect(view?.textContent).toContain("mel-bands");
    expect(view?.textContent).toContain("not a measurement summary");
    expect(view?.textContent).not.toContain("RMS (dBFS");
    expect(source.getMetricCapture).not.toHaveBeenCalled();
    expect(source.listMetricChunks).not.toHaveBeenCalled();
  });

  it.each(["pending", "ready", "failed", "cancelled"])(
    "keeps original context readable when derived features are %s",
    async (status) => {
      const source = api();
      const summary = `Known source. Derived features ${status}; original stream retained`;
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
      expect(container.textContent).toContain("stream-capture");
      expect(source.get).toHaveBeenCalledTimes(1);
    },
  );

  it("distinguishes unavailable storage and no App session", async () => {
    await render(undefined, undefined);
    expect(container.textContent).toContain("No active App session");
    await render("session", undefined);
    expect(container.textContent).toContain("storage is unavailable");
  });

  it("clears copied session IDs and late results when the profile epoch changes", async () => {
    const source = api();
    let finish!: (value: DesktopContextPage) => void;
    source.list.mockImplementationOnce(
      () =>
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

  it("exposes failed queries and recovery instead of an empty successful inventory", async () => {
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

  it("makes historical inclusion explicit and replaces bounded pages", async () => {
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
    let finish!: (value: DesktopContextPage) => void;
    source.list.mockImplementationOnce(
      () =>
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
  });

  it("rejects foreign detail identity and clears old detail on a session switch", async () => {
    const source = api();
    await render("session", source);
    source.get.mockResolvedValueOnce(detail("foreign-context"));
    await click("View observation context");
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "different observation",
    );
    expect(container.textContent).not.toContain("stream-capture");
    await click("View observation context");
    expect(container.textContent).toContain("stream-capture");
    await render("other-session", source);
    expect(container.textContent).not.toContain("stream-capture");
  });
});
