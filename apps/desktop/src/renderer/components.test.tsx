import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ApprovalPanel,
  Arrangement,
  Composer,
  DiagnosticsView,
  Inspector,
  loadInitialDesktopState,
  OperationCard,
  OutputConnectionCard,
  OutputsView,
  ProjectOutline,
  refreshProjectSnapshot,
  SettingsView,
  setOutputQuickEnabled,
  Timeline,
} from "./App";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { desktopReducer, initialState, type DesktopState } from "./state";

describe("desktop components", () => {
  it("renders safe GitHub-flavored assistant Markdown", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        content={[
          "## Live Set Summary",
          "",
          "**Transport:** `128 BPM`",
          "",
          "- Drums",
          "- Bass",
          "",
          "| Track | Type |",
          "|---|---|",
          "| DRUMS | Audio |",
          "",
          "[Docs](https://example.com/guide)",
          "[Unsafe](javascript:alert(1))",
          "<script>alert('no')</script>",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h2>Live Set Summary</h2>");
    expect(html).toContain("<strong>Transport:</strong>");
    expect(html).toContain("<code>128 BPM</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
  });

  it("keeps user messages as literal plain text", () => {
    const html = renderToStaticMarkup(
      <Timeline
        state={{
          ...initialState,
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "**do not format this**",
              streaming: false,
              timestamp: 1,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("**do not format this**");
    expect(html).not.toContain("<strong>do not format this</strong>");
  });

  it("renders partial streaming assistant Markdown incrementally", () => {
    const html = renderToStaticMarkup(
      <Timeline
        state={{
          ...initialState,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: "## Current Set\n\n**Tempo:** 128",
              streaming: true,
              timestamp: 1,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Streaming…");
    expect(html).toContain("<h2>Current Set</h2>");
    expect(html).toContain("<strong>Tempo:</strong>");
  });

  it("renders context chips as explicit removal controls", () => {
    const html = renderToStaticMarkup(
      <Composer
        state={{
          ...initialState,
          context: [{ id: "section:chorus", kind: "section", label: "Chorus" }],
        }}
        value=""
        busy={false}
        composerRef={{ current: null }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Remove section Chorus from context"');
  });

  it("renders diagnostics log metadata and safe actions", () => {
    const html = renderToStaticMarkup(
      <DiagnosticsView
        state={{
          ...initialState,
          diagnosticsReport: {
            checks: [
              { label: "Bridge", status: "warn", detail: "Not connected" },
            ],
            logging: {
              level: "debug",
              fileName: "desktop-development.log",
              filePath: "/logs/desktop-development.log",
            },
          },
        }}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain("Active logging level: debug");
    expect(html).toContain("desktop-development.log");
    expect(html).toContain("Reveal log");
    expect(html).toContain("Export support bundle");
    expect(html).toContain("Copy summary");
  });

  it("renders operation recovery details without color-only status", () => {
    const html = renderToStaticMarkup(
      <OperationCard
        operation={{
          id: "1",
          label: "Place clips",
          status: "partial",
          detail: "2 of 3",
          warnings: ["Track locked"],
          changed: ["Intro"],
          unchanged: ["Verse"],
          retryable: true,
          undoable: true,
          timestamp: 1,
        }}
      />,
    );
    expect(html).toContain("partial");
    expect(html).toContain("Retry safely");
    expect(html).toContain("Not changed:");
  });

  it("renders approval preview and semantic actions", () => {
    const state = {
      ...initialState,
      approval: {
        id: "a",
        title: "Place arrangement",
        risk: "medium" as const,
        summary: "Place clips",
        changes: ["Add eight clips"],
        destructive: false,
      },
    };
    const html = renderToStaticMarkup(
      <ApprovalPanel state={state} dispatch={vi.fn()} />,
    );
    expect(html).toContain("Approve");
    expect(html).toContain("Add eight clips");
  });

  it("warns when settings draft approves all changes without prompts", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        state={{
          ...initialState,
          preferences: {
            ...initialState.preferences,
            approvalPolicy: "approve-all",
          } as unknown as DesktopState["preferences"],
        }}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain(
      '<option value="approve-all" selected="">Approve all (no prompts)</option>',
    );
    expect(html).toContain('class="approval-policy-warning" role="alert"');
    expect(html).toContain(
      "Warning: all changes will be approved automatically.",
    );
    expect(html).toContain(
      "You will not be prompted before Ableton changes are applied.",
    );
  });

  it("renders plan and empty inspector states", () => {
    expect(
      renderToStaticMarkup(
        <Arrangement state={initialState} dispatch={vi.fn()} />,
      ),
    ).toContain("Production plan");
    expect(
      renderToStaticMarkup(
        <Inspector state={initialState} dispatch={vi.fn()} />,
      ),
    ).toContain("Nothing selected");
  });

  it("renders output state and accessible routing controls", () => {
    const state = {
      ...initialState,
      outputs: {
        status: {
          state: "listening" as const,
          host: "127.0.0.1",
          port: 45832,
        },
        activeSessionId: "session-1",
        connections: [
          {
            connectionId: "connection-1",
            producerId: "producer-1",
            instanceId: "instance-1",
            displayName: "MIDI Capture",
            signalKind: "midi" as const,
            state: "connected" as const,
            receiving: true,
            lastHeartbeatAt: 1,
            track: { name: "Keys" },
          },
        ],
        assignments: [
          {
            assignmentId: "assignment-1",
            producerId: "producer-1",
            enabled: true,
            deliveryMode: "next-prompt" as const,
            usageInstruction: "Use as observation.",
            processingPolicyIds: ["latest-window"],
          },
        ],
        latest: [
          {
            assignmentId: "assignment-1",
            producerId: "producer-1",
            sequence: 2,
            capturedAt: 3,
            summary: "No notes in this window.",
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <OutputsView state={state} dispatch={vi.fn()} />,
    );
    expect(html).toContain("Connection state: connected");
    expect(html).toContain("Delivery mode");
    expect(html).toContain("Save instruction");
    expect(html).toContain("No notes in this window.");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Collapse");
  });

  it("disables unassigned quick toggles without an active conversation", () => {
    const html = renderToStaticMarkup(
      <OutputConnectionCard
        connection={{
          connectionId: "connection-1",
          producerId: "producer-1",
          instanceId: "instance-1",
          displayName: "MIDI Capture",
          signalKind: "midi",
          state: "connected",
          receiving: false,
          lastHeartbeatAt: 1,
        }}
        assignment={undefined}
        latest={undefined}
        unavailable={false}
        hasActiveSession={false}
        expanded={true}
        onToggleDisclosure={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain("disabled");
    expect(html).toContain("Assign to active conversation");
  });

  it("automatically assigns when an unassigned quick toggle turns on", async () => {
    const outputs = {
      assign: vi.fn().mockResolvedValue({}),
      setEnabled: vi.fn().mockResolvedValue({}),
    };

    await setOutputQuickEnabled(outputs, "producer-1", undefined, true);
    expect(outputs.assign).toHaveBeenCalledWith("producer-1");
    expect(outputs.setEnabled).not.toHaveBeenCalled();

    const assignment = {
      assignmentId: "assignment-1",
      producerId: "producer-1",
      enabled: true,
      deliveryMode: "next-prompt" as const,
      usageInstruction: "Observe this.",
      processingPolicyIds: [],
    };
    await setOutputQuickEnabled(outputs, "producer-1", assignment, false);
    expect(outputs.setEnabled).toHaveBeenCalledWith("producer-1", false);
  });

  it.each([
    ["refreshing", "Refreshing…", "disabled", "Refreshing project snapshot."],
    ["succeeded", "Updated", undefined, "Project snapshot updated."],
    ["failed", "Retry", undefined, "Refresh failed locally"],
  ] as const)(
    "renders an accessible %s project refresh control",
    (status, label, disabledAttribute, message) => {
      const projectRefresh =
        status === "failed"
          ? { status, message }
          : {
              status,
            };
      const html = renderToStaticMarkup(
        <ProjectOutline
          state={{
            ...initialState,
            connection: {
              state: "connected",
              liveVersion: "12.1",
              remoteScriptVersion: "1",
              projectId: "project",
            },
            projectRefresh,
          }}
          dispatch={vi.fn()}
        />,
      );

      expect(html).toContain(`aria-label="${label} project snapshot"`);
      expect(html).toContain(`>${label}</button>`);
      expect(html).toContain(message);
      if (disabledAttribute) expect(html).toContain(disabledAttribute);
      else expect(html).not.toContain("<button disabled");
    },
  );

  it("keeps refresh available without a snapshot when connected", () => {
    const html = renderToStaticMarkup(
      <ProjectOutline
        state={{
          ...initialState,
          connection: {
            state: "connected",
            liveVersion: "12.1",
            remoteScriptVersion: "1",
            projectId: "project",
          },
        }}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Refresh project snapshot"');
    expect(html).toContain("No snapshot");
    expect(html).not.toContain("<button disabled");
  });

  it("renders project selection context disabled by default", () => {
    const off = renderToStaticMarkup(
      <ProjectOutline state={initialState} dispatch={vi.fn()} />,
    );
    expect(off).toContain('role="switch"');
    expect(off).not.toContain('role="switch" checked=""');
    expect(off).toContain(
      "Selections only control the Project and Inspector views.",
    );

    const on = renderToStaticMarkup(
      <ProjectOutline
        state={{ ...initialState, projectSelectionContextEnabled: true }}
        dispatch={vi.fn()}
      />,
    );
    expect(on).toContain('role="switch" checked=""');
    expect(on).toContain(
      "Selected tracks, clips, and devices are included in prompts.",
    );
  });

  it("loads initial renderer state without StrictMode snapshot requests", async () => {
    const requestSnapshot = vi.fn();
    const desktop = {
      lifecycle: { get: vi.fn().mockResolvedValue("ready") },
      ableton: {
        getStatus: vi.fn().mockResolvedValue({ state: "disconnected" }),
        requestSnapshot,
      },
      preferences: {
        get: vi.fn().mockResolvedValue(initialState.preferences),
      },
      agent: { getSessions: vi.fn().mockResolvedValue([]) },
      outputs: { list: vi.fn().mockResolvedValue(initialState.outputs) },
    } as unknown as Parameters<typeof loadInitialDesktopState>[0];

    const [events] = await Promise.all([
      loadInitialDesktopState(desktop),
      loadInitialDesktopState(desktop),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "lifecycle.changed",
      "ableton.connection_changed",
      "preferences.changed",
      "sessions.changed",
      "outputs.changed",
    ]);
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it("does not call refresh while disconnected and reports a failure", async () => {
    const requestSnapshot = vi.fn();
    const dispatch = vi.fn<Parameters<typeof refreshProjectSnapshot>[1]>();

    await refreshProjectSnapshot(
      { state: "disconnected" },
      dispatch,
      requestSnapshot,
    );

    expect(requestSnapshot).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "project-refresh-failed",
      message: "Connect to Ableton before refreshing the project.",
    });
    expect(
      dispatch.mock.calls.some(
        ([action]) =>
          action.type === "event" && action.event.type === "diagnostic",
      ),
    ).toBe(true);
  });

  it("reports refresh success after applying the returned snapshot", async () => {
    const snapshot = {
      id: "project",
      name: "Project",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [],
    };
    let state: DesktopState = {
      ...initialState,
      connection: {
        state: "connected",
        liveVersion: "12.1",
        remoteScriptVersion: "1",
        projectId: "project",
      },
    };
    const dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]> = (
      action,
    ) => {
      state = desktopReducer(state, action);
    };

    await refreshProjectSnapshot(
      state.connection,
      dispatch,
      vi.fn().mockResolvedValue(snapshot),
    );

    expect(state.snapshot).toEqual(snapshot);
    expect(state.projectRefresh).toEqual({ status: "succeeded" });
  });
});
