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
          { id: "session-1", title: "Untitled", active: true },
          { id: "session-2", title: "Second set", active: false },
        ],
      },
      {
        name: "ambient",
        active: false,
        reserved: false,
        sessionCount: 0,
        sessions: [],
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
): DesktopApi {
  return {
    profiles: {
      get: vi.fn().mockResolvedValue(snapshot()),
      status: vi.fn().mockResolvedValue({
        revision,
        activeProfile: "default",
        activeSessionId: "session-1",
        profiles: [
          { name: "default", active: true, reserved: false },
          { name: "ambient", active: false, reserved: false },
        ],
      }),
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

function rightClick(element: Element): void {
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 30,
    }),
  );
}

function setInput(input: HTMLInputElement, value: string): void {
  Object.defineProperty(input, "value", {
    configurable: true,
    value,
  });
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function dragEvent(type: string, altKey = false): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    altKey: { value: altKey },
    dataTransfer: {
      value: {
        effectAllowed: "none",
        dropEffect: "none",
        setData: vi.fn(),
      },
    },
  });
  return event;
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

  it("renders a compact hierarchy without persistent action panels", async () => {
    window.desktop = api();
    await act(async () => {
      root.render(<ProfileManagerView activeSessionId="session-1" />);
    });

    expect(container.textContent).toContain("System");
    expect(container.textContent).toContain("default");
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Skills");
    expect(container.textContent).toContain("house-groove");
    expect(container.textContent).not.toContain("Selected artifact");
    expect(container.textContent).not.toContain("Close active session");

    const expandSession = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand Untitled session"]',
    );
    await act(async () => expandSession?.click());
    expect(container.textContent).toContain("compose");
  });

  it("creates profiles from the header popover", async () => {
    const create = vi.fn().mockResolvedValue(snapshot());
    window.desktop = api({ create });
    await act(async () => {
      root.render(<ProfileManagerView />);
    });

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Create profile"]')
        ?.click(),
    );
    const input = container.querySelector<HTMLInputElement>(
      ".profile-popover input",
    )!;
    await act(async () => setInput(input, "ambient-two"));
    await act(async () =>
      input
        .closest("form")
        ?.dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        ),
    );

    expect(create).toHaveBeenCalledWith("ambient-two", revision);
  });

  it("uses Copy and scope Paste with explicit conflict resolution", async () => {
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
      root.render(<ProfileManagerView />);
    });

    const mix = container.querySelector<HTMLButtonElement>(
      'button[aria-label="mix, Local"]',
    )!;
    await act(async () => rightClick(mix));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Copy")
        ?.click(),
    );

    const profileRow = container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse default profile"]',
      )
      ?.closest("header");
    await act(async () => rightClick(profileRow!));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Paste")
        ?.click(),
    );
    expect(container.textContent).toContain("Artifact already exists");

    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Replace")
        ?.click(),
    );
    expect(copyArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        destination: { scope: "profile", profile: "default" },
        conflictResolution: "replace",
      }),
    );
  });

  it("moves by default and copies when Option is held during drag", async () => {
    const moveArtifact = vi.fn().mockResolvedValue({
      status: "completed",
      snapshot: snapshot(),
    });
    const copyArtifact = vi.fn().mockResolvedValue({
      status: "completed",
      snapshot: snapshot(),
    });
    window.desktop = api({ moveArtifact, copyArtifact });
    await act(async () => {
      root.render(<ProfileManagerView />);
    });

    const mix = container.querySelector<HTMLButtonElement>(
      'button[aria-label="mix, Local"]',
    )!;
    const profileToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse default profile"]',
    );
    if (profileToggle === null) throw new Error("Profile toggle not found");
    const profileRow = profileToggle.closest("header");
    if (profileRow === null) throw new Error("Profile row not found");
    await act(async () => mix.dispatchEvent(dragEvent("dragstart")));
    await act(async () => {
      profileRow.dispatchEvent(dragEvent("dragover"));
      profileRow.dispatchEvent(dragEvent("drop"));
    });
    expect(moveArtifact).toHaveBeenCalledTimes(1);

    await act(async () => mix.dispatchEvent(dragEvent("dragstart", true)));
    await act(async () => {
      profileRow.dispatchEvent(dragEvent("dragover", true));
      profileRow.dispatchEvent(dragEvent("drop", true));
    });
    expect(copyArtifact).toHaveBeenCalledTimes(1);
  });
});
