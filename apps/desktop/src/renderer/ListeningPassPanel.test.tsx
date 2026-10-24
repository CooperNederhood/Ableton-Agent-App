// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAppEvent } from "../contracts.js";
import type {
  DesktopListeningJob,
  DesktopListeningPage,
} from "../listening-contracts.js";
import {
  ListeningPassPanel,
  type ListeningUiApi,
} from "./ListeningPassPanel.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const otherAgentId = "00000000-0000-4000-8000-000000000002";
const job: DesktopListeningJob = {
  passId: "synthetic-component-pass",
  sessionId: "session",
  liveSetId: "set",
  agentId,
  trace: {
    traceId: agentId,
    correlationId: "synthetic-test",
    causationId: "test",
  },
  stage: "queued",
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
  durationMs: 1250,
  contextIds: [],
  cleanupPolicy: "leave-running",
  evidence: "lifecycle-only",
};
const page = (jobs = [job], revision = 0): DesktopListeningPage => ({
  sessionId: "session",
  revision,
  jobs,
});
function source() {
  const listeners = new Set<(event: DesktopAppEvent) => void>();
  const cancel = vi.fn(async () => ({ cancelled: true }));
  const api: ListeningUiApi = {
    listening: { list: vi.fn(async () => page()) },
    agents: { cancel },
    events: {
      subscribe: vi.fn((listener: (event: DesktopAppEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    },
  };
  return {
    api,
    cancel,
    listeners,
    emit: (event: DesktopAppEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}
let root: Root;
let container: HTMLDivElement;
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
};
const previousFlag = environment.IS_REACT_ACT_ENVIRONMENT;
beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = previousFlag;
});
async function render(
  api?: ListeningUiApi,
  sessionId: string | null = "session",
  selected = agentId,
  epoch = 0,
) {
  await act(async () =>
    root.render(
      <ListeningPassPanel
        api={api}
        sessionId={sessionId ?? undefined}
        agentId={selected}
        contextEpoch={epoch}
      />,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === text,
  );
  if (button === undefined) throw new Error(`Missing button ${text}`);
  await act(async () => button.click());
}

describe("owned listening lifecycle presentation (synthetic fixtures only)", () => {
  it("shows exact Session source, local bounds and launch uncertainty without claiming measured completion", async () => {
    const h = source();
    vi.mocked(h.api.listening.list).mockResolvedValueOnce(
      page([
        {
          ...job,
          stage: "starting-playback",
          session: {
            clipName: "Leading rests",
            trackName: "Instrument",
            sceneIndex: 2,
            durationBeats: 4,
            launch: { state: "queued", mutationState: "indeterminate" },
          },
        },
      ]),
    );
    await render(h.api);
    expect(container.textContent).toContain(
      "Session clip Leading rests on Instrument, scene 3",
    );
    expect(container.textContent).toContain("clip-local range [0, 4)");
    expect(container.textContent).toContain("Launch: queued");
    expect(container.textContent).toContain("Host mutation: indeterminate");
    expect(container.textContent).toContain(
      "may still execute after cancellation",
    );
    expect(container.textContent).not.toContain("Source epoch matched");
    await act(async () =>
      h.emit({
        type: "listening.changed",
        page: page(
          [
            {
              ...job,
              stage: "capturing",
              session: {
                clipName: "Leading rests",
                trackName: "Instrument",
                sceneIndex: 2,
                durationBeats: 4,
                launch: {
                  state: "verified",
                  mutationState: "observed-playing",
                },
              },
            },
          ],
          1,
        ),
      }),
    );
    expect(container.textContent).toContain(
      "Source epoch matched the native transport anchor",
    );
    expect(container.textContent).toContain(
      "does not prove exclusive clip audio",
    );
    expect(container.textContent).not.toContain("Lifecycle completed");
    await click("Cancel owned capture (not transport)");
    expect(container.textContent).toContain(
      "does not stop Live transport or retract an accepted Session launch",
    );
  });

  it("shows the production timing gate and never invents inventory without a session/runtime", async () => {
    await render();
    expect(container.textContent).toContain("unavailable");
    expect(container.textContent).toContain(
      "Production timing certification is not available",
    );
    await render(undefined, null);
    expect(container.textContent).toContain("Select an App session");
  });
  it("shows stages, duration, completion limitations and never stops transport", async () => {
    const h = source();
    await render(h.api);
    expect(h.api.listening.list).toHaveBeenCalledWith({
      sessionId: "session",
      agentId,
      limit: 100,
    });
    expect(container.textContent).toContain("queued");
    expect(container.textContent).toContain("1.25 seconds");
    for (const stage of [
      "validating",
      "reserving-context",
      "arming",
      "starting-playback",
      "capturing",
      "persisting",
      "completed",
    ] as const) {
      await act(async () =>
        h.emit({
          type: "listening.changed",
          page: page([{ ...job, stage }], 1),
        }),
      );
      expect(
        container
          .querySelector("[data-listening-stage]")
          ?.getAttribute("data-listening-stage"),
      ).toBe(stage);
    }
    expect(container.textContent).toContain("not a DSP certificate");
    expect(container.textContent).toContain(
      "Cancel capture does not stop transport",
    );
    expect(
      [...container.querySelectorAll("button")].find(
        (button) =>
          button.textContent === "Cancel owned capture (not transport)",
      )?.disabled,
    ).toBe(true);
  });
  it("presents actionable query/capture failures and supports retry without success-shaped recovery", async () => {
    const h = source();
    vi.mocked(h.api.listening.list).mockRejectedValueOnce(
      new Error("Context reservation denied"),
    );
    await render(h.api);
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "reservation denied",
    );
    expect(container.textContent).not.toContain("No listening passes");
    await click("Refresh listening passes");
    await act(async () =>
      h.emit({
        type: "listening.changed",
        page: page(
          [{ ...job, stage: "failed", error: "Synthetic timing gate closed" }],
          2,
        ),
      }),
    );
    expect(container.textContent).toContain("Synthetic timing gate closed");
    expect(container.textContent).toContain(
      "retry only after resolving the failure",
    );
  });
  it("cancels only the selected owner's existing service path and waits for terminal status", async () => {
    const h = source();
    await render(h.api);
    await click("Cancel owned capture (not transport)");
    expect(h.cancel).toHaveBeenCalledWith(agentId, { sessionId: "session" });
    expect(container.textContent).toContain("Await terminal status");
    await act(async () =>
      h.emit({
        type: "listening.changed",
        page: page([{ ...job, stage: "cancelled" }], 1),
      }),
    );
    expect(container.textContent).toContain("cancelled");
    expect(container.textContent).toContain(
      "cancellation does not stop Live transport",
    );
    h.cancel.mockRejectedValueOnce(new Error("Selected App session changed"));
    await act(async () =>
      h.emit({
        type: "listening.changed",
        page: page([{ ...job, passId: "new", stage: "capturing" }], 2),
      }),
    );
    await click("Cancel owned capture (not transport)");
    expect(container.textContent).toContain("Selected App session changed");
  });
  it.each([
    "arrangement_session_override: A Session source overrides the selected track. Return to Arrangement in Live, then explicitly request a new listening pass.",
    "arrangement_source_unknown: Arrangement source selection could not be verified. Request a fresh inspection. No Session takeover is confirmed.",
  ])(
    "preserves the specific refusal without speculative repairs: %s",
    async (error) => {
      const h = source();
      vi.mocked(h.api.listening.list).mockResolvedValue(
        page([{ ...job, stage: "failed", error }], 1),
      );
      await render(h.api);
      expect(container.querySelector("[role=alert]")?.textContent).toContain(
        error,
      );
      expect(container.textContent).not.toContain(
        "Check listener discovery, timing certification and context storage",
      );
      expect(container.textContent).toContain(
        "0 stored observation references",
      );
      expect(container.textContent).not.toContain("Lifecycle completed");
      await click("Refresh listening passes");
      expect(h.api.listening.list).toHaveBeenCalledTimes(2);
      expect(h.cancel).not.toHaveBeenCalled();
      expect(
        [...container.querySelectorAll("button")].find(
          (button) =>
            button.textContent === "Cancel owned capture (not transport)",
        )?.disabled,
      ).toBe(true);
    },
  );
  it("discards late query/cancel results after selected-agent, session or profile changes", async () => {
    const h = source();
    let finishQuery!: (value: DesktopListeningPage) => void;
    vi.mocked(h.api.listening.list).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishQuery = resolve;
        }),
    );
    await render(h.api);
    await render(h.api, "session", otherAgentId);
    await act(async () => finishQuery(page()));
    expect(container.textContent).not.toContain(job.passId);
    await render(h.api);
    let finishCancel!: (value: { cancelled: boolean }) => void;
    h.cancel.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    await click("Cancel owned capture (not transport)");
    vi.mocked(h.api.listening.list).mockResolvedValueOnce({
      sessionId: "other",
      revision: 0,
      jobs: [],
    });
    await render(h.api, "other", otherAgentId);
    await act(async () => finishCancel({ cancelled: true }));
    expect(container.textContent).not.toContain("Cancellation requested");
    expect(container.textContent).not.toContain(job.passId);
    vi.mocked(h.api.listening.list).mockResolvedValueOnce(
      page([{ ...job, passId: "new-profile" }], 0),
    );
    await render(h.api, "session", agentId, 1);
    expect(container.textContent).toContain("new-profile");
    expect(h.listeners.size).toBe(1);
  });
  it("keeps newer events over late inventory, filters foreign agents, and clears shutdown state", async () => {
    const h = source();
    let finish!: (value: DesktopListeningPage) => void;
    vi.mocked(h.api.listening.list).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(h.api);
    await act(async () =>
      h.emit({
        type: "listening.changed",
        page: page(
          [
            { ...job, stage: "capturing" },
            { ...job, passId: "foreign-agent-pass", agentId: otherAgentId },
          ],
          2,
        ),
      }),
    );
    await act(async () => finish(page()));
    expect(container.textContent).toContain("capturing");
    expect(container.textContent).not.toContain("foreign-agent-pass");
    await act(async () =>
      h.emit({ type: "listening.reset", reason: "shutdown" }),
    );
    expect(container.textContent).not.toContain(job.passId);
    expect(container.textContent).toContain("runtime stopped");
    expect(h.listeners.size).toBe(1);
  });
  it("rejects mismatched and oversized inventories instead of displaying them", async () => {
    const h = source();
    vi.mocked(h.api.listening.list).mockResolvedValueOnce({
      ...page(),
      sessionId: "foreign",
    });
    await render(h.api);
    expect(container.textContent).toContain("another App session");
    vi.mocked(h.api.listening.list).mockResolvedValueOnce(
      page(Array.from({ length: 101 }, () => job)),
    );
    await click("Refresh listening passes");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("keeps newer lifecycle events when an obsolete inventory request later rejects", async () => {
    const h = source();
    let fail!: (error: Error) => void;
    vi.mocked(h.api.listening.list).mockImplementationOnce(
      async () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await render(h.api);
    await act(async () =>
      h.emit({
        type: "listening.changed",
        page: page([{ ...job, stage: "capturing" }], 2),
      }),
    );
    await act(async () => fail(new Error("Obsolete query failure")));
    expect(container.textContent).toContain("capturing");
    expect(container.textContent).not.toContain("Obsolete query failure");
  });
});
