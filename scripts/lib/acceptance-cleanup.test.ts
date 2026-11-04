import { describe, expect, it } from "vitest";
import {
  AcceptanceCleanup,
  describeCleanupError,
} from "../../tests/electron/acceptance-cleanup.js";

const context = {
  runId: "run",
  traceId: "trace",
  correlationId: "correlation",
  causationId: "cause",
  signal: new AbortController().signal,
};

describe("attributed cleanup evidence", () => {
  it("retains nested causes with redaction and bounds rather than just AggregateError.message", () => {
    const error = new AggregateError(
      [
        new Error("token=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD"),
        new Error("close timed out"),
      ],
      "Desktop cleanup failed",
    );
    const message = describeCleanupError(error);
    expect(message).toContain("close timed out");
    expect(message).not.toContain("ghp_");
    expect(
      describeCleanupError(new Error("x".repeat(20_000))).length,
    ).toBeLessThanOrEqual(8192);
  });
  it("keeps failures causal and continues resource reclamation after evidence failure", async () => {
    const cleanup = new AcceptanceCleanup(context);
    expect(
      await cleanup.attempt("history", async () => {
        throw new Error("History pagination did not advance");
      }),
    ).toBe(false);
    expect(await cleanup.attempt("live-stop", async () => {})).toBe(true);
    expect(cleanup.failures).toEqual([
      { stage: "history", message: "History pagination did not advance" },
    ]);
    expect(cleanup.events.map(({ phase }) => phase)).toEqual([
      "queued",
      "started",
      "failed",
      "queued",
      "started",
      "completed",
    ]);
    expect(
      cleanup.events.every(
        (event) =>
          event.traceId === "trace" &&
          event.causationId === "cause" &&
          event.durationMs >= 0,
      ),
    ).toBe(true);
    expect(() => cleanup.throwIfFailed()).toThrow(
      "history: History pagination did not advance",
    );
  });
  it("records cancellation without manufacturing a successful cleanup", async () => {
    const abort = new AbortController();
    abort.abort();
    const cleanup = new AcceptanceCleanup({ ...context, signal: abort.signal });
    await cleanup.attempt("history", async () => abort.signal.throwIfAborted());
    expect(cleanup.events.at(-1)?.phase).toBe("cancelled");
    expect(() => cleanup.throwIfFailed()).toThrow("Acceptance cleanup failed");
  });
});
