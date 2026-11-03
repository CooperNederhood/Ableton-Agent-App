import { describe, expect, it } from "vitest";
import { captureCleanupConfirmed } from "../../tests/electron/acceptance-evidence.js";

const owner = {
  traceId: "trace",
  correlationId: "correlation",
  passId: "pass",
  listenerId: "listener",
  sessionId: "session",
  agentId: "agent",
  native: {
    generation: "generation",
    nativeEpoch: 1,
    connectionId: "connection",
    connectionEpoch: "connection-epoch",
  },
};
const base = {
  trace: { traceId: "trace", spanId: "span" },
  correlationId: "correlation",
  outcome: "success" as const,
  durationMs: 1,
};
const native = {
  ...base,
  name: "listening.metric-capture.completed",
  attributes: {
    passId: "pass",
    action: "cleanup",
    listeners: [{ listenerId: "listener", ...owner.native }],
  },
};
const source = {
  ...base,
  name: "listening.runtime.session-source-cleanup.completed",
  sessionId: "session",
  activeAgentId: "agent",
  attributes: { passId: "pass" },
};

describe("independent capture cleanup evidence", () => {
  it.each([
    "generation",
    "nativeEpoch",
    "connectionId",
    "connectionEpoch",
  ] as const)("rejects a cleanup receipt from a different native %s", (key) => {
    const observed = {
      ...native,
      attributes: {
        ...native.attributes,
        listeners: [
          {
            listenerId: "listener",
            ...owner.native,
            [key]: key === "nativeEpoch" ? 2 : "other",
          },
        ],
      },
    };
    expect(captureCleanupConfirmed([observed, source], owner)).toBe(false);
  });
  it("recognizes the successful sealed-capture release/finalization path, not release alone", () => {
    const release = {
      ...native,
      attributes: { ...native.attributes, action: "release" },
    };
    const finalization = {
      ...native,
      attributes: { ...native.attributes, action: "finalization" },
    };
    expect(
      captureCleanupConfirmed([release, finalization, source], owner),
    ).toBe(true);
    expect(captureCleanupConfirmed([release, source], owner)).toBe(false);
    expect(captureCleanupConfirmed([finalization, source], owner)).toBe(false);
    expect(captureCleanupConfirmed([release, finalization], owner)).toBe(false);
  });
  it("requires both native and source release for the exact owner", () => {
    expect(captureCleanupConfirmed([native, source], owner)).toBe(true);
    expect(captureCleanupConfirmed([source], owner)).toBe(false);
    expect(captureCleanupConfirmed([native], owner)).toBe(false);
    expect(captureCleanupConfirmed([], owner)).toBe(false);
  });
  it.each([
    "traceId",
    "correlationId",
    "passId",
    "listenerId",
    "sessionId",
    "agentId",
  ] as const)("rejects foreign %s", (key) => {
    expect(
      captureCleanupConfirmed([native, source], { ...owner, [key]: "foreign" }),
    ).toBe(false);
  });
  it("does not turn a later cleanup acknowledgement into a clean pass", () => {
    expect(() =>
      captureCleanupConfirmed(
        [
          {
            ...native,
            name: "listening.metric-capture.failed",
            outcome: "failure",
          },
          native,
          source,
        ],
        owner,
      ),
    ).toThrow("failed or cancelled");
  });
  it("requires bounded timing, not just completed prose or event names", () => {
    expect(
      captureCleanupConfirmed([{ ...native, durationMs: -1 }, source], owner),
    ).toBe(false);
  });
});
