// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi, DesktopProfileManagerSnapshot } from "../contracts";
import { ProfileManagerView } from "./ProfileManagerView";

const revision = "a".repeat(64);

function snapshot(
  update: Partial<DesktopProfileManagerSnapshot> = {},
): DesktopProfileManagerSnapshot {
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
        sessionCount: 2,
        sessions: [
          {
            id: "session-1",
            title: "Untitled",
            active: true,
          },
          {
            id: "session-2",
            title: "Second set",
            active: false,
          },
        ],
      },
      {
        name: "ambient",
        active: false,
        reserved: false,
        sessionCount: 1,
        sessions: [
          {
            id: "ambient-session",
            title: "Ambient set",
            active: false,
          },
        ],
      },
    ],
    artifacts: [
      {
        kind: "agent",
        name: "default",
        description: "Default agent",
        scope: "system",
        origin: "bundled",
        state: "inherited",
        sourceFile: "default.yaml",
        fingerprint: "f".repeat(64),
        overriddenOrigins: [],
        diagnostics: [],
      },
      {
        kind: "skill",
        name: "arrangement",
        description: "Arrangement skill",
        scope: "system",
        origin: "bundled",
        state: "inherited",
        sourceFile: "arrangement/SKILL.md",
        fingerprint: "e".repeat(64),
        overriddenOrigins: [],
        diagnostics: [],
      },
      {
        kind: "agent",
        name: "mix",
        description: "Mix agent",
        scope: "system",
        origin: "system",
        state: "local",
        sourceFile: "mix.yaml",
        fingerprint: "b".repeat(64),
        overriddenOrigins: ["bundled"],
        diagnostics: [],
      },
      {
        kind: "skill",
        name: "house-groove",
        description: "House grooves",
        scope: "profile",
        origin: "profile",
        state: "local",
        profile: "default",
        sourceFile: "house-groove/SKILL.md",
        fingerprint: "c".repeat(64),
        overriddenOrigins: [],
        diagnostics: [],
      },
      {
        kind: "agent",
        name: "compose",
        description: "Compose agent",
        scope: "session",
        origin: "session",
        state: "local",
        profile: "default",
        sessionId: "session-1",
        sourceFile: "compose.yaml",
        fingerprint: "d".repeat(64),
        overriddenOrigins: ["bundled"],
        diagnostics: [],
      },
    ],
    ...update,
  };
}

function api(
  profileOverrides: Partial<DesktopApi["profiles"]> = {},
  closeSession = vi.fn().mockResolvedValue(undefined),
): DesktopApi {
  return {
    agent: { closeSession },
    profiles: {
      get: vi.fn().mockResolvedValue(snapshot()),
      create: vi.fn().mockResolvedValue(snapshot()),
      rename: vi.fn().mockResolvedValue(snapshot()),
      delete: vi.fn().mockResolvedValue(snapshot()),
      switch: vi.fn().mockResolvedValue(undefined),
      copyArtifact: vi.fn().mockResolvedValue({
        status: "completed",
        snapshot: snapshot(),
      }),
      moveArtifact: vi.fn().mockResolvedValue({
        status: "completed",
        snapshot: snapshot(),
      }),
      renameArtifact: vi.fn().mockResolvedValue(snapshot()),
      deleteArtifact: vi.fn().mockResolvedValue(snapshot()),
      setArtifactDisabled: vi.fn().mockResolvedValue(snapshot()),
      ...profileOverrides,
    },
  } as unknown as DesktopApi;
}

describe("ProfileManagerView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the nested scope hierarchy and closes the active session", async () => {
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const getProfiles = vi.fn().mockResolvedValue(snapshot());
    const desktop = api({ get: getProfiles }, closeSession);
    window.desktop = desktop;

    await act(async () => {
      root.render(<ProfileManagerView activeSessionId="session-1" />);
    });

    expect(container.textContent).toContain("System");
    expect(container.textContent).toContain("default");
    expect(container.textContent).not.toContain("house-groove");

    const expandSystem = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand System artifacts"]',
    );
    await act(async () => expandSystem?.click());
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Skills");
    expect(container.textContent).toContain("arrangement");

    const expandProfile = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand default profile"]',
    );
    await act(async () => expandProfile?.click());
    expect(container.textContent).toContain("house-groove");
    expect(container.textContent).toContain("Untitled");

    const expandSession = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand Untitled session"]',
    );
    await act(async () => expandSession?.click());
    expect(container.textContent).toContain("compose");
    const close = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Close active session",
    );
    expect(close).toBeDefined();

    await act(async () => close?.click());

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenLastCalledWith("default");
  });

  it("requires an explicit conflict decision", async () => {
    const copyArtifact = vi
      .fn()
      .mockResolvedValueOnce({
        status: "conflict",
        conflict: {
          kind: "agent",
          name: "mix",
          sourceFingerprint: "b".repeat(64),
          destinationFingerprint: "e".repeat(64),
          sourceDescription: "System Mix",
          destinationDescription: "Profile Mix",
          suggestedName: "mix-copy",
        },
      })
      .mockResolvedValueOnce({
        status: "completed",
        snapshot: snapshot(),
      });
    window.desktop = api({ copyArtifact });

    await act(async () => {
      root.render(<ProfileManagerView activeSessionId="session-1" />);
    });
    const expandSystem = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand System artifacts"]',
    );
    await act(async () => expandSystem?.click());
    const mix = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("mix"),
    );
    await act(async () => mix?.click());
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy",
    );
    await act(async () => copy?.click());

    expect(container.textContent).toContain("Artifact already exists");
    const replace = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Replace",
    );
    await act(async () => replace?.click());

    expect(copyArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ conflictResolution: "replace" }),
    );
  });

  it("does not repeat inherited artifacts in fresh lower scopes", async () => {
    window.desktop = api({
      get: vi.fn().mockResolvedValue(
        snapshot({
          artifacts: snapshot().artifacts.filter(
            ({ scope }) => scope === "system",
          ),
        }),
      ),
    });

    await act(async () => {
      root.render(<ProfileManagerView activeSessionId="session-1" />);
    });
    const expandProfile = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand default profile"]',
    );
    await act(async () => expandProfile?.click());
    const expandSession = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand Untitled session"]',
    );
    await act(async () => expandSession?.click());

    expect(
      container.textContent?.match(/None defined at this level\./gu),
    ).toHaveLength(4);
    expect(container.textContent).not.toContain("Bundled baseline");
  });
});
