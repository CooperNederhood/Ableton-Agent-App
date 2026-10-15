import { describe, expect, it } from "vitest";
import * as protocol from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixture } from "@ableton-agent/protocol/testing";
import { readFile } from "node:fs/promises";

import {
  createNativeScenarioApproval,
  verifyNativeListeningEvidence,
} from "./native-listening-verification.mjs";

function evidence() {
  const { proof, observation } = createSyntheticNativeListeningFixture();
  observation.attacks = [0, 1, 2, 3].map((beat) => ({
    beat,
    sample: observation.startSample + beat * 24000,
    strength: 1,
  }));
  observation.reduction.originalAttacks = 4;
  const owner = { sessionId: "session", agentId: "agent", liveSetId: "set" };
  const trace = {
    traceId: "00000000-0000-4000-8000-000000000001",
    correlationId: "correlation",
    causationId: "cause",
  };
  const listener = {
    connectionId: "connection",
    producer: { producerId: observation.listenerId },
    binding: { trackId: "track", deviceId: "device" },
    registration: { connectionEpoch: "epoch" },
  };
  const entry = {
    id: "context",
    passId: "pass",
    sessionId: "session",
    liveSetId: "set",
    trace,
    producer: {
      agentId: "agent",
      listenerId: observation.listenerId,
      connectionEpoch: "epoch",
      deviceId: "device-reference",
    },
    payload: observation,
  };
  return {
    owner,
    listener,
    target: {
      binding: {
        expectedDeviceReference: "device-reference",
        track: { expectedReference: "track-reference" },
      },
    },
    job: {
      passId: "pass",
      stage: "completed",
      cleanupPolicy: "leave-running",
      contextIds: ["context"],
    },
    pass: {
      id: "pass",
      status: "completed",
      complete: true,
      sessionId: "session",
      liveSetId: "set",
      initiatorAgentId: "agent",
      listenerIds: [observation.listenerId],
      requestedRange: { startBeat: 0, endBeat: 4 },
      actualRange: { startBeat: 0, endBeat: 4 },
      requestedMode: "arrangement",
      actualMode: "arrangement",
      trace,
    },
    entries: [entry],
    links: ["primary", "contributor"].map((relationship, index) => ({
      entryId: "context",
      subjectId: `subject-${index}`,
      sessionId: "session",
      liveSetId: "set",
      relationship,
      coverage: { startBeat: 0, endBeat: 4 },
      attribution: "unknown",
      freshness: { status: "unknown" },
    })),
    subjects: ["arrangement-range", "track"].map((kind, index) => ({
      id: `subject-${index}`,
      kind,
      trackId: "track-reference",
      sessionId: "session",
      liveSetId: "set",
      binding: {
        semanticLocator: {
          trackId: "track-reference",
          arrangementRange: { startBeat: 0, endBeat: 4 },
        },
      },
    })),
    received: [
      {
        connectionId: "connection",
        producer: listener.producer,
        binding: listener.binding,
        result: {
          status: "completed",
          passId: "pass",
          connectionEpoch: "epoch",
          ...trace,
          observation,
          nativeCapture: proof,
        },
      },
    ],
    typed: {
      action: "get",
      entry: {
        contextId: "context",
        passId: "pass",
        listenerId: observation.listenerId,
        freshness: "unknown",
      },
      observation,
    },
    resumed: {
      action: "get",
      entry: {
        contextId: "context",
        passId: "pass",
        listenerId: observation.listenerId,
        freshness: "unknown",
      },
      observation,
    },
    baseline: { trackCount: 1 },
    final: { trackCount: 1 },
  };
}

describe("native listening independent verification (synthetic unit evidence only)", () => {
  it("accepts exact proof plus one typed atomic historical track/range context", () => {
    expect(verifyNativeListeningEvidence(evidence(), protocol)).toMatchObject({
      stereoFrames: 96000,
      envelopeWindows: 20,
      spectralWindows: 20,
      estimatedAttacks: 4,
      cleanupPolicy: "leave-running",
      attribution: "unknown",
    });
  });
  it.each([
    [
      "wrong device",
      (e) => {
        e.entries[0].producer.deviceId = "foreign";
      },
    ],
    [
      "wrong contributor track",
      (e) => {
        e.subjects[1].trackId = "foreign";
      },
    ],
    [
      "wrong context pass",
      (e) => {
        e.entries[0].passId = "foreign";
      },
    ],
    [
      "queued acceptance",
      (e) => {
        e.job.stage = "arming";
      },
    ],
    [
      "wrong owner",
      (e) => {
        e.pass.sessionId = "foreign";
      },
    ],
    [
      "wrong epoch",
      (e) => {
        e.received[0].result.connectionEpoch = "stale";
      },
    ],
    [
      "wrong causation",
      (e) => {
        e.received[0].result.causationId = "stale";
      },
    ],
    [
      "missing proof",
      (e) => {
        delete e.received[0].result.nativeCapture;
      },
    ],
    [
      "missing FFT",
      (e) => {
        e.received[0].result.nativeCapture.spectralWindows.pop();
      },
    ],
    [
      "fake host bracket",
      (e) => {
        e.received[0].result.nativeCapture.after.frames[0][2]++;
      },
    ],
    [
      "duplicate context",
      (e) => {
        e.entries.push(e.entries[0]);
      },
    ],
    [
      "exclusive attribution",
      (e) => {
        e.links[0].attribution = "exclusive";
      },
    ],
    [
      "freshness promotion",
      (e) => {
        e.links[0].freshness.status = "fresh";
      },
    ],
    [
      "clip association",
      (e) => {
        e.subjects[0].kind = "clip";
      },
    ],
    [
      "reopen data mismatch",
      (e) => {
        e.resumed = {
          ...e.resumed,
          observation: { ...e.resumed.observation, passId: "foreign" },
        };
      },
    ],
    [
      "Set mutation",
      (e) => {
        e.final.trackCount++;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const e = evidence();
    mutate(e);
    expect(() => verifyNativeListeningEvidence(e, protocol)).toThrow();
  });
});

describe("native scenario exact actor approval guards", () => {
  async function fixture() {
    const manifest = JSON.parse(
      await readFile(
        "integration/live-scenarios/native-playback-and-listen.json",
      ),
    );
    const binding = {
      listenerId: "native",
      passIds: new Set(["owned"]),
      contextIds: new Set(["context"]),
    };
    return createNativeScenarioApproval(manifest, binding);
  }
  const play = (args = {}) => ({
    toolName: "ableton_listening",
    risk: "reversible",
    arguments: {
      action: "play-arrangement-and-listen",
      listenerIds: ["native"],
      startBeat: 0,
      endBeat: 4,
      maximumDurationMs: 8000,
      ...args,
    },
  });
  const inspect = {
    toolName: "ableton_listening",
    risk: "read",
    arguments: { action: "inspect-listeners" },
  };
  it("requires discovery before exactly one bounded actor mutation", async () => {
    const f = await fixture();
    expect(await f.request(play())).toBe(false);
    expect(await f.request(inspect)).toBe(true);
    expect(await f.request(play())).toBe(true);
    expect(await f.request(play())).toBe(false);
    expect(f.mutationCount).toBe(1);
  });
  it.each([
    { listenerIds: ["old-unscoped"] },
    { listenerIds: ["native", "other"] },
    { startBeat: 1 },
    { endBeat: 20 },
    { maximumDurationMs: 8001 },
  ])("denies unsafe/widened playback %j", async (args) => {
    const f = await fixture();
    await f.request(inspect);
    expect(await f.request(play(args))).toBe(false);
  });
  it("bounds calls, historical queries, pass/context ownership and tool surface", async () => {
    const f = await fixture();
    expect(
      await f.request({
        toolName: "ableton_transport",
        risk: "reversible",
        arguments: { action: "set-playing", isPlaying: false },
      }),
    ).toBe(false);
    expect(
      await f.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "get-pass", passId: "foreign" },
      }),
    ).toBe(false);
    expect(
      await f.request({
        toolName: "ableton_context",
        risk: "read",
        arguments: {
          action: "get",
          contextId: "context",
          includeHistorical: false,
        },
      }),
    ).toBe(false);
    expect(
      await f.request({
        toolName: "ableton_context",
        risk: "read",
        arguments: {
          action: "get",
          contextId: "context",
          includeHistorical: true,
        },
      }),
    ).toBe(true);
    for (let i = f.decisions.length; i < 8; i++) await f.request(inspect);
    expect(await f.request(inspect)).toBe(false);
    expect(f.decisions.at(-1).reason).toBe("tool-call-budget");
  });
});
