import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as application from "@ableton-agent/application";
import * as runtime from "@ableton-agent/runtime";
import * as observability from "@ableton-agent/observability";
import * as storage from "@ableton-agent/storage";
import * as shared from "@ableton-agent/shared";
import * as protocol from "@ableton-agent/protocol";
import { JsonSessionStore } from "../../apps/desktop/src/main/desktop-service.ts";
import { createDesktopSessionContextManager } from "../../apps/desktop/src/main/desktop-session-context.ts";
import { sessionSchema } from "../../apps/desktop/src/contracts.ts";
import { publishSignalSecrets } from "../../apps/desktop/src/main/signal-credentials.ts";
import { nativeFixtureInput } from "./native-listening-fixture.test.mjs";
import { sessionEvidence } from "./native-listening-verification.test.mjs";
import { createNativeListeningRunner } from "./native-listening-runner.mjs";

// Synthetic actor/capture/source receipts; production publication, storage and reopen.
async function fixture({
  kind = "midi",
  rate = 44100,
  failure,
  followUnknown = false,
  operatorParameters = 0,
} = {}) {
  const f = await nativeFixtureInput({ nativeVersion: 3 });
  const e = sessionEvidence({ rate, kind, followUnknown });
  const selectedIndex = kind === "midi" ? 0 : 1;
  e.session.target.track.index = selectedIndex;
  e.session.target.track.expectedName =
    kind === "midi" ? "Fixture MIDI" : "Fixture Audio";
  e.entries[0].payload.source.target = globalThis.structuredClone(
    e.session.target,
  );
  f.input.sessionSources = Object.fromEntries(
    ["midi", "warped-audio"].map((sourceKind, index) => [
      sourceKind,
      {
        canonicalPath: `live_set tracks ${index} devices ${operatorParameters && index === 0 ? 1 : 0}`,
        trackName: index === 0 ? "Fixture MIDI" : "Fixture Audio",
        deviceName: "Candidate",
        sceneIndex: 0,
      },
    ]),
  );
  e.target.binding.expectedDeviceName = "Candidate";
  if (operatorParameters && selectedIndex === 0)
    e.target.binding.deviceIndex = 1;
  const manifest = JSON.parse(
    await readFile(
      `integration/live-scenarios/native-session-${kind === "midi" ? "midi" : "warped-audio"}.json`,
      "utf8",
    ),
  );
  const inputPath = join(f.root, "session-input.json");
  await writeFile(inputPath, JSON.stringify(f.input));
  const runId = randomUUID();
  const log = [],
    events = new Set(),
    results = new Set();
  let playing = false,
    host,
    job,
    actorContext,
    hostOptions,
    runtimeOptions,
    publications = 0;
  const trackRefs = [randomUUID(), randomUUID()];
  trackRefs[selectedIndex] = e.session.target.track.expectedReference;
  const clipRefs = [randomUUID(), randomUUID()];
  clipRefs[selectedIndex] = e.session.target.expectedClipReference;
  const deviceRefs = [randomUUID(), randomUUID()];
  deviceRefs[selectedIndex] = e.target.binding.expectedDeviceReference;
  const parameterRefs = [randomUUID(), randomUUID()];
  const operatorReference = randomUUID();
  const operatorParameterRefs = Array.from({ length: operatorParameters }, () =>
    randomUUID(),
  );
  const inspectionQueries = [];
  const parameterReadCounts = [];
  const listeners = trackRefs.map((trackId, index) => ({
    connectionId: `connection-${index}`,
    producer: {
      producerId:
        index === selectedIndex ? e.listener.producer.producerId : "unselected",
      instanceId: `instance-${index}`,
      signalKind: "audio",
      schemaVersion: "audio-observation/v2",
    },
    binding: { trackId, deviceId: deviceRefs[index] },
    registration: {
      version: failure === "version" && index === selectedIndex ? 2 : 3,
      connectionEpoch: "epoch",
      sampleRate: rate,
      vectorSize: 128,
      deviceCanonicalPath: `live_set tracks ${index} devices ${operatorParameters && index === 0 ? 1 : 0}`,
      trackCanonicalPath: `live_set tracks ${index}`,
      nativeStatus: {
        version: 3,
        scope: protocol.NATIVE_SESSION_LISTENER_SCOPE,
        sourceEvidence: "expected-context-only",
        synchronization: "transport-coupled-first-iteration",
        maxDurationBeats: 4,
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
      },
    },
    phase: "idle",
  }));
  const listener = listeners[selectedIndex];
  const snapshot = () => ({
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    isPlaying: playing,
    trackCount: 2,
    tracks: trackRefs.map((reference, index) => ({
      reference,
      index,
      name: index === 0 ? "Fixture MIDI" : "Fixture Audio",
      kind: index === 0 ? "midi" : "audio",
      color: null,
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      volume: 0.85,
      pan: 0,
      devicesTruncated: failure === "truncated-devices",
      devices: [
        ...(operatorParameters && index === 0
          ? [
              {
                index: 0,
                reference: operatorReference,
                name: "Operator",
                className: "Operator",
                classDisplayName: "Operator",
                enabled: true,
                parameterCount: operatorParameters,
              },
            ]
          : []),
        {
          index: operatorParameters && index === 0 ? 1 : 0,
          reference: deviceRefs[index],
          name: "Candidate",
          className: "MxDeviceAudioEffect",
          classDisplayName: "Max Audio Effect",
          enabled: true,
          parameterCount: 1,
        },
      ],
    })),
    clips: clipRefs.map((reference, index) => ({
      reference,
      trackReference: trackRefs[index],
      trackIndex: index,
      sceneIndex: 0,
      name:
        index === selectedIndex
          ? e.session.target.expectedClipName
          : `Unselected ${index}`,
      kind: index === 0 ? "midi" : "audio",
      length: 8,
      noteCount: index === 0 ? 1 : null,
      isPlaying:
        playing && (index === selectedIndex || failure === "unselected-launch"),
      isTriggered: false,
      muted: false,
      looping: true,
    })),
  });
  const target = {
    binding: e.target.binding,
    enabled: true,
    sessionOverride: false,
    clipsTruncated: failure === "preflight-clips",
    dependenciesTruncated: Boolean(operatorParameters && selectedIndex === 0),
    fingerprint: {
      completeness: "unknown",
      unknownReasons: ["upstream-parameters-truncated"],
    },
    attribution: "nonexclusive",
    unknownReasons:
      operatorParameters && selectedIndex === 0
        ? ["upstream-parameters-truncated"]
        : [],
    canonicalPath: listener.registration.deviceCanonicalPath,
    pathAttestation: {
      canonicalDevicePath: listener.registration.deviceCanonicalPath,
    },
    clips: [],
    upstreamDevices:
      operatorParameters && selectedIndex === 0
        ? [
            {
              reference: operatorReference,
              name: "Operator",
              className: "Operator",
              enabled: true,
              parameters: operatorParameterRefs
                .slice(0, 16)
                .map((reference, index) => ({
                  reference,
                  name: `Operator parameter ${index}`,
                  value: 1,
                })),
            },
          ]
        : [],
  };
  if (failure === "preflight-secret")
    target.binding.expectedDeviceName = "token=runner-private-value";
  const state = (running) => ({
    ...e.session.source.after,
    ...(running
      ? { ...e.session.after.after, globalBeat: 12.25, playingPosition: 4.25 }
      : {}),
  });
  const source = (params) => {
    const selected =
      params.target.expectedClipReference ===
      e.session.target.expectedClipReference;
    return {
      ...e.session.source,
      queryId: params.queryId,
      target: params.target,
      sourceKind: params.target.track.index === 0 ? "midi" : "warped-audio",
      before: state(playing && selected),
      after: state(playing && selected),
      settings: {
        ...e.session.source.settings,
        ...(failure === "loop-end" ? { endMarker: 4 } : {}),
        ...(failure === "follow-enabled" ? { followActionEnabled: true } : {}),
      },
    };
  };
  const mutations = [];
  const ableton = {
    inspectListeningContext: async (params) => {
      inspectionQueries.push(globalThis.structuredClone(params));
      return {
        bindingQueryId: params.bindingQueryId,
        listeners: [globalThis.structuredClone(target)],
        transport: {
          playing,
          currentBeat: playing ? 12.25 : 8,
          tempo: 120,
          safeToStart:
            !playing &&
            !["preflight-recording", "preflight-clips"].includes(failure),
          recording: {
            recordMode: failure === "preflight-recording",
            sessionRecord: false,
            arrangementOverdub: false,
            sessionAutomationRecord: false,
          },
        },
      };
    },
    inspectSessionListeningSource: vi.fn(async (params) => source(params)),
    inspectDeviceParameters: async (params) => {
      const track = snapshot().tracks[params.index],
        device = track.devices.find(
          (device) => device.index === params.deviceIndex,
        );
      parameterReadCounts.push(device.parameterCount);
      return {
        device: {
          ...device,
          trackReference: track.reference,
          trackIndex: track.index,
        },
        total: device.parameterCount,
        offset: 0,
        limit: 256,
        parameters: Array.from(
          { length: device.parameterCount },
          (_, index) => ({
            reference:
              device.reference === operatorReference
                ? operatorParameterRefs[index]
                : parameterRefs[track.index],
            deviceReference: device.reference,
            index,
            name:
              device.reference === operatorReference
                ? `Operator parameter ${index}`
                : "Device On",
            value:
              playing &&
              ((failure === "parameter-edit" &&
                track.index !== selectedIndex) ||
                (failure === "operator-hidden-parameter-edit" &&
                  device.reference === operatorReference &&
                  index === 194))
                ? 0
                : 1,
            normalizedValue: 1,
            min: 0,
            max: 1,
            isQuantized: true,
            isEnabled: true,
            valueItemCount: 2,
          }),
        ),
      };
    },
    inspectMidiNotes: async (params) => ({
      clip: snapshot().clips.find(
        (clip) => clip.reference === params.expectedClipReference,
      ),
      totalNotes: 1,
      offset: 0,
      limit: 2048,
      truncated: failure === "truncated-midi",
      notes: [
        {
          pitch: playing && failure === "midi-edit" ? 61 : 60,
          startTime: 0,
          duration: 1,
          velocity: 100,
          mute: false,
        },
      ],
    }),
    executeAudioClipsOperation: async (params) =>
      params.action === "warp-markers"
        ? {
            action: "warp-markers",
            total: failure === "truncated-warp" ? 3 : 2,
            offset: 0,
            limit: 256,
            markers: [
              { index: 0, beatTime: 0, sampleTime: 0 },
              {
                index: 1,
                beatTime: 8,
                sampleTime: playing && failure === "warp-edit" ? 3 : 4,
              },
            ],
          }
        : {
            action: "inspect",
            clip: {
              reference: params.target.expectedClipReference,
              name: params.target.expectedClipName,
              length: 8,
              gain: playing && failure === "audio-edit" ? 0.5 : 1,
              pitchCoarse: 0,
              pitchFine: 0,
              warping: true,
              warpMode: 0,
              availableWarpModes: [0],
              startMarker: 0,
              endMarker: 8,
              loopStart: 0,
              loopEnd: 8,
              looping: true,
              ramMode: false,
              filePath: "/synthetic-only/tone.wav",
              sampleLength: rate * 4,
              sampleRate: rate,
            },
          },
    sessionListeningPass: vi.fn(async (params) => {
      log.push(`source:${params.action}`);
      if (params.action === "prepare" && failure === "prepare-failure")
        throw new Error("Session prepare denied token=unit-private-value");
      if (params.action === "prepare" && failure === "prepare-cancelled")
        throw new globalThis.DOMException(
          "Session prepare cancelled",
          "AbortError",
        );
      if (params.action === "launch") {
        playing = true;
        mutations.push("launch");
      }
      const original = e.session.receipts.find(
        (receipt) => receipt.params.action === params.action,
      ).result;
      return {
        ...globalThis.structuredClone(original),
        passId: job.passId,
        ownerId: params.ownerId,
        ...(params.action === "release" && params.reason === "cancelled"
          ? { status: "cancelled" }
          : {}),
        ...(failure === "source-epoch" && params.action === "inspect"
          ? { sourceEpoch: { ...original.sourceEpoch, startTimeBeats: 7 } }
          : {}),
      };
    }),
  };
  const originalSourcePass = ableton.sessionListeningPass;
  const p = {
    ...protocol,
    snapshotNativeSessionListeningExpectation: vi.fn((input) => {
      log.push("freeze");
      return protocol.snapshotNativeSessionListeningExpectation(input);
    }),
  };
  const appStop = vi.fn(),
    signalStop = vi.fn();
  const services = {
    ...application,
    ...runtime,
    ...observability,
    ...storage,
    ...shared,
    JsonSessionStore,
    createDesktopSessionContextManager,
    sessionSchema,
    publishSignalSecrets,
    protocol: p,
    createListeningRuntimeHost: (_dependencies, options) => {
      hostOptions = options;
      return {
        executeListeningOperation: async (params, context) => {
          if (params.action === "inspect-listeners")
            return {
              action: params.action,
              listeners: [
                {
                  listenerId: listener.producer.producerId,
                  ready: false,
                  limitations: ["native_per_pass_validation_required"],
                  trackReference: trackRefs[selectedIndex],
                  deviceReference: deviceRefs[selectedIndex],
                },
              ],
            };
          if (params.action === "play-session-and-listen") {
            actorContext = context;
            job = {
              passId: e.pass.id,
              owner: await options.resolveOwner(context),
              stage: "queued",
              contextIds: [],
              cleanupPolicy: "leave-running",
            };
            options.onChange(job);
            log.push("queued");
            const prepare = {
              ...e.session.receipts[0].params,
              expectedLiveSetId: job.owner.liveSetId,
              listener: target.binding,
              target: params.target,
            };
            await ableton.sessionListeningPass(prepare);
            await ableton.sessionListeningPass(e.session.receipts[1].params);
            job = { ...job, stage: "arming" };
            options.onChange(job);
          }
          return { action: params.action, job };
        },
        waitForListeningPass: async () => {
          const cancelled = failure === "cancelled";
          if (cancelled || failure === "capture") {
            await ableton.sessionListeningPass({
              ...e.session.receipts[3].params,
              reason: "cancelled",
            });
            job = {
              ...job,
              stage: cancelled ? "cancelled" : "failed",
              error: "synthetic capture termination",
            };
            hostOptions.onChange(job);
            return job;
          }
          for (const result of results)
            result({
              ...e.received[0],
              connectionId: listener.connectionId,
              producer: listener.producer,
              binding: listener.binding,
              result: { ...e.received[0].result, ...actorContext.trace },
            });
          log.push("native-completed");
          await ableton.sessionListeningPass(e.session.receipts[2].params);
          job = { ...job, stage: "persisting" };
          hostOptions.onChange(job);
          log.push("persisting");
          const repository = await options.resolveRepository(
            job.owner,
            actorContext,
          );
          const at = new Date().toISOString();
          const canonicalTrackId = "canonical-track-subject";
          const associatedTrackId =
            failure === "inconsistent-track-subject-id"
              ? trackRefs[selectedIndex]
              : canonicalTrackId;
          const subject = (primary) => ({
            id: primary ? "session-clip-subject" : canonicalTrackId,
            sessionId: job.owner.sessionId,
            liveSetId: job.owner.liveSetId,
            kind: primary ? "clip" : "track",
            location: primary ? "session" : "track",
            trackId: associatedTrackId,
            binding: {
              version: 1,
              semanticLocator: {
                name: primary
                  ? e.session.target.expectedClipName
                  : e.session.target.track.expectedName,
                trackId: associatedTrackId,
                ...(primary ? { sceneIndex: 0 } : {}),
              },
              sourceIdentity: "synthetic-message-rate-only",
              playbackSettingsHash: "a".repeat(64),
              upstreamProcessingHash: "b".repeat(64),
              routingHash: "c".repeat(64),
              dependencyScope: "unknown",
              previousRuntimeBindings: [
                primary ? clipRefs[selectedIndex] : trackRefs[selectedIndex],
              ],
            },
          });
          const publication = application.buildListeningPublication({
            passId: job.passId,
            owner: job.owner,
            trace: actorContext.trace,
            requestedMode: "session",
            actualMode: "session",
            requestedRange: { startBeat: 0, endBeat: 4 },
            createdAt: at,
            startedAt: at,
            endedAt: at,
            observations: [e.entries[0].payload],
            bindings: [
              {
                listenerId: listener.producer.producerId,
                deviceReference: deviceRefs[selectedIndex],
                connectionEpoch: "epoch",
                version: "2.0.0",
                primary: subject(true),
                contributors: [subject(false)],
                attribution: "unknown",
              },
            ],
          });
          await repository.appendPass(publication, {
            trace: actorContext.trace,
            activeAgentId: job.owner.agentId,
          });
          publications++;
          await ableton.sessionListeningPass(e.session.receipts[3].params);
          job = {
            ...job,
            stage: "completed",
            contextIds: [publication.entries[0].id],
          };
          hostOptions.onChange(job);
          return job;
        },
        shutdown: async () => {},
      };
    },
    createAgentRuntime: (options) => {
      runtimeOptions = options;
      host = options.listening({ ableton });
      return {
        ableton,
        signals: {
          start: async () => {},
          stop: signalStop,
          listeners: {
            inspectListeners: () => globalThis.structuredClone(listeners),
            onListenerResult: (fn) => {
              results.add(fn);
              return () => results.delete(fn);
            },
          },
        },
        application: {
          start: async () => {},
          stop: appStop,
          getStatus: async () => ({
            state: "connected",
            liveSetId: "set",
            liveVersion: "11.3.43",
            saved: true,
            liveSetName: `${manifest.artifactPrefix}${runId}`,
          }),
          inspectSession: async () => snapshot(),
          subscribe: (fn) => {
            events.add(fn);
            return () => events.delete(fn);
          },
          createManagedAgent: async (configuration) => {
            expect(configuration.resolvedOperations).toContain(
              "listening.play_session_and_listen",
            );
            expect(configuration.resolvedOperations).not.toContain(
              "listening.play_arrangement_and_listen",
            );
            return "synthetic-sdk-session";
          },
          sendToManagedAgent: async (_agent, prompt) => {
            expect(prompt).toContain(JSON.stringify(e.session.target));
            const context = {
              sessionId: options.currentAppSessionId(),
              agentId: _agent,
              actorKind: "agent",
              trace: {
                traceId: randomUUID(),
                correlationId: "session-runner-unit",
                causationId: randomUUID(),
              },
            };
            const invoke = async (args, risk) => {
              for (const event of events) event({ type: "operation.started" });
              const approved = await options.requestToolApproval({
                metadata: { name: "ableton_listening", risk },
                arguments: args,
              });
              if (!approved)
                throw new Error("synthetic actor permission denied; no retry");
              return host.executeListeningOperation(args, context);
            };
            await invoke({ action: "inspect-listeners" }, "read");
            await invoke(
              {
                action: "play-session-and-listen",
                target: e.session.target,
                listenerIds: [listener.producer.producerId],
                durationBeats: failure === "denial" ? 4.001 : 4,
                maximumDurationMs: 30000,
              },
              "reversible",
            );
            await invoke({ action: "get-pass", passId: job.passId }, "read");
          },
        },
      };
    },
  };
  const runner = await createNativeListeningRunner({
    manifest,
    inputPath,
    directory: join(f.root, "session-run"),
    environment: { ABLETON_AGENT_TOKEN: "u".repeat(64) },
    runId,
    services,
    waitForBridge: async () => {},
  });
  return {
    ...f,
    runner,
    e,
    log,
    mutations,
    services,
    p,
    appStop,
    signalStop,
    originalSourcePass,
    runtimeOptions: () => runtimeOptions,
    publications: () => publications,
    inspectionQueries,
    parameterReadCounts,
  };
}

describe("native Session runner composition (no Live launched, not physical qualification)", () => {
  it("admits a 195-parameter Operator with unknown nonexclusive dependencies without raising inspection budgets", async () => {
    const f = await fixture({ operatorParameters: 195 });
    try {
      const result = await f.runner.run(async () => {});
      expect(result, result.error).toMatchObject({ ok: true });
      expect(result.preflight).toMatchObject({
        passed: true,
        target: { dependenciesTruncated: true },
        quality: {
          dependencyCompleteness: "incomplete",
          fingerprintCompleteness: "unknown",
          attribution: "nonexclusive",
        },
      });
      expect(
        f.inspectionQueries.every((query) => query.maxParameters === 16),
      ).toBe(true);
      expect(
        f.parameterReadCounts.filter((count) => count === 195),
      ).toHaveLength(2);
      expect(f.mutations).toEqual(["launch"]);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
  it.each([
    ["preflight-recording", ["safeToStart", "recordModeOff"]],
    ["preflight-secret", ["deviceName"]],
    ["preflight-clips", ["safeToStart", "clipsComplete"]],
  ])(
    "retains bounded normal-result refusal evidence for %s without approval, jobs or launch",
    async (failure, guards) => {
      const f = await fixture({ failure, operatorParameters: 195 });
      try {
        const result = await f.runner.run(async () => {});
        expect(result).toMatchObject({
          ok: false,
          approvals: [],
          jobs: [],
          preflight: {
            passed: false,
            failedChecks: guards,
            limits: { maxParameters: 16, maxClips: 32 },
            quality: {
              dependencyCompleteness: "incomplete",
              fingerprintCompleteness: "unknown",
            },
          },
        });
        for (const guard of guards) expect(result.error).toContain(guard);
        expect(f.mutations).toEqual([]);
        expect(f.publications()).toBe(0);
        expect(JSON.stringify(result)).not.toContain("runner-private-value");
        const events = result.lifecycle.filter((event) =>
          event.name.startsWith(
            "integration.native_listening.stopped-preflight.",
          ),
        );
        expect(events.map((event) => event.stage)).toEqual([
          "queued",
          "started",
          "progress",
          "failed",
        ]);
        expect(
          events.every(
            (event) =>
              event.durationMs >= 0 &&
              event.trace.traceId === events[0].trace.traceId,
          ),
        ).toBe(true);
        expect(events.at(-1).attributes.preflight.failedChecks).toEqual(guards);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it("still rejects an Operator parameter edit outside the 16-field dependency fingerprint", async () => {
    const f = await fixture({
      operatorParameters: 195,
      failure: "operator-hidden-parameter-edit",
    });
    try {
      const result = await f.runner.run(async () => {});
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "Session capture changed fixture content",
        ),
        preflight: {
          passed: true,
          quality: { fingerprintCompleteness: "unknown" },
        },
      });
      expect(
        f.parameterReadCounts.filter((count) => count === 195),
      ).toHaveLength(2);
      expect(f.mutations).toEqual(["launch"]);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
  it.each([
    ["midi", 44100],
    ["warped-audio", 48000],
  ])(
    "freezes %s/%s before launch and verifies one atomic typed context after real store reopen",
    async (kind, rate) => {
      const f = await fixture({ kind, rate, followUnknown: true });
      try {
        const result = await f.runner.run(async () => {});
        expect(result, result.error).toMatchObject({
          ok: true,
          qualificationStatus: "unqualified",
          evidence: {
            observationSchema: "session-audio-observation/v1",
            sourceKind: kind,
            physicalClipIdentityProven: false,
            continuity: { followActions: "unknown" },
          },
        });
        expect(f.publications()).toBe(1);
        expect(f.mutations).toEqual(["launch"]);
        expect(f.log.indexOf("freeze")).toBeLessThan(
          f.log.indexOf("source:prepare"),
        );
        expect(f.log.indexOf("source:launch")).toBeLessThan(
          f.log.indexOf("native-completed"),
        );
        expect(f.log.indexOf("source:inspect")).toBeLessThan(
          f.log.indexOf("persisting"),
        );
        expect(f.log.filter((item) => item.startsWith("source:")).at(-1)).toBe(
          "source:release",
        );
        expect(
          f.p.snapshotNativeSessionListeningExpectation,
        ).toHaveBeenCalledTimes(2);
        expect(
          f.p.snapshotNativeSessionListeningExpectation.mock.calls[0],
        ).toEqual(f.p.snapshotNativeSessionListeningExpectation.mock.calls[1]);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
        for (const stage of [
          "session-source-baseline",
          "session-fixture-content-baseline",
          "session-source-prepare",
          "session-source-launch",
          "session-source-inspect",
          "session-source-release",
          "session-source-after",
          "session-fixture-content-after",
          "fixture-integrity",
        ]) {
          const events = result.lifecycle.filter((event) =>
            event.name.startsWith(`integration.native_listening.${stage}.`),
          );
          expect(events.map((event) => event.stage)).toEqual([
            "queued",
            "started",
            "progress",
            "completed",
          ]);
          expect(
            events.every(
              (event) =>
                event.durationMs >= 0 &&
                event.trace.traceId === events[0].trace.traceId &&
                event.correlationId === events[0].correlationId,
            ),
          ).toBe(true);
          for (let index = 1; index < events.length; index++)
            expect(events[index].causationId).toBe(events[index - 1].id);
        }
      } finally {
        await f.runner.close({ processStopped: true });
      }
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    },
  );
  it.each([
    ["version", "scope/sample rate/idle"],
    ["loop-end", "first-iteration geometry"],
    ["follow-enabled", "first-iteration geometry"],
    ["truncated-devices", "Complete bounded Session fixture"],
    ["truncated-midi", "immutable fixture MIDI content"],
    ["truncated-warp", "immutable fixture audio/warp content"],
    ["denial", "actor permission denied"],
    ["prepare-failure", "Session prepare denied"],
    ["prepare-cancelled", "Session prepare cancelled"],
  ])(
    "denies %s before any launch or publication and cleans only its staged copy",
    async (failure, message) => {
      const f = await fixture({ failure });
      try {
        const result = await f.runner.run(async () => {});
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining(message),
        });
        expect(JSON.stringify(result)).not.toContain("unit-private-value");
        if (failure.startsWith("prepare-")) {
          const events = result.lifecycle.filter((event) =>
            event.name.startsWith(
              "integration.native_listening.session-source-prepare.",
            ),
          );
          expect(events.map((event) => event.stage)).toEqual([
            "queued",
            "started",
            "progress",
            failure === "prepare-cancelled" ? "cancelled" : "failed",
          ]);
        }
        expect(f.mutations).toEqual([]);
        expect(f.publications()).toBe(0);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
      await expect(access(f.input.sourceSet)).resolves.toBeUndefined();
    },
  );
  it.each([
    "midi-edit",
    "audio-edit",
    "warp-edit",
    "parameter-edit",
    "unselected-launch",
    "source-epoch",
  ])(
    "fails independent %s evidence rather than claiming a qualified unchanged fixture",
    async (failure) => {
      const f = await fixture({ failure });
      try {
        expect(await f.runner.run(async () => {})).toMatchObject({ ok: false });
        expect(f.mutations).toEqual(["launch"]);
        expect(
          f.originalSourcePass.mock.calls.filter(
            ([params]) => params.action === "launch",
          ),
        ).toHaveLength(1);
        expect(f.originalSourcePass.mock.calls.at(-1)[0].action).toBe(
          "release",
        );
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it.each(["cancelled", "capture"])(
    "retains %s failure, releases monitoring and publishes no context without stopping playback",
    async (failure) => {
      const f = await fixture({ failure });
      try {
        expect(await f.runner.run(async () => {})).toMatchObject({ ok: false });
        expect(f.publications()).toBe(0);
        expect(f.mutations).toEqual(["launch"]);
        expect(f.originalSourcePass.mock.calls.at(-1)[0]).toMatchObject({
          action: "release",
          reason: "cancelled",
        });
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it("rejects inconsistent canonical clip/contributor associations before publication", async () => {
    const f = await fixture({ failure: "inconsistent-track-subject-id" });
    try {
      expect(await f.runner.run(async () => {})).toMatchObject({
        ok: false,
        error: expect.stringContaining("contributing track"),
      });
      expect(f.publications()).toBe(0);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
});
