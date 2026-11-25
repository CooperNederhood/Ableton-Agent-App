import { describe, expect, it } from "vitest";
import type { DesktopLiveSetSnapshot } from "../contracts";
import { searchParameters } from "./live-event-drafts";

const parameter = (name: string, displayValue = "0.5") => ({
  id: `p-${name}`,
  name,
  value: 0.5,
  displayValue,
});

const snapshot = {
  liveSetId: "project",
  liveSetName: "Project",
  tempo: 120,
  timeSignature: "4/4",
  tracks: [
    {
      id: "t-bass",
      name: "Bass",
      kind: "midi",
      color: "#335577",
      volume: 0.8,
      pan: 0,
      muted: false,
      clips: [],
      devices: [
        {
          id: "d-rack",
          name: "Bass Rack",
          type: "InstrumentGroupDevice Rack",
          enabled: true,
          parameters: [
            parameter("Device On", "On"),
            parameter("Cutoff"),
            parameter("Macro 2"),
          ],
        },
        {
          id: "d-op",
          name: "Operator",
          type: "Instrument",
          enabled: true,
          parameters: [parameter("Filter Freq"), parameter("Osc-A On", "Off")],
        },
      ],
    },
  ],
} as unknown as DesktopLiveSetSnapshot;

const names = (result: ReturnType<typeof searchParameters>) =>
  result.matches.map(({ parameter }) => parameter.name);

describe("searchParameters", () => {
  it("matches every word across track, device, and knob names", () => {
    expect(names(searchParameters(snapshot, "bass operator freq"))).toEqual([
      "Filter Freq",
    ]);
    expect(names(searchParameters(snapshot, "bass rack cutoff"))).toEqual([
      "Cutoff",
    ]);
  });

  it("hides unnamed macros and on/off switches until asked", () => {
    const result = searchParameters(snapshot, "");
    expect(names(result)).toEqual(["Cutoff", "Filter Freq"]);
    expect(result.hidden).toBe(3);
    expect(
      names(searchParameters(snapshot, "", { showHidden: true })),
    ).toHaveLength(5);
  });

  it("limits to rack macros", () => {
    const result = searchParameters(snapshot, "", {
      macrosOnly: true,
      showHidden: true,
    });
    expect(names(result)).toEqual(["Cutoff", "Macro 2"]);
    expect(result.matches.every(({ macro }) => macro)).toBe(true);
  });
});
