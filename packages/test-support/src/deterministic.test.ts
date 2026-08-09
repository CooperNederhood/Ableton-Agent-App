import { describe, expect, it } from "vitest";

import { FakeClock, FakeIdGenerator, LogCapture } from "./deterministic.js";

describe("deterministic test support", () => {
  it("advances a fake clock explicitly", () => {
    const clock = new FakeClock(new Date("2026-08-09T12:00:00.000Z"));
    clock.advance(1_500);
    expect(clock.now().toISOString()).toBe("2026-08-09T12:00:01.500Z");
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });

  it("returns a fixed ID sequence and fails when exhausted", () => {
    const ids = new FakeIdGenerator(["first", "second"]);
    expect(ids.create()).toBe("first");
    expect(ids.create()).toBe("second");
    expect(() => ids.create()).toThrow(/exhausted/);
  });

  it("captures structured logs without sharing mutable context", () => {
    const logs = new LogCapture();
    const context = { requestId: "request-1" };
    logs.warn("retrying", context);
    context.requestId = "changed";

    expect(logs.byLevel("warn")).toEqual([
      {
        level: "warn",
        message: "retrying",
        context: { requestId: "request-1" },
      },
    ]);
  });
});
