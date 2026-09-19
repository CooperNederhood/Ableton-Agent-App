import { describe, expect, it } from "vitest";

import { parseDesktopLaunchOptions } from "./launch-options.js";

describe("desktop launch options", () => {
  it("parses an isolated automation launch", () => {
    expect(
      parseDesktopLaunchOptions([
        "electron",
        ".",
        "--automation",
        "--automation-profile",
        "/tmp/ableton-agent-profile",
        "--automation-descriptor",
        "/tmp/ableton-agent-control/automation-endpoint.json",
        "--automation-agent",
        "default",
        "--automation-yolo",
      ]),
    ).toEqual({
      automation: {
        profilePath: "/tmp/ableton-agent-profile",
        descriptorPath: "/tmp/ableton-agent-control/automation-endpoint.json",
        agentDefinition: "default",
        yolo: true,
      },
    });
  });

  it("rejects automation settings on a normal launch", () => {
    expect(() =>
      parseDesktopLaunchOptions(["electron", ".", "--automation-yolo"]),
    ).toThrow("require --automation");
  });

  it("requires an absolute isolated profile", () => {
    expect(() =>
      parseDesktopLaunchOptions([
        "electron",
        ".",
        "--automation",
        "--automation-profile",
        "relative",
      ]),
    ).toThrow("absolute path");
  });
});
