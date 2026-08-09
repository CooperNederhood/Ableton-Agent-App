import { describe, expect, it } from "vitest";

import { normalizeSharedEvent } from "./shared-event-adapter.js";

describe("shared application event adapter", () => {
  it("maps shared operation events into stable desktop view models", () => {
    expect(
      normalizeSharedEvent(
        {
          type: "operation.failed",
          operationId: "op-1",
          code: "bridge_timeout",
          message: "Timed out",
        },
        () => "message-1",
      ),
    ).toMatchObject({
      type: "operation.changed",
      operation: { id: "op-1", status: "failed", retryable: true },
    });
  });
});
