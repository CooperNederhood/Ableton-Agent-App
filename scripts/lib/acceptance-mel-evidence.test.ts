import { describe, expect, it, vi } from "vitest";
import { restoreMelSmoke } from "../../tests/electron/acceptance-evidence.js";
import { melSmokeFixture } from "../../packages/test-support/src/integration/mel-smoke-test-support.js";
import { verifyMelSmoke } from "../../packages/test-support/src/integration/mel-smoke.js";

function fixture() {
  const f = melSmokeFixture();
  const owner = f.observation.ownership;
  const base = {
    trace: { traceId: owner.traceId, spanId: "span" },
    correlationId: owner.correlationId,
    outcome: "success" as const,
    durationMs: 1,
  };
  const history = [
    {
      ...base,
      name: "listening.metric-capture.completed",
      attributes: {
        passId: owner.passId,
        action: "cleanup",
        listeners: [{ ...owner }],
      },
    },
    {
      ...base,
      name: "listening.runtime.session-source-cleanup.completed",
      sessionId: f.owner.appSessionId,
      activeAgentId: f.owner.agentId,
      attributes: { passId: owner.passId },
    },
  ];
  const readContext = vi.fn().mockResolvedValue(f.observation);
  const readTrace = vi.fn(async () => [...history, ...f.history]);
  const restore = () =>
    restoreMelSmoke([f.smoke], true, f.owner, readContext, readTrace);
  return { ...f, history, readContext, readTrace, restore };
}
describe("packaged mel typed context restoration", () => {
  it("rereads all 24 stereo vectors and projects full lossless pages after owned restart", async () => {
    const f = fixture();
    const restored = await f.restore();
    expect(restored).toEqual([{ ...f.smoke, afterOwnedRestart: true }]);
    expect(f.readContext).toHaveBeenCalledExactlyOnceWith(f.contextId);
    expect(f.readTrace).toHaveBeenCalledExactlyOnceWith(
      f.observation.ownership.traceId,
    );
    verifyMelSmoke(
      {
        ...f.input,
        evidence: {
          schemaVersion: 1,
          facts: f.turn.facts,
          unchanged: [],
          melSmoke: restored,
          contexts: f.turn.contexts.map((entry) => ({
            ...entry,
            afterOwnedRestart: true,
          })),
        },
      },
      "a",
      true,
    );
  });
  it.each([
    "native",
    "source",
    "failure",
    "cancelled",
    "foreign",
    "negative-time",
  ])("rejects %s cleanup despite complete cached mel", async (mode) => {
    const f = fixture();
    if (mode === "native") f.history.shift();
    else if (mode === "source") f.history.pop();
    else if (mode === "foreign")
      Object.assign(f.history[0]!, { correlationId: "foreign" });
    else if (mode === "negative-time")
      Object.assign(f.history[0]!, { durationMs: -1 });
    else Object.assign(f.history[0]!, { outcome: mode });
    await expect(f.restore()).rejects.toThrow();
  });
  it("does not substitute cached vectors for changed or absent persisted context", async () => {
    const f = fixture();
    const changed = structuredClone(f.observation);
    Object.assign(changed.metrics["mel-bands"]!.frames[0]!.magnitudes[0], {
      0: 99,
    });
    f.readContext.mockResolvedValue(changed);
    const restored = await f.restore();
    expect(restored[0]!.observation).toEqual(changed);
    expect(() =>
      verifyMelSmoke(
        {
          ...f.input,
          evidence: {
            schemaVersion: 1,
            facts: f.turn.facts,
            unchanged: [],
            melSmoke: restored,
            contexts: f.turn.contexts.map((entry) => ({
              ...entry,
              afterOwnedRestart: true,
            })),
          },
        },
        "a",
        true,
      ),
    ).toThrow();
    f.readContext.mockResolvedValue(undefined);
    await expect(f.restore()).rejects.toThrow();
  });
  it("propagates typed context and History read failures, skipping unused evidence", async () => {
    const f = fixture();
    const error = new Error("read denied or cancelled");
    f.readContext.mockRejectedValue(error);
    await expect(f.restore()).rejects.toBe(error);
    f.readContext.mockResolvedValue(f.observation);
    f.readTrace.mockRejectedValue(error);
    await expect(f.restore()).rejects.toBe(error);
    f.readContext.mockClear();
    f.readTrace.mockClear();
    expect(
      await restoreMelSmoke([], true, f.owner, f.readContext, f.readTrace),
    ).toEqual([]);
    expect(f.readContext).not.toHaveBeenCalled();
    expect(f.readTrace).not.toHaveBeenCalled();
  });
  it("requires freshly persisted mel terminal receipt even with healthy baseline cleanup", async () => {
    const f = fixture();
    f.readTrace.mockResolvedValue(f.history);
    await expect(f.restore()).rejects.toThrow();
  });
  it("rejects altered but internally valid native receipts after restart", async () => {
    const f = fixture();
    const receipt = f.smoke.nativeLifecycle.at(-1)!;
    const events = await f.readTrace();
    const mel = events.find(
      (event) => "id" in event && event.id === receipt.eventId,
    )!;
    if (!("lifecycle" in mel.attributes))
      throw new Error("Missing synthetic lifecycle");
    const lifecycle = mel.attributes.lifecycle as {
      facts: { field: string; actual: { value: number } }[];
    };
    lifecycle.facts.find((fact) => fact.field === "mel.sourceClockExclusive")!
      .actual.value++;
    f.readTrace.mockResolvedValue(events);
    const restored = await f.restore();
    expect(() =>
      verifyMelSmoke(
        {
          ...f.input,
          evidence: {
            schemaVersion: 1,
            facts: f.turn.facts,
            unchanged: [],
            melSmoke: restored,
            contexts: f.turn.contexts.map((entry) => ({
              ...entry,
              afterOwnedRestart: true,
            })),
          },
        },
        "a",
        true,
      ),
    ).toThrow(/changed after owned restart/);
  });
});
