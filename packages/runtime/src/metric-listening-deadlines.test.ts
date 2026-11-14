import { describe, expect, it } from "vitest";
import { metricListeningDeadlines } from "./metric-listening-deadlines.js";

describe("continuous metric capture deadlines", () => {
  it.each([180, 600])(
    "admits a healthy %ss pass without a fixed five-minute cap",
    (seconds) => {
      const policy = metricListeningDeadlines(seconds * 1000);
      expect(policy.totalMs).toBeGreaterThan(seconds * 1000);
      expect(policy.inactivityMs).toBeLessThan(seconds * 1000);
      expect(policy.drainMs).toBeGreaterThan(0);
      expect(policy.cleanupMs).toBeGreaterThan(0);
    },
  );
  it.each([0, -1, 600001, Infinity, NaN])(
    "rejects unsupported duration %s",
    (duration) => {
      expect(() => metricListeningDeadlines(duration)).toThrow(
        "invalid-capture-duration",
      );
    },
  );
  it("uses explicit finite stage allowances and a duration-derived total", () => {
    expect(
      metricListeningDeadlines(180000, {
        setupMs: 2000,
        inactivityMs: 3000,
        drainMs: 4000,
        cleanupMs: 5000,
      }),
    ).toEqual({
      setupMs: 2000,
      inactivityMs: 3000,
      drainMs: 4000,
      cleanupMs: 5000,
      totalMs: 191000,
    });
  });
  it.each([0, -1, Infinity, NaN, 120001])(
    "rejects unbounded stage allowance %s",
    (inactivityMs) => {
      expect(() => metricListeningDeadlines(1000, { inactivityMs })).toThrow(
        "invalid-capture-deadline",
      );
    },
  );
});
