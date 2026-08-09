import { describe, expect, it } from "vitest";

import { currentCorrelationId, withCorrelation } from "./index.js";

describe("correlation context", () => {
  it("preserves an operation ID across asynchronous boundaries", async () => {
    expect(currentCorrelationId()).toBeUndefined();
    await withCorrelation("tool-1", async () => {
      await Promise.resolve();
      expect(currentCorrelationId()).toBe("tool-1");
    });
    expect(currentCorrelationId()).toBeUndefined();
  });
});
