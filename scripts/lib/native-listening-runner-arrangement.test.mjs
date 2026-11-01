import { readFile, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as protocol from "@ableton-agent/protocol";
import { listenerRegistrationMetricSchema } from "@ableton-agent/signal-routing";
import { createSyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import { openSessionContextStore } from "@ableton-agent/project-state";
import { createSessionContextHost } from "@ableton-agent/application";
import {
  resolveLiveAgentStorage,
  resolveNestedSessionStorage,
} from "@ableton-agent/storage";
import { createListeningRuntimeHost } from "../../packages/runtime/src/listening-runtime-host.ts";
import { createSyntheticMetricListenerPeer } from "../../packages/runtime/src/metric-listening-test-support.ts";
import {
  reviewNativeScenario,
  admitNativeScenarios,
} from "./native-listening-runner.mjs";
import {
  metricArrangementSmokePrompt,
  verifyNativeMetricArrangementFixture,
  createMetricArrangementApproval,
  verifyNativeMetricListeningEvidence,
} from "./native-metric-scenario.mjs";
import { createNativeScenarioApproval } from "./native-listening-verification.mjs";

const load = async () =>
  JSON.parse(
    await readFile(
      "integration/live-scenarios/native-metric-arrangement-audio-fractional-spectrum.json",
      "utf8",
    ),
  );

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Shift only canonical synthetic musical coordinates; counters/support remain
// unchanged. Every resulting proof is reparsed, never actual DSP evidence.
function fractionalMetricData(partial = false) {
  const data = globalThis.structuredClone(
    createSyntheticMetricWireFixture("arrangement", partial),
  );
  const seen = new Set();
  const shift = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (
      Array.isArray(value) &&
      value.length === 11 &&
      [0, 1].includes(value[0])
    ) {
      value[1] += 0.25;
      value[8] += 0.25;
      if (value[0] === 1) value[5] = value[1] % 1;
      return;
    }
    if (Array.isArray(value) && value.length === 12 && value[2] > 0) {
      value[4] += 0.25;
      value[7] += 0.25;
      value[8] += 0.25;
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (["startBeat", "endBeat"].includes(key) && typeof child === "number")
        value[key] += 0.25;
      else shift(child);
    }
  };
  shift(data);
  protocol.nativeMetricReadyProofSchema.parse(data.ready);
  protocol.nativeMetricSourceCoverageProofSchema.parse(data.proof);
  protocol.metricAudioObservationSchema.parse(data.observation);
  protocol.assertNativeMetricObservationSource(data.proof, data.observation, {
    ...data.proof.armed.ownership,
    config: data.config,
  });
  return data;
}

async function runtimeFixture(failure) {
  const manifest = await load();
  const data = fractionalMetricData(failure === "partial");
  const root = resolve(
    ".test-artifacts/independent-metric-listening",
    `arrangement-unit-${randomUUID()}`,
  );
  await mkdir(root, { recursive: true });
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const owner = {
    sessionId: randomUUID(),
    agentId: randomUUID(),
    liveSetId: randomUUID(),
  };
  const storage = resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: resolve(root, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
    },
  });
  const path = resolveNestedSessionStorage(storage, owner).entityContextPath;
  await mkdir(dirname(path), { recursive: true });
  let repository = await openSessionContextStore({ ...owner, path });
  const releaseReservation = vi.spyOn(repository, "releaseReservation");
  const appendPass = vi.spyOn(repository, "appendPass");
  cleanup.push(() => repository.close());
  const context = {
    ...owner,
    actorKind: "agent",
    trace: {
      traceId: randomUUID(),
      correlationId: "arrangement-unit",
      causationId: "reviewed-prompt",
    },
  };
  const log = [],
    controls = [],
    received = [],
    jobs = [],
    positioning = [];
  let beat = 0,
    playing = false;
  const trackReference = randomUUID(),
    deviceReference = randomUUID();
  const fingerprint = {
    algorithm: "sha256",
    scope: "available-live-fields/v1",
    digest: "a".repeat(64),
    completeness: "unknown",
    unknownReasons: ["routing-unmeasured"],
  };
  const target = {
    ...source(),
    binding: {
      track: {
        kind: "regular",
        index: 2,
        expectedReference: trackReference,
        expectedName: "Fixture audio",
      },
      deviceIndex: 0,
      expectedDeviceReference: deviceReference,
      expectedDeviceName: "Synthetic listener",
      expectedClassName: "MxDeviceAudioEffect",
    },
    canonicalPath: "live_set tracks 2 devices 0",
    pathAttestation: {
      schemaVersion: 1,
      source: "remote-script-lom",
      canonicalDevicePath: "live_set tracks 2 devices 0",
      canonicalTrackPath: "live_set tracks 2",
      trackReference,
      deviceReference,
      placement: { kind: "track-device", deviceIndex: 0 },
    },
    verified: true,
    trackEvidence: [],
    upstreamDevices: [],
    dependenciesTruncated: false,
    fingerprint,
    attribution: "nonexclusive",
    unknownReasons: ["routing-unmeasured"],
  };
  target.clips[0].target = {
    view: "arrangement",
    track: target.binding.track,
    expectedClipReference: randomUUID(),
    expectedClipName: "AA_SESSION_120BPM_8BEATS",
    expectedStartTime: 0,
  };
  target.clips[0].fingerprint = fingerprint;
  const inspection = (params) => ({
    schemaVersion: 1,
    bindingScope: "live-connection",
    bindingQueryId: params.bindingQueryId,
    projectRevision: 1,
    transport: {
      playing,
      currentBeat: beat,
      tempo: 120,
      safeToStart: !playing,
      recording: {
        recordMode: false,
        sessionRecord: false,
        arrangementOverdub: false,
        sessionAutomationRecord: false,
      },
    },
    listeners: [globalThis.structuredClone(target)],
  });
  const descriptor = {
    connectionId: data.wire.connectionId,
    producer: {
      producerId: "listener",
      instanceId: "synthetic-instance",
      signalKind: "audio",
      schemaVersion: "metric-audio-observation/v1",
      displayName: "Synthetic, not physical",
      track: { id: "500" },
      device: { id: "600" },
    },
    binding: { trackId: "500", deviceId: "600" },
    registration: listenerRegistrationMetricSchema.parse({
      ...data.registration,
      deviceCanonicalPath: target.canonicalPath,
      trackCanonicalPath: "live_set tracks 2",
      nativeStatus: {
        ...data.registration.nativeStatus,
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
        executedGen: null,
      },
    }),
    phase: "idle",
  };
  if (failure === "wrong-version") descriptor.registration.version = 4;
  const peer = createSyntheticMetricListenerPeer(descriptor, data, (action) =>
    log.push(`metric:${action}`),
  );
  const requestControl = vi.fn(async (connectionId, input) => {
    const record = { connectionId, input: globalThis.structuredClone(input) };
    controls.push(record);
    record.reply = await peer.service.requestListenerControl(
      connectionId,
      input,
    );
    return record.reply;
  });
  const service = { ...peer.service, requestListenerControl: requestControl };
  const position = vi.fn(async (params) => {
    log.push("position");
    if (failure === "position-denied") throw new Error("position-denied");
    beat = failure === "position-wrong" ? 0 : params.range.startBeat;
    const reply = {
      schemaVersion: 1,
      mode: "arrangement",
      requestedStartBeat: params.range.startBeat,
      sourceOnset: "unverified",
      insertMarkerBeat: beat,
      currentBeat: beat,
      playing: false,
      changed: { insertMarker: true, currentPosition: true },
      cleanupPolicy: "leave-running",
    };
    positioning.push({
      params,
      reply,
      beforeNativePrepare: controls.length === 0,
    });
    return reply;
  });
  const start = vi.fn(async () => {
    log.push("start");
    playing = true;
    peer.launch();
    if (failure !== "cancelled") peer.complete();
    return {
      schemaVersion: 1,
      mode: "arrangement",
      cleanupPolicy: "leave-running",
      startedAtBeat: range.startBeat,
      sourceOnset: "unverified",
    };
  });
  const unsubscribe = service.onListenerResult((event) => {
    if (
      event.result.status === "completed" ||
      event.result.status === "partial"
    )
      received.push(event);
  });
  cleanup.push(unsubscribe);
  const host = createListeningRuntimeHost(
    {
      ableton: {
        getLiveIdentity: async () => ({
          liveSetId: owner.liveSetId,
          liveSetName: "Synthetic Set",
          saved: true,
          diagnostics: [],
        }),
        inspectListeningContext: async (params) => inspection(params),
        positionListeningPlayback: position,
        startListeningPlayback: start,
      },
      signals: { listeners: service, listenerTransport: service },
      events: { publish() {}, subscribe: () => () => {} },
      telemetry: { enqueue: () => true },
    },
    {
      independentMetricListeners: true,
      requestedMetrics: manifest.requestedMetrics,
      resolveTimingPolicy: () => manifest.setupContract.timingPolicy,
      resolveOwner: async () => owner,
      resolveRepository: async () => repository,
      onChange: (job) => jobs.push(job),
    },
  );
  cleanup.push(() => host.shutdown());
  const execute = async (signal) => {
    const result = await host.executeListeningOperation(
      {
        action: "play-arrangement-and-listen",
        listenerIds: ["listener"],
        ...manifest.capture,
      },
      { ...context, ...(signal ? { signal } : {}) },
    );
    return result.job.passId;
  };
  const verify = async (job) => {
    const entries = await Promise.all(
      (await repository.listEntries({ includeHistorical: true })).items.map(
        (e) => repository.getEntry(e.id),
      ),
    );
    const links = (await repository.listLinks({ includeHistorical: true }))
      .items;
    const subjects = await Promise.all(
      links.map((link) => repository.getSubject(link.subjectId)),
    );
    const typedHost = createSessionContextHost({
      resolveRepository: async () => repository,
    });
    const params = {
      action: "get",
      contextId: entries[0].id,
      includeHistorical: true,
    };
    const typed = await typedHost.executeContextOperation(params, context);
    const pass = await repository.getPass(job.passId);
    await repository.close();
    repository = await openSessionContextStore({ ...owner, path });
    const resumed = await typedHost.executeContextOperation(params, context);
    const input = {
      job,
      pass,
      entries,
      links,
      subjects,
      typed,
      resumed,
      received,
      listener: descriptor,
      owner,
      baseline: { immutable: true },
      final: { immutable: true },
      target,
      expected: { geometry: data.config.geometry },
      metricControls: controls,
      expectedSpectrum: true,
      expectedOutcome: "complete",
      arrangement: {
        range,
        fixture: verifyNativeMetricArrangementFixture(target, range),
        positioning,
      },
    };
    return {
      input,
      evidence: verifyNativeMetricListeningEvidence(input, protocol),
    };
  };
  return {
    host,
    context,
    execute,
    verify,
    repository,
    position,
    start,
    requestControl,
    log,
    jobs,
    peer,
    releaseReservation,
    appendPass,
  };
}

it("runs production wire5 fractional Arrangement positioning/metrics/publication and exact typed persistent reopen", async () => {
  const f = await runtimeFixture();
  const passId = await f.execute();
  const job = await f.host.waitForListeningPass(passId, f.context);
  expect(job.stage, JSON.stringify(job)).toBe("completed");
  const { evidence, input } = await f.verify(job);
  expect(evidence).toMatchObject({
    levelRows: 4,
    savedAndReopened: true,
    nativeCleanup: "confirmed-before-terminal-result",
  });
  expect(input.pass.requestedRange).toEqual(range);
  expect(f.log.indexOf("position")).toBeLessThan(
    f.log.indexOf("metric:prepare"),
  );
  expect(f.log.indexOf("metric:arm")).toBeLessThan(f.log.indexOf("start"));
  expect(f.position).toHaveBeenCalledOnce();
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.appendPass).toHaveBeenCalledOnce();
  expect(f.releaseReservation).toHaveBeenCalledOnce();
  expect(f.peer.service.inspectListeners()[0].phase).toBe("idle");
  for (const mutate of [
    (i) => {
      i.pass.actualRange.startBeat = 0;
    },
    (i) => {
      i.received[0].result.listenerVersion = 4;
    },
    (i) => {
      i.arrangement.positioning[0].beforeNativePrepare = false;
    },
    (i) => {
      i.arrangement.positioning[0].reply.currentBeat = 0;
    },
    (i) => {
      i.arrangement.positioning.push(i.arrangement.positioning[0]);
    },
    (i) => {
      i.resumed.observation.source.transport.endBeat = 2;
    },
    (i) => {
      i.final.immutable = false;
    },
    (i) => {
      i.entries[0].trace.causationId = "foreign";
    },
  ]) {
    const invalid = globalThis.structuredClone(input);
    mutate(invalid);
    expect(() =>
      verifyNativeMetricListeningEvidence(invalid, protocol),
    ).toThrow();
  }
});

it.each(["position-denied", "position-wrong", "wrong-version"])(
  "fails %s before native controls, launch or publication without retry",
  async (failure) => {
    const f = await runtimeFixture(failure);
    const passId = await f.execute();
    expect((await f.host.waitForListeningPass(passId, f.context)).stage).toBe(
      "failed",
    );
    expect(f.requestControl).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.position.mock.calls.length).toBeLessThanOrEqual(1);
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(
      (await f.repository.listEntries({ includeHistorical: true })).items,
    ).toHaveLength(0);
    await f.host.shutdown();
    expect(f.peer.subscribers.size).toBe(1);
  },
);

it("cancels a launched incomplete fractional capture without publication and releases native ownership", async () => {
  const f = await runtimeFixture("cancelled");
  const abort = new globalThis.AbortController();
  const passId = await f.execute(abort.signal);
  await vi.waitFor(() => expect(f.jobs.at(-1).stage).toBe("capturing"));
  abort.abort();
  expect((await f.host.waitForListeningPass(passId, f.context)).stage).toBe(
    "cancelled",
  );
  expect(f.log).toContain("metric:cancel");
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.appendPass).not.toHaveBeenCalled();
  expect(f.releaseReservation).toHaveBeenCalledOnce();
  expect(f.peer.service.inspectListeners()[0].phase).toBe("idle");
  expect(
    (await f.repository.listEntries({ includeHistorical: true })).items,
  ).toHaveLength(0);
});

it("rejects partial all-metric output as Arrangement qualification, never retries", async () => {
  const f = await runtimeFixture("partial");
  const passId = await f.execute();
  const job = await f.host.waitForListeningPass(passId, f.context);
  expect(job.stage).toBe("partial");
  await expect(f.verify(job)).rejects.toThrow(/completion mismatch/);
  expect(f.start).toHaveBeenCalledOnce();
});
const range = { startBeat: 0.25, endBeat: 1.25 };
const source = () => ({
  binding: { track: { kind: "regular", index: 2, expectedReference: "track" } },
  enabled: true,
  sessionOverride: false,
  clipsTruncated: false,
  clips: [
    {
      target: {
        view: "arrangement",
        track: { kind: "regular", index: 2, expectedReference: "track" },
        expectedClipReference: "audio",
        expectedClipName: "AA_SESSION_120BPM_8BEATS",
        expectedStartTime: 0,
      },
      interval: { startBeat: 0, endBeat: 8 },
      isAudioClip: true,
      isRecording: false,
      activity: "inactive",
      settings: [],
      fingerprint: { digest: "pinned-inspection" },
    },
  ],
});

it("reviews one fractional all-metric Arrangement capture without Session duration or added privileges", async () => {
  const manifest = await load();
  expect(manifest.prompt).toBe(metricArrangementSmokePrompt);
  expect(reviewNativeScenario(manifest)).toMatchObject({
    nativeVersion: 5,
    mode: "arrangement",
    session: false,
    expectedSpectrum: true,
    capture: { ...range, maximumDurationMs: 30000 },
  });
  for (const change of [
    { nativeVersion: 4 },
    { mode: "session" },
    { maxToolCalls: 9 },
    { maxMutations: 2 },
    { timeoutMs: 90001 },
    { capture: { ...manifest.capture, durationBeats: 1 } },
    { capture: { ...manifest.capture, startBeat: 0 } },
    {
      allowedActions: {
        ...manifest.allowedActions,
        ableton_listening: ["play-session-and-listen"],
      },
    },
    { requestedMetrics: ["level", "attacks"] },
    { prompt: `${manifest.prompt} Retry.` },
    {
      setupContract: {
        ...manifest.setupContract,
        timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 128 },
      },
    },
  ])
    expect(() => reviewNativeScenario({ ...manifest, ...change })).toThrow(
      /Unreviewed/,
    );
  await expect(
    admitNativeScenarios({
      manifests: [manifest],
      skipInstall: true,
      computerUse: false,
      approveAll: false,
      inputV4: "no-version-fallback.json",
    }),
  ).rejects.toThrow("Explicit native-v5 fixture input required");
});

it("freezes only the exact existing audio Arrangement source covering the fractional interval", () => {
  const target = source();
  expect(verifyNativeMetricArrangementFixture(target, range).interval).toEqual({
    startBeat: 0,
    endBeat: 8,
  });
  for (const mutate of [
    (t) => {
      t.clips = [];
    },
    (t) => {
      t.sessionOverride = true;
    },
    (t) => {
      t.clipsTruncated = true;
    },
    (t) => {
      t.clips[0].isAudioClip = false;
    },
    (t) => {
      t.clips[0].isRecording = true;
    },
    (t) => {
      t.clips[0].target.track.expectedReference = "foreign";
    },
    (t) => {
      t.clips[0].interval.endBeat = 1;
    },
    (t) => {
      t.clips[0].target.expectedClipName = "other";
    },
    (t) => {
      t.clips.push(globalThis.structuredClone(t.clips[0]));
    },
  ]) {
    const changed = globalThis.structuredClone(target);
    mutate(changed);
    expect(() => verifyNativeMetricArrangementFixture(changed, range)).toThrow(
      /Arrangement fixture/,
    );
  }
});

it("permits exactly inspect, Arrangement playback, one get-pass and one completed historical context read", async () => {
  const manifest = await load();
  const binding = {
    listenerId: "listener",
    passIds: new Set(["pass"]),
    contextIds: new Set(["context"]),
    completedContextIds: new Set(["context"]),
  };
  const approval = createMetricArrangementApproval(
    manifest,
    binding,
    createNativeScenarioApproval,
  );
  const calls = [
    ["ableton_listening", "read", { action: "inspect-listeners" }],
    [
      "ableton_listening",
      "reversible",
      {
        action: "play-arrangement-and-listen",
        listenerIds: ["listener"],
        ...range,
        maximumDurationMs: 30000,
      },
    ],
    ["ableton_listening", "read", { action: "get-pass", passId: "pass" }],
    [
      "ableton_context",
      "read",
      { action: "get", contextId: "context", includeHistorical: true },
    ],
  ];
  for (const [toolName, risk, args] of calls)
    expect(await approval.request({ toolName, risk, arguments: args })).toBe(
      true,
    );
  expect(approval.mutationCount).toBe(1);
  expect(
    await approval.request({
      toolName: "ableton_listening",
      risk: "read",
      arguments: { action: "get-pass", passId: "pass" },
    }),
  ).toBe(false);
});

it.each([
  "wrong-listener",
  "duration",
  "seek",
  "early-context",
  "get-before-play",
])(
  "denies %s without correcting or retrying an Arrangement request",
  async (failure) => {
    const manifest = await load();
    const binding = {
      listenerId: "listener",
      passIds: new Set(["pass"]),
      contextIds: new Set(["context"]),
      completedContextIds: new Set(),
    };
    const approval = createMetricArrangementApproval(
      manifest,
      binding,
      createNativeScenarioApproval,
    );
    await approval.request({
      toolName: "ableton_listening",
      risk: "read",
      arguments: { action: "inspect-listeners" },
    });
    const playback = {
      action: "play-arrangement-and-listen",
      listenerIds: ["listener"],
      ...range,
      maximumDurationMs: 30000,
    };
    const args =
      failure === "wrong-listener"
        ? { ...playback, listenerIds: ["other"] }
        : failure === "duration"
          ? { ...playback, durationBeats: 1 }
          : failure === "early-context"
            ? { action: "get", contextId: "context", includeHistorical: true }
            : {
                action: failure === "seek" ? "seek" : "get-pass",
                passId: "pass",
              };
    expect(
      await approval.request({
        toolName:
          failure === "early-context" ? "ableton_context" : "ableton_listening",
        risk: ["duration", "wrong-listener"].includes(failure)
          ? "reversible"
          : "read",
        arguments: args,
      }),
    ).toBe(false);
    expect(
      await approval.request({
        toolName: "ableton_listening",
        risk: "reversible",
        arguments: playback,
      }),
    ).toBe(false);
    expect(approval.mutationCount).toBe(0);
  },
);
