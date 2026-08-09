import { defaultFakeState } from "@ableton-agent/test-support";
import { describe, expect, it } from "vitest";

import { composeAgentPrompt } from "./prompt.js";
import {
  colorFromLiveValue,
  projectLabel,
  toDesktopCapabilities,
  toDesktopSnapshot,
} from "./snapshot-adapter.js";

describe("project snapshot adapter", () => {
  it("maps session tracks, clips, and devices without inventing data", () => {
    const state = defaultFakeState();
    const track = state.snapshot.tracks[0];
    if (!track) throw new Error("fixture must contain a track");

    const snapshot = toDesktopSnapshot(state.snapshot, state.status, [
      {
        trackReference: track.reference,
        devices: (state.devicesByTrackReference[track.reference] ?? []).map(
          (device) => ({
            device: device.summary,
            parameters: device.parameters,
          }),
        ),
      },
    ]);

    expect(snapshot).toMatchObject({
      id: "project-fake",
      name: "Live set project-fake",
      tempo: 122,
      timeSignature: "4/4",
    });
    expect(snapshot.tracks[0]).toMatchObject({
      id: track.reference,
      name: "Bass",
      kind: "midi",
      color: "#79c2ff",
      muted: false,
    });
    expect(snapshot.tracks[0]?.clips[0]).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Sub Motif",
      sceneIndex: 2,
      lengthBeats: 16,
      status: "playing",
    });
    expect(snapshot.tracks[0]?.devices[0]).toMatchObject({
      name: "Wavetable",
      type: "Wavetable",
      enabled: true,
      parameters: [
        expect.objectContaining({
          name: "Filter cutoff",
          value: 0.56,
          displayValue: "2400",
        }),
      ],
    });
  });

  it("omits devices for tracks whose devices were not read", () => {
    const state = defaultFakeState();

    const snapshot = toDesktopSnapshot(state.snapshot, state.status);

    expect(snapshot.tracks[0]?.devices).toEqual([]);
  });

  it("labels the project only by the identity Live reported", () => {
    expect(projectLabel({ state: "disconnected" })).toBe(
      "No connected Live set",
    );
    expect(colorFromLiveValue(null)).toBe("#8a8f98");
    expect(colorFromLiveValue(0x00_00_ff)).toBe("#0000ff");
  });

  it("lists only capabilities the Remote Script enables", () => {
    expect(
      toDesktopCapabilities({ b: true, a: true, disabled: false }),
    ).toEqual(["a", "b"]);
  });
});

describe("agent prompt composition", () => {
  it("states the mode and passes selections as verifiable references", () => {
    const prompt = composeAgentPrompt(
      "Add a riser",
      [
        { id: "track:1", kind: "track", label: "Bass" },
        { id: "clip:2", kind: "clip", label: "Sub Motif" },
      ],
      "arrange",
    );

    expect(prompt).toContain("Mode: arrange.");
    expect(prompt).toContain(
      "Selected context (verify with Ableton tools before acting):",
    );
    expect(prompt).toContain("- track: Bass (track:1)");
    expect(prompt).toContain("- clip: Sub Motif (clip:2)");
    expect(prompt.endsWith("Add a riser")).toBe(true);
  });

  it("omits the context section when nothing is selected", () => {
    expect(composeAgentPrompt("Hello", [], "explore")).toBe(
      "Mode: explore. Explore the Live set and explain what is actually there.\n\nHello",
    );
  });
});
