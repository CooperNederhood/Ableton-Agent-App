import { describe, expect, it } from "vitest";

import { parseYoloCommand, yoloCommandUsage } from "./yolo-command";

describe("parseYoloCommand", () => {
  it.each([
    ["/yolo", { enabled: true, all: false }],
    ["/yolo on", { enabled: true, all: false }],
    ["/yolo off", { enabled: false, all: false }],
    ["/yolo on all", { enabled: true, all: true }],
    ["/yolo off all", { enabled: false, all: true }],
  ])("parses %s", (input, expected) => {
    expect(parseYoloCommand(input)).toEqual(expected);
  });

  it.each([
    "/YOLO",
    "/Yolo on",
    "/yolo all",
    "/yolo yes",
    "/yolo on extra",
    "/yolo  on",
    "/yolo on ",
  ])("rejects malformed command %s with usage", (input) => {
    expect(() => parseYoloCommand(input)).toThrow(yoloCommandUsage);
  });

  it("leaves ordinary prompts and other slash commands untouched", () => {
    expect(parseYoloCommand("make drums")).toBeUndefined();
    expect(parseYoloCommand("/mix-review drums")).toBeUndefined();
    expect(parseYoloCommand("/yolophone")).toBeUndefined();
  });
});
