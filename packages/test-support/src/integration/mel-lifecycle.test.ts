import { describe, expect, it } from "vitest";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import { projectMelLifecycle, validateMelLifecycle } from "./mel-lifecycle.js";
import { validateMelSmoke } from "./mel-smoke.js";

function fixture() {
  const f = structuredClone(melSmokeFixture());
  const terminal = f.history.at(-1)!;
  const lifecycle = terminal.attributes.lifecycle as {
    facts: { field: string; actual: { state: string; value: number } }[];
  };
  return { ...f, terminal, lifecycle };
}
describe("owned mel physical-drain smoke receipts (synthetic only)", () => {
  it("projects the actual 16-fact terminal receipt separately from generic capture cleanup", () => {
    const f = fixture();
    expect(projectMelLifecycle(f.history, f.observation)).toEqual(
      f.smoke.nativeLifecycle,
    );
    expect(f.smoke.nativeLifecycle.at(-1)).toMatchObject({
      stage: "completed",
      phase: "drain",
      reason: "mel_native_cleanup_complete",
      frames: 43,
      facts: {
        "mel.abi": 3,
        "mel.sampleRate": 48000,
        "mel.bandCount": 24,
        "mel.expectedFrames": 43,
        "mel.validFrames": 43,
        "mel.receivedFrames": 43,
        "mel.dspGeneration": 7,
        "mel.startSample": 0,
        "mel.endSample": 90000,
        "mel.terminalReason": 10,
        "mel.lostFrames": 0,
        "mel.trailingSamples": 1936,
        "mel.terminalConsumed": 1,
        "mel.recordsDrained": 46,
        "mel.framesDrained": 43,
        "mel.sourceClockExclusive": 90064,
      },
    });
  });
  it.each(["stopped", "drain"])(
    "rejects foreign %s diagnostic operands",
    (kind) => {
      const f = fixture();
      const diagnostic = f.history.find(
        (event) =>
          (event.attributes.lifecycle as { reason: string }).reason ===
          `mel_native_${kind}_receipt`,
      )!;
      const lifecycle = diagnostic.attributes.lifecycle as typeof f.lifecycle;
      lifecycle.facts.find((fact) => fact.field === `mel.${kind}.epoch`)!.actual
        .value++;
      expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
    },
  );
  it.each([0, 2, 4])("rejects post-readiness ABI %s", (abi) => {
    const f = fixture();
    f.lifecycle.facts.find((fact) => fact.field === "mel.abi")!.actual.value =
      abi;
    expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
  });
  it("accepts an empty pending-arm event before readiness, never after it", () => {
    const f = fixture();
    const pending = structuredClone(f.history[1]!);
    pending.id = "pending-arm";
    pending.trace!.spanId = pending.id;
    pending.sequence = 25;
    pending.name = "output.listener.native.metric.mel-bands.progress";
    Object.assign(pending.attributes.lifecycle as object, {
      eventId: pending.id,
      stage: "progress",
      reason: "mel_native_arm_pending",
    });
    f.history.splice(2, 0, pending);
    expect(() => projectMelLifecycle(f.history, f.observation)).not.toThrow();
    f.history.splice(2, 1);
    pending.sequence = 35;
    f.history.splice(3, 0, pending);
    expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
  });
  it.each([
    ["stopped", "producerAbi", 2],
    ["stopped", "generation", 8],
    ["stopped", "sequence", 42],
    ["stopped", "startSample", 88063],
    ["stopped", "endSample", 89999],
    ["stopped", "lostFrames", 1],
    ["stopped", "trailingSamples", 1935],
    ["stopped", "reason", 11],
    ["stopped", "sampleRate", 44100],
    ["stopped", "bandCount", 23],
    ["drain", "producerAbi", 2],
    ["drain", "generation", 8],
    ["drain", "recordsDrained", 45],
    ["drain", "framesDrained", 42],
    ["drain", "terminalConsumed", 0],
    ["drain", "clockValid", 0],
    ["drain", "sourceClockExclusive", 90063],
    ["drain", "token", 0],
    ["drain", "token", 12001],
  ] as const)("rejects inconsistent %s.%s evidence", (kind, field, value) => {
    const f = fixture();
    const event = f.history.find(
      (item) =>
        (item.attributes.lifecycle as { reason: string }).reason ===
        `mel_native_${kind}_receipt`,
    )!;
    const lifecycle = event.attributes.lifecycle as typeof f.lifecycle;
    lifecycle.facts.find(
      (fact) => fact.field === `mel.${kind}.${field}`,
    )!.actual.value = value;
    expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
  });
  it.each(["missing", "duplicate", "reordered"])(
    "rejects %s physical diagnostic receipts",
    (mode) => {
      const f = fixture();
      const index = f.history.findIndex(
        (event) =>
          (event.attributes.lifecycle as { reason: string }).reason ===
          "mel_native_drain_receipt",
      );
      if (mode === "missing") f.history.splice(index, 1);
      else if (mode === "duplicate")
        f.history.splice(index, 0, f.history[index]!);
      else f.history[index]!.sequence = 1;
      expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
    },
  );
  it.each([
    ["abi", 1],
    ["sampleRate", 44100],
    ["bandCount", 23],
    ["expectedFrames", 42],
    ["validFrames", 42],
    ["receivedFrames", 42],
    ["dspGeneration", 0],
    ["startSample", 1],
    ["endSample", 90001],
    ["terminalReason", 11],
    ["lostFrames", 1],
    ["trailingSamples", 1935],
    ["terminalConsumed", 0],
    ["recordsDrained", 45],
    ["framesDrained", 42],
    ["sourceClockExclusive", 89999],
  ])(
    "rejects inconsistent terminal mel.%s independently of complete baseline timelines",
    (field, value) => {
      const f = fixture();
      f.lifecycle.facts.find(
        (fact) => fact.field === `mel.${field}`,
      )!.actual.value = value;
      expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
      Object.assign(f.smoke.nativeLifecycle.at(-1)!.facts, {
        [`mel.${field}`]: value,
      });
      expect(() => validateMelSmoke(f.smoke)).toThrow();
    },
  );
  it.each([
    "missing",
    "duplicate",
    "unknown",
    "unavailable",
    "truncated",
    "nonfinite",
  ])("rejects %s terminal facts", (mode) => {
    const f = fixture();
    const facts = f.lifecycle.facts;
    if (mode === "missing") facts.pop();
    else if (mode === "duplicate") facts[0]!.field = facts[1]!.field;
    else if (mode === "unknown") facts[0]!.field = "mel.secret";
    else if (mode === "unavailable") facts[0]!.actual.state = "unavailable";
    else if (mode === "truncated")
      Object.assign(facts[0]!.actual, { truncated: true });
    else facts[0]!.actual.value = Infinity;
    expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
  });
  it.each([
    "traceId",
    "correlationId",
    "passId",
    "listenerId",
    "generation",
    "nativeEpoch",
    "connectionId",
    "connectionEpoch",
  ])("rejects foreign %s receipt", (key) => {
    const f = fixture();
    if (key === "traceId") f.terminal.trace!.traceId = "foreign";
    else if (key === "correlationId") f.terminal.correlationId = "foreign";
    else
      Object.assign(f.terminal.attributes, {
        [key]: key === "nativeEpoch" ? 9 : "foreign",
      });
    expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
    Object.assign(f.smoke.nativeLifecycle.at(-1)!, {
      [key]: key === "nativeEpoch" ? 9 : "foreign",
    });
    expect(() => validateMelSmoke(f.smoke)).toThrow();
  });
  it.each([
    "eventId",
    "causationId",
    "generation",
    "nativeEpoch",
    "scope",
    "metric",
    "phase",
    "stage",
    "frames",
    "durationMs",
  ])("rejects tampered native lifecycle %s", (key) => {
    const f = fixture();
    Object.assign(f.lifecycle, {
      [key]: ["nativeEpoch", "frames", "durationMs"].includes(key)
        ? -1
        : "foreign",
    });
    expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
  });
  it("rejects missing/duplicate/reordered terminal and within-pass DSP generation changes", () => {
    const f = fixture();
    for (const history of [
      [],
      f.history.slice(0, -1),
      [...f.history, f.terminal],
      [f.terminal, ...f.history.slice(0, -1)],
    ])
      expect(() => projectMelLifecycle(history, f.observation)).toThrow();
    f.lifecycle.facts.find(
      (fact) => fact.field === "mel.dspGeneration",
    )!.actual.value = 8;
    expect(() => projectMelLifecycle(f.history, f.observation)).toThrow();
    Object.assign(f.smoke.nativeLifecycle.at(-1)!.facts, {
      "mel.dspGeneration": 8,
    });
    expect(() =>
      validateMelLifecycle(f.smoke.nativeLifecycle, f.observation),
    ).toThrow();
  });
  it("allows a different positive DSP generation between independent instances, never substitutes UUID generation", () => {
    const f = fixture();
    for (const event of f.smoke.nativeLifecycle)
      if (Object.hasOwn(event.facts, "mel.dspGeneration"))
        Object.assign(event.facts, { "mel.dspGeneration": 101 });
    expect(() =>
      validateMelLifecycle(f.smoke.nativeLifecycle, f.observation),
    ).not.toThrow();
    Object.assign(f.smoke.nativeLifecycle.at(-1)!.facts, {
      "mel.dspGeneration": f.observation.ownership.generation,
    });
    expect(() =>
      validateMelLifecycle(f.smoke.nativeLifecycle, f.observation),
    ).toThrow();
  });
});
