// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopProfileManagerSnapshot,
  DesktopScopedArtifact,
} from "../contracts";
import { MemoryView } from "./MemoryView";

const revision = "a".repeat(64);

function memory(
  name: string,
  update: Partial<DesktopScopedArtifact>,
): DesktopScopedArtifact {
  return {
    kind: "memory",
    name,
    description: `${name} summary`,
    scope: "profile",
    origin: "profile",
    state: "local",
    sourceFile: `${name}.md`,
    profile: "default",
    overriddenOrigins: [],
    diagnostics: [],
    ...update,
  };
}

function snapshot(): DesktopProfileManagerSnapshot {
  return {
    revision,
    activeProfile: "default",
    selectedProfile: "default",
    activeSessionId: "session-1",
    profiles: [
      {
        name: "default",
        active: true,
        reserved: false,
        sessionCount: 1,
        sessions: [
          {
            id: "session-1",
            title: "Untitled",
            liveSetId: "set-1",
            liveSetName: "Untitled",
            createdAt: "2026-09-17T00:00:00.000Z",
            active: true,
            canonical: true,
          },
        ],
        liveProjects: [],
        unassignedLiveSets: [],
      },
    ],
    artifacts: [
      memory("mix-preferences", {}),
      memory("scratch", {
        scope: "session",
        origin: "session",
        liveSetId: "set-1",
        sessionId: "session-1",
      }),
      memory("other-session", {
        scope: "session",
        origin: "session",
        liveSetId: "set-2",
        sessionId: "session-2",
      }),
    ],
  };
}

describe("MemoryView", () => {
  let container: HTMLDivElement;
  let root: Root;
  const readMemory = vi.fn();
  const deleteArtifact = vi.fn();

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    readMemory.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve({
        name,
        description: "",
        content: `# ${name}\n\nLikes dry kicks.`,
        fingerprint: "b".repeat(64),
      }),
    );
    deleteArtifact.mockResolvedValue({ ...snapshot(), artifacts: [] });
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        profiles: {
          get: vi.fn().mockResolvedValue(snapshot()),
          readMemory,
          deleteArtifact,
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(onAskAgent = vi.fn()): Promise<void> {
    await act(async () => {
      root.render(
        <MemoryView
          libraryScope="all"
          onLibraryScope={vi.fn()}
          onAskAgent={onAskAgent}
        />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("shows only memory for the active context and reads the selected topic", async () => {
    await render();

    const tiles = [
      ...container.querySelectorAll(".memory-tile:not(.new) .memory-tile-top"),
    ].map((tile) => tile.textContent);
    expect(tiles).toEqual(["mix-preferences", "scratch"]);
    expect(readMemory).toHaveBeenCalledWith({
      name: "mix-preferences",
      location: { scope: "profile", profile: "default" },
    });
    expect(container.querySelector(".memory-reader")?.textContent).toContain(
      "Likes dry kicks.",
    );
  });

  it("deletes the selected topic only after confirmation", async () => {
    await render();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete mix-preferences memory"]',
        )
        ?.click();
    });
    expect(deleteArtifact).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete mix-preferences",
    );
    await act(async () => confirm?.click());

    expect(deleteArtifact).toHaveBeenCalledWith({
      kind: "memory",
      name: "mix-preferences",
      location: { scope: "profile", profile: "default" },
      expectedRevision: revision,
    });
  });

  it("sends edits to chat through update-memory", async () => {
    const onAskAgent = vi.fn();
    await render(onAskAgent);

    const edit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit in chat",
    );
    await act(async () => edit?.click());

    expect(onAskAgent).toHaveBeenCalledWith(
      "/update-memory Update the mix-preferences memory: ",
    );
  });
});
