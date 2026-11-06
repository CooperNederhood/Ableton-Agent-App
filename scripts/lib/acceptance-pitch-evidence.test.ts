import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LocalObservabilityJournal,
  telemetryEventEnvelopeSchema,
} from "@ableton-agent/observability";
import { restorePitchSmoke } from "../../tests/electron/acceptance-evidence.js";
import {
  pitchHistory,
  pitchSmokeFixture,
} from "../../packages/test-support/src/integration/pitch-smoke-test-support.js";
import {
  flatnessHistory,
  flatnessOwner,
} from "../../packages/test-support/src/integration/flatness-smoke-test-support.js";
import {
  projectPitchSmoke,
  verifyPitchSmoke,
} from "../../packages/test-support/src/integration/pitch-smoke.js";
import { verifyMelSmoke } from "../../packages/test-support/src/integration/mel-smoke.js";
import { verifyAgentListeningResult } from "../../packages/test-support/src/integration/agent-listening-result.js";
import { createDefaultAssertions } from "../../packages/test-support/src/integration/assertions.js";
import {
  validateEvidence,
  validateTurn,
} from "../../packages/test-support/src/integration/validation.js";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.js";
import { writeScenarioReceipt } from "./scenario-receipts.mjs";
import type { RunEvidence } from "../../packages/test-support/src/integration/contracts.js";

function fixture() {
  const f = pitchSmokeFixture();
  const restored: RunEvidence = {
    schemaVersion: 1,
    contexts: f.turn.contexts.map((entry) => ({
      ...entry,
      afterOwnedRestart: true,
    })),
    facts: { ...f.turn.facts },
    unchanged: [],
    pitchSmoke: [{ ...f.pitch, afterOwnedRestart: true }],
  };
  return { ...f, restored };
}
describe("pitch acceptance ownership and typed History persistence", () => {
  it("admits exactly 24 zero-frame diagnostic facts through canonical ingress", () => {
    for (const event of pitchHistory().slice(1)) {
      const lifecycle = nativeMetricLifecycleSchema.parse(
        event.attributes.lifecycle,
      );
      expect(lifecycle.metric).toBe("monophonic-pitch");
      expect(lifecycle.frames).toBe(0);
      expect(lifecycle.facts).toHaveLength(24);
    }
  });
  it("keeps agent consumption limited to the existing report while validating diagnostic pitch separately", () => {
    const f = fixture();
    verifyAgentListeningResult(f.input, "a");
    verifyMelSmoke(f.input, "a", false);
    verifyPitchSmoke(f.input, "a", false);
    validateTurn(f.turn);
    validateEvidence(f.restored);
    const registry = createDefaultAssertions();
    for (const afterRestart of [false, true]) {
      expect(
        registry.evaluate(
          { name: "pitch-smoke", parameters: { sourceId: "a", afterRestart } },
          { ...f.input, evidence: f.restored },
        ).passed,
      ).toBe(true);
    }
    expect(f.observation.requestedMetrics).not.toContain("monophonic-pitch");
  });
  it.each([
    "missing-pitch",
    "missing-binary",
    "wrong-sha",
    "spectral-path",
    "mel-path",
    "wrong-baseline",
    "wrong-phase",
    "wrong-owner",
    "changed-mapping",
    "changed-after-restart",
    "cached-restart",
    "cleanup",
    "foreign-source",
    "foreign-native",
    "extra-capture",
    "failed-turn",
    "cancelled-turn",
  ])(
    "rejects %s despite healthy baseline, mel, and agent consumption",
    (fault) => {
      const f = fixture();
      if (fault === "missing-pitch")
        Object.assign(f.turn, { pitchSmoke: undefined });
      if (fault === "missing-binary")
        Object.assign(f.turn.facts, { pitchLoadedBinaryVerified: false });
      if (fault === "wrong-sha")
        Object.assign(f.turn.facts, {
          pitchLoadedBinarySha256: "0".repeat(64),
        });
      if (fault === "spectral-path")
        Object.assign(f.turn.facts, {
          pitchLoadedBinaryPath: "/owned/fluid.spectralshape~",
        });
      if (fault === "mel-path")
        Object.assign(f.turn.facts, {
          pitchLoadedBinaryPath: "/owned/listener.mel~",
        });
      if (fault === "wrong-baseline")
        Object.assign(f.input.baseline.facts, {
          pitchLoadedBinaryState: "failed",
        });
      if (fault === "wrong-phase")
        Object.assign(f.turn.facts, { pitchLoadedBinaryPhase: "baseline" });
      if (fault === "wrong-owner")
        Object.assign(f.turn.facts, { pitchLoadedBinaryPassId: "foreign" });
      if (fault === "changed-mapping")
        Object.assign(f.turn.facts, { pitchLoadedBinaryInode: "999" });
      if (fault === "changed-after-restart")
        Object.assign(f.restored.facts, { pitchLoadedBinaryPassId: "foreign" });
      if (fault === "cached-restart")
        Object.assign(f.restored, { pitchSmoke: [f.pitch] });
      if (fault === "cleanup")
        Object.assign(f.turn.captures[0]!, { cleanupComplete: false });
      if (fault === "foreign-source")
        Object.assign(f.turn.captures[0]!, {
          source: { ...f.turn.captures[0]!.source, clipId: "foreign" },
        });
      if (fault === "foreign-native")
        Object.assign(f.turn.captures[0]!.native!, { nativeEpoch: 2 });
      if (fault === "extra-capture")
        Object.assign(f.turn, {
          captures: [...f.turn.captures, f.turn.captures[0]!],
        });
      if (fault === "failed-turn" || fault === "cancelled-turn")
        Object.assign(f.turn, { status: fault.split("-")[0] });
      const afterRestart = fault.endsWith("restart");
      expect(() =>
        verifyPitchSmoke(
          { ...f.input, evidence: f.restored },
          "a",
          afterRestart,
        ),
      ).toThrow();
      expect(
        createDefaultAssertions().evaluate(
          { name: "pitch-smoke", parameters: { sourceId: "a", afterRestart } },
          { ...f.input, evidence: f.restored },
        ).passed,
      ).toBe(false);
    },
  );
  it("rereads persisted pairs and does not mask missing, changed or foreign History with a cache", async () => {
    const f = fixture();
    const read = vi.fn().mockResolvedValue(f.pitchHistory);
    expect(await restorePitchSmoke([f.pitch], true, read)).toEqual(
      f.restored.pitchSmoke,
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(f.pitch.traceId);
    for (const history of [
      [],
      flatnessHistory(),
      f.pitchHistory.slice(0, -1),
      pitchHistory(),
    ]) {
      read.mockResolvedValue(history);
      await expect(restorePitchSmoke([f.pitch], true, read)).rejects.toThrow();
    }
    const changed = structuredClone(f.pitchHistory);
    for (const event of changed.slice(3)) {
      const lifecycle = event.attributes.lifecycle as {
        facts: { field: string; actual: { value?: unknown } }[];
      };
      lifecycle.facts.find(
        (fact) => fact.field === "pitch.leftConfidence",
      )!.actual.value = 0.1;
    }
    const restored = await restorePitchSmoke(
      [f.pitch],
      true,
      async () => changed,
    );
    expect(restored).not.toEqual(f.restored.pitchSmoke);
    expect(() =>
      verifyPitchSmoke(
        { ...f.input, evidence: { ...f.restored, pitchSmoke: restored } },
        "a",
        true,
      ),
    ).toThrow();
  });
  it("propagates read denial/cancellation and skips traces without an owned capture", async () => {
    const f = fixture();
    for (const error of [
      new Error("History read denied"),
      new DOMException("Aborted", "AbortError"),
    ])
      await expect(
        restorePitchSmoke([f.pitch], true, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    const read = vi.fn();
    expect(await restorePitchSmoke([], true, read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it("reopens the journal and exports full typed pairs within existing receipt bounds", async () => {
    const parent = resolve(".test-artifacts/pitch-history-unit");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "case-"));
    let journal: LocalObservabilityJournal | undefined;
    try {
      const history = pitchHistory();
      const pitch = projectPitchSmoke(history, flatnessOwner);
      const path = join(directory, "journal.sqlite");
      journal = await LocalObservabilityJournal.open({ path });
      for (const event of history) {
        await journal.enqueue(
          telemetryEventEnvelopeSchema.parse(
            Object.fromEntries(
              Object.entries(event).filter(
                ([key]) => key !== "sequence" && key !== "recordedAt",
              ),
            ),
          ),
        );
      }
      const readTrace = async (traceId: string) =>
        (await journal!.readTrace(traceId, { order: "asc", limit: 100 })).items;
      const before = await restorePitchSmoke([pitch], false, readTrace);
      await journal.shutdown();
      journal = await LocalObservabilityJournal.open({ path });
      const after = await restorePitchSmoke(before, true, readTrace);
      expect(after).toEqual(
        before.map((entry) => ({ ...entry, afterOwnedRestart: true })),
      );
      const receipt = join(directory, "evidence.json");
      const evidence: RunEvidence = {
        schemaVersion: 1,
        contexts: [],
        facts: {},
        unchanged: [],
        pitchSmoke: after,
      };
      await writeScenarioReceipt(receipt, evidence);
      const saved = JSON.parse(await readFile(receipt, "utf8")) as RunEvidence;
      validateEvidence(saved);
      expect(saved.pitchSmoke).toEqual(after);
      expect(JSON.stringify(saved).length).toBeLessThan(65_536);
      expect(JSON.stringify(saved)).not.toContain("[truncated]");
    } finally {
      await journal?.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
