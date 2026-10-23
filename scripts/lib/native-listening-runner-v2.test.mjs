import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as application from "@ableton-agent/application";
import * as runtime from "@ableton-agent/runtime";
import * as observability from "@ableton-agent/observability";
import * as storage from "@ableton-agent/storage";
import * as protocol from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixtureV2 } from "@ableton-agent/protocol/testing";
import { JsonSessionStore } from "../../apps/desktop/src/main/desktop-service.ts";
import { createDesktopSessionContextManager } from "../../apps/desktop/src/main/desktop-session-context.ts";
import { sessionSchema } from "../../apps/desktop/src/contracts.ts";
import { publishSignalSecrets } from "../../apps/desktop/src/main/signal-credentials.ts";
import { nativeFixtureInput } from "./native-listening-fixture.test.mjs";
import {
  admitNativeScenarios,
  createNativeListeningRunner,
  nativeDescriptivePrompt,
  reviewNativeScenario,
  runNativeScenarioGroup,
} from "./native-listening-runner.mjs";
import { createNativeScenarioApproval } from "./native-listening-verification.mjs";

const load = async (id) =>
  JSON.parse(await readFile(`integration/live-scenarios/${id}.json`, "utf8"));
const startupCaptures = [
  [
    "native-descriptive-startup-0-4",
    { startBeat: 0, endBeat: 4, maximumDurationMs: 8000 },
  ],
  [
    "native-descriptive-startup-4-12",
    { startBeat: 4, endBeat: 12, maximumDurationMs: 8000 },
  ],
];
const ids = [
  "native-descriptive-fractional",
  "native-descriptive-30-seconds",
  ...startupCaptures.map(([id]) => id),
];

describe("reviewed v2 contracts and pre-setup admission", () => {
  it("includes both startup regressions without replacing the existing descriptive scenarios", async () => {
    const suite = JSON.parse(
      await readFile("integration/live-scenarios/suite.json", "utf8"),
    );
    expect(
      suite.groups.find(({ id }) => id === "native-listening-descriptive")
        .scenarios,
    ).toEqual([ids[0], ...startupCaptures.map(([id]) => id), ids[1]]);
  });
  it.each(startupCaptures)(
    "freezes the exact one-capture startup contract for %s",
    async (id, capture) => {
      const manifest = await load(id);
      const reviewed = reviewNativeScenario(manifest);
      expect(reviewed).toEqual({
        nativeVersion: 2,
        timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
        capture,
      });
      expect(Object.isFrozen(reviewed)).toBe(true);
      expect(Object.isFrozen(reviewed.capture)).toBe(true);
      expect(Object.isFrozen(reviewed.timingPolicy)).toBe(true);
      expect(manifest.prompt).toBe(nativeDescriptivePrompt(capture));
      expect(manifest.maxToolCalls).toBe(8);
      expect(manifest.maxMutations).toBe(1);
      expect(manifest.timeoutMs).toBe(60000);
      expect(manifest.assertions).toEqual([
        "no-failed-actor-tools",
        "stopped-native-v2-preflight",
        "app-owned-frozen-expectation-before-capture",
        "owned-terminal-job",
        `independent-native-v2-proof-and-${(capture.endBeat - capture.startBeat) * 5}-window-coverage`,
        "one-atomic-track-range-context",
        "typed-historical-retrieval-and-reopen",
        "unchanged-set-leave-running-idle-capture",
      ]);
    },
  );
  it("keeps natural packaged Default qualification distinct from scripted runtime evidence", async () => {
    const manifest = await load(ids[0]);
    const qualification = manifest.desktopQualification;
    expect(qualification).toMatchObject({
      execution: "attended-packaged-desktop",
      agent: "default",
      approvals: "ordinary",
      requiredConsecutiveRuns: 3,
    });
    expect(qualification.prompt).toContain(
      "zero-based beat 0.25 through beat 3.75",
    );
    expect(qualification.prompt).toContain("exactly one capture");
    expect(qualification.prompt).toContain(
      "invalid arguments or permission denial",
    );
    expect(qualification.prompt).not.toMatch(
      /ableton_listening|inspect-listeners|play-arrangement-and-listen|get-pass/,
    );
    expect(qualification.assertions).toContain(
      "same-profile-full-app-restart-renderer-retrieval-without-recapture",
    );
    expect(manifest.maxToolCalls).toBe(8);
    expect(manifest.maxMutations).toBe(1);
    expect(() => reviewNativeScenario(manifest)).not.toThrow();
  });
  it.each(ids)("admits only explicit pinned v2 input for %s", async (id) => {
    const f = await nativeFixtureInput({ nativeVersion: 2 });
    const path = join(f.root, "input.json");
    await writeFile(path, JSON.stringify(f.input));
    await expect(
      admitNativeScenarios({
        manifests: [await load(id)],
        skipInstall: true,
        inputV2: path,
      }),
    ).resolves.toBeUndefined();
    await expect(
      admitNativeScenarios({
        manifests: [await load(id)],
        skipInstall: true,
        inputV1: path,
      }),
    ).rejects.toThrow("fixture input required");
    await writeFile(path, JSON.stringify({ ...f.input, nativeVersion: 1 }));
    await expect(
      admitNativeScenarios({
        manifests: [await load(id)],
        skipInstall: true,
        inputV2: path,
      }),
    ).rejects.toThrow("version");
  });
  it("requires both independent inputs for full native selection and never substitutes v2 for v1", async () => {
    const f = await nativeFixtureInput();
    const v1 = join(f.root, "v1.json");
    const v2 = join(f.root, "v2.json");
    await writeFile(v1, JSON.stringify(f.input));
    await writeFile(v2, JSON.stringify({ ...f.input, nativeVersion: 2 }));
    const manifests = [
      await load("native-playback-and-listen"),
      await load(ids[0]),
    ];
    await expect(
      admitNativeScenarios({
        manifests,
        skipInstall: true,
        inputV1: v1,
        inputV2: v2,
      }),
    ).resolves.toBeUndefined();
    await expect(
      admitNativeScenarios({
        manifests,
        skipInstall: true,
        inputV1: v2,
        inputV2: v2,
      }),
    ).rejects.toThrow("version");
    for (const flags of [
      { skipInstall: false },
      { computerUse: true },
      { approveAll: true },
    ])
      await expect(
        admitNativeScenarios({
          manifests,
          skipInstall: true,
          inputV1: v1,
          inputV2: v2,
          ...flags,
        }),
      ).rejects.toThrow("unsafe flags");
  });
  it("does not interpret null input versions as legacy compatibility before setup", async () => {
    const f = await nativeFixtureInput();
    const path = join(f.root, "null-version.json");
    await writeFile(path, JSON.stringify({ ...f.input, nativeVersion: null }));
    await expect(
      admitNativeScenarios({
        manifests: [await load("native-playback-and-listen")],
        skipInstall: true,
        inputV1: path,
      }),
    ).rejects.toThrow("version");
  });
  it.each(ids)(
    "snapshots the reviewed %s approval range instead of retaining a mutable manifest reference",
    async (id) => {
      const manifest = await load(id);
      reviewNativeScenario(manifest);
      const original = { ...manifest.capture };
      const approval = createNativeScenarioApproval(manifest, {
        listenerId: "owned",
        passIds: new Set(),
        contextIds: new Set(),
      });
      manifest.capture.endBeat = 500;
      await approval.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      });
      const request = (capture) => ({
        toolName: "ableton_listening",
        risk: "reversible",
        arguments: {
          action: "play-arrangement-and-listen",
          ...capture,
          listenerIds: ["owned"],
        },
      });
      expect(await approval.request(request(manifest.capture))).toBe(false);
      expect(await approval.request(request(original))).toBe(true);
    },
  );
  describe.each(ids)("%s tampering", (id) => {
    it.each([
      [
        "id",
        (m) => {
          m.id = "arbitrary";
        },
      ],
      [
        "start range",
        (m) => {
          m.capture.startBeat += 0.25;
        },
      ],
      [
        "range",
        (m) => {
          m.capture.endBeat++;
        },
      ],
      [
        "duration",
        (m) => {
          m.capture.maximumDurationMs++;
        },
      ],
      [
        "version",
        (m) => {
          m.nativeVersion = 1;
        },
      ],
      [
        "setup version",
        (m) => {
          m.setupContract.nativeVersion = 1;
        },
      ],
      [
        "input routing",
        (m) => {
          m.setupContract.inputOption = "--native-fixture-input";
        },
      ],
      [
        "policy",
        (m) => {
          m.setupContract.timingPolicy.maxClockDisagreementSamples = 65;
        },
      ],
      [
        "strict mode",
        (m) => {
          m.setupContract.timingPolicy.mode = "strict";
        },
      ],
      [
        "budget",
        (m) => {
          m.maxMutations = 2;
        },
      ],
      [
        "tool budget",
        (m) => {
          m.maxToolCalls++;
        },
      ],
      [
        "timeout",
        (m) => {
          m.timeoutMs++;
        },
      ],
      [
        "extra tool",
        (m) => {
          m.allowedTools.push("ableton_transport");
        },
      ],
      [
        "extra action",
        (m) => {
          m.allowedActions.ableton_listening.push("list-passes");
        },
      ],
      [
        "risk",
        (m) => {
          m.allowedRisks.push("destructive");
        },
      ],
      [
        "ordering",
        (m) => {
          m.ordering = [];
        },
      ],
      [
        "failed tools permitted",
        (m) => {
          m.assertions = m.assertions.filter(
            (item) => item !== "no-failed-actor-tools",
          );
        },
      ],
      [
        "prompt",
        (m) => {
          m.prompt += " Retry if denied.";
        },
      ],
      [
        "automation",
        (m) => {
          m.setupContract.tempoAutomationSupported = true;
        },
      ],
    ])("denies tampered %s before staging", async (_label, mutate) => {
      const m = await load(id);
      mutate(m);
      expect(() => reviewNativeScenario(m)).toThrow("Unreviewed");
    });
  });
  it.each(ids)(
    "allows one exact %s playback, no positioning repair or retries",
    async (id) => {
      const manifest = await load(id);
      const a = createNativeScenarioApproval(manifest, {
        listenerId: "owned",
        passIds: new Set(),
        contextIds: new Set(),
      });
      await a.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      });
      const play = {
        toolName: "ableton_listening",
        risk: "reversible",
        arguments: {
          action: "play-arrangement-and-listen",
          ...manifest.capture,
          listenerIds: ["owned"],
        },
      };
      expect(
        await a.request({
          ...play,
          arguments: {
            ...play.arguments,
            startBeat: manifest.capture.startBeat === 0 ? 0.25 : 0,
          },
        }),
      ).toBe(false);
      for (const changed of [
        { endBeat: manifest.capture.endBeat + 0.25 },
        { maximumDurationMs: manifest.capture.maximumDurationMs + 1 },
        { listenerIds: ["unowned"] },
      ]) {
        expect(
          await a.request({
            ...play,
            arguments: { ...play.arguments, ...changed },
          }),
        ).toBe(false);
        expect(a.decisions.at(-1).reason).toBe("exact-listener-range-budget");
      }
      expect(await a.request(play)).toBe(true);
      expect(await a.request(play)).toBe(false);
      expect(
        await a.request({
          toolName: "ableton_transport",
          risk: "reversible",
          arguments: { action: "seek", time: 0.25 },
        }),
      ).toBe(false);
      expect(
        await a.request({
          toolName: "ableton_listening",
          risk: "read",
          arguments: { action: "inspect-listeners" },
        }),
      ).toBe(false);
      expect(a.decisions.at(-1).reason).toBe("tool-call-budget");
    },
  );
});

describe("sequential fresh native process orchestration (mock process controller only)", () => {
  async function group({
    failed = false,
    stopFailure = false,
    cleanupFailure = false,
    launchFailure = false,
  } = {}) {
    const log = [];
    const stages = [];
    let owned;
    const manifests = await Promise.all(ids.map(load));
    const controller = {
      publicRecord: () => owned,
      assertNoPreExistingLive: vi.fn(async () => {
        expect(owned).toBeUndefined();
        log.push("empty");
      }),
      launch: vi.fn(async (_app, _timeout, { fixturePath }) => {
        expect(owned).toBeUndefined();
        if (launchFailure) throw new Error("startup failed");
        owned = { pid: controller.launch.mock.calls.length };
        log.push(`launch:${fixturePath}`);
      }),
      validateOwnership: vi.fn(async () => {
        expect(owned).toBeDefined();
      }),
      gracefulStop: vi.fn(async () => {
        log.push("quit");
        if (stopFailure) throw new Error("owned process still running");
        owned = undefined;
      }),
      discardAfterFailure: vi.fn(async () => {
        log.push("discard");
        owned = undefined;
      }),
    };
    const createRunner = vi.fn(async (_m, token) => ({
      fixture: { setPath: token },
      stage: async (name, operation) => {
        stages.push(name);
        return operation();
      },
      run: async (validate) => {
        await validate();
        return { ok: !failed };
      },
      close: vi.fn(async ({ processStopped }) => {
        log.push(`cleanup:${processStopped}`);
        if (cleanupFailure) throw new Error("fixture cleanup failed");
      }),
    }));
    const work = runNativeScenarioGroup({
      manifests,
      controller,
      applicationPath: "test-only",
      createRunner,
      onResult: async () => log.push("evidence"),
    });
    return { work, controller, createRunner, log, stages };
  }
  it("finishes orderly exact-PID shutdown and cleanup before creating the next unique fixture root", async () => {
    const f = await group();
    const result = await f.work;
    expect(result).toHaveLength(ids.length);
    expect(f.stages).toEqual(
      ids.flatMap(() => ["process-launch", "process-shutdown"]),
    );
    expect(
      result.every(
        ({ result: item }) =>
          item.processCleanup.processStopped &&
          item.processCleanup.fixtureCleaned,
      ),
    ).toBe(true);
    expect(f.createRunner.mock.calls[0][1]).not.toBe(
      f.createRunner.mock.calls[1][1],
    );
    expect(
      new Set(f.createRunner.mock.calls.map(([, runId]) => runId)).size,
    ).toBe(ids.length);
    expect(f.log.map((s) => (s.startsWith("launch:") ? "launch" : s))).toEqual(
      ids.flatMap(() => [
        "empty",
        "launch",
        "evidence",
        "quit",
        "cleanup:true",
      ]),
    );
  });
  it("stops at failure, preserves receipts and does not launch a second scenario", async () => {
    const f = await group({ failed: true });
    const result = await f.work;
    expect(result).toHaveLength(1);
    expect(f.controller.discardAfterFailure).toHaveBeenCalledOnce();
    expect(f.createRunner).toHaveBeenCalledOnce();
  });
  it.each(["stopFailure", "cleanupFailure", "launchFailure"])(
    "does not continue after %s",
    async (key) => {
      const f = await group({ [key]: true });
      await expect(f.work).rejects.toThrow();
      expect(f.createRunner).toHaveBeenCalledOnce();
      if (key === "stopFailure") expect(f.log).toContain("cleanup:false");
    },
  );
});

// These actor/capture adapters are synthetic unit scaffolding, never real acceptance.
async function runnerV2(
  id,
  {
    rate = 48000,
    vector = 64,
    failure,
    version = 2,
    connectionError,
    bridgeReadinessError,
  } = {},
) {
  const f = await nativeFixtureInput({ nativeVersion: 2 });
  const manifest = await load(id);
  const inputPath = join(f.root, "v2-input.json");
  await writeFile(inputPath, JSON.stringify(f.input));
  const runId = randomUUID();
  const events = new Set(),
    results = new Set();
  const appStop = vi.fn(),
    ingressStop = vi.fn(),
    wait = vi.fn();
  const bridgeReadiness = vi.fn(async () => {
    if (bridgeReadinessError) throw bridgeReadinessError;
    return { attempts: 1, elapsedMs: 0 };
  });
  let playing = false,
    host,
    configuration,
    actorContext,
    job,
    hostOptions;
  const listener = {
    connectionId: "connection",
    producer: {
      producerId: "native",
      instanceId: "instance",
      signalKind: "audio",
      schemaVersion: `audio-observation/v${version}`,
    },
    binding: { trackId: "track", deviceId: "device" },
    registration: {
      version,
      connectionEpoch: "epoch",
      sampleRate: rate,
      vectorSize: vector,
      deviceCanonicalPath: f.input.canonicalPath,
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus: {
        scope: protocol.NATIVE_LISTENER_SCOPE_V2,
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
      },
    },
    phase: "idle",
  };
  const target = {
    binding: {
      track: {
        kind: "regular",
        index: 0,
        expectedReference: "track",
        expectedName: f.input.trackName,
      },
      deviceIndex: 0,
      expectedDeviceReference: "device",
      expectedDeviceName: f.input.deviceName,
      expectedClassName: "MxDeviceAudioEffect",
    },
    enabled: true,
    sessionOverride: false,
    clipsTruncated: false,
    dependenciesTruncated: false,
    canonicalPath: f.input.canonicalPath,
    pathAttestation: {
      canonicalDevicePath: f.input.canonicalPath,
      canonicalTrackPath: "live_set tracks 0",
      deviceReference: "device",
    },
    clips: [],
    upstreamDevices: [],
  };
  const devices = [
    {
      index: 0,
      reference: "device",
      name: f.input.deviceName,
      className: "MxDeviceAudioEffect",
      enabled: true,
    },
  ];
  const snapshot = () => ({
    isPlaying:
      failure === "postconditions" && job?.stage === "completed"
        ? false
        : playing,
    trackCount: 1,
    tracks: [
      {
        reference: "track",
        devices: globalThis.structuredClone(devices),
        devicesTruncated: false,
      },
    ],
  });
  const p = {
    ...protocol,
    createNativeListeningGeometry: vi.fn(
      protocol.createNativeListeningGeometry,
    ),
    snapshotNativeListeningExpectationV2: vi.fn(
      protocol.snapshotNativeListeningExpectationV2,
    ),
    assertNativeCaptureObservationV2: vi.fn(
      protocol.assertNativeCaptureObservationV2,
    ),
  };
  const services = {
    ...application,
    ...runtime,
    ...observability,
    ...storage,
    JsonSessionStore,
    createDesktopSessionContextManager,
    sessionSchema,
    publishSignalSecrets,
    protocol: p,
    createListeningRuntimeHost: vi.fn((_d, options) => {
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
                  trackReference: "track",
                  deviceReference: "device",
                },
              ],
            };
          if (params.action === "play-arrangement-and-listen") {
            actorContext = context;
            const owner = await options.resolveOwner(context);
            job = {
              passId: randomUUID(),
              owner,
              stage: "queued",
              contextIds: [],
              cleanupPolicy: "leave-running",
            };
            options.onChange(job);
            expect(
              p.snapshotNativeListeningExpectationV2.mock.lastCall[0],
            ).toMatchObject({
              passId: job.passId,
              listenerId: listener.producer.producerId,
            });
            job = { ...job, stage: "arming" };
            options.onChange(job);
          }
          return { action: params.action, job };
        },
        waitForListeningPass: async () => {
          wait();
          if (["cancelled", "positioning", "capture"].includes(failure)) {
            job = {
              ...job,
              stage: failure === "cancelled" ? "cancelled" : "failed",
              error: failure,
            };
            options.onChange(job);
            return job;
          }
          const policy =
            failure === "policy-proof"
              ? { mode: "descriptive", maxClockDisagreementSamples: 65 }
              : options.resolveTimingPolicy();
          const geometry = {
            sampleRate: rate,
            vectorSize: vector,
            tempoBpm: 120,
            startBeat: manifest.capture.startBeat,
            endBeat: manifest.capture.endBeat,
          };
          const native = createSyntheticNativeListeningFixtureV2({
            passId: job.passId,
            listenerId: listener.producer.producerId,
            geometry,
            timingPolicy: policy,
          });
          const repository = await options.resolveRepository(
            job.owner,
            actorContext,
          );
          const at = new Date().toISOString();
          const subject = (kind) => ({
            id: randomUUID(),
            sessionId: job.owner.sessionId,
            liveSetId: job.owner.liveSetId,
            kind,
            trackId: "track",
            binding: {
              version: 1,
              semanticLocator: {
                name: "Fixture",
                trackId: "track",
                ...(kind === "arrangement-range"
                  ? {
                      arrangementRange: {
                        startBeat: geometry.startBeat,
                        endBeat: geometry.endBeat,
                      },
                    }
                  : {}),
              },
              sourceIdentity: "test-owned",
              playbackSettingsHash: "a".repeat(64),
              upstreamProcessingHash: "b".repeat(64),
              routingHash: "c".repeat(64),
              dependencyScope: "unknown",
              previousRuntimeBindings: [],
            },
          });
          const publication = application.buildListeningPublication({
            passId: job.passId,
            owner: job.owner,
            trace: actorContext.trace,
            requestedMode: "arrangement",
            actualMode: "arrangement",
            requestedRange: {
              startBeat: geometry.startBeat,
              endBeat: geometry.endBeat,
            },
            createdAt: at,
            startedAt: at,
            endedAt: at,
            observations: [native.observation],
            bindings: [
              {
                listenerId: listener.producer.producerId,
                deviceReference: "device",
                connectionEpoch: listener.registration.connectionEpoch,
                version: "2.0.0",
                primary: subject("arrangement-range"),
                contributors: [subject("track")],
                attribution: "unknown",
              },
            ],
          });
          await repository.appendPass(publication, {
            trace: actorContext.trace,
            activeAgentId: job.owner.agentId,
          });
          for (const result of results)
            result({
              connectionId: listener.connectionId,
              producer: listener.producer,
              binding: listener.binding,
              result: {
                listenerVersion: 2,
                status: "completed",
                passId: job.passId,
                connectionEpoch: listener.registration.connectionEpoch,
                ...actorContext.trace,
                observation: native.observation,
                nativeCapture: native.proof,
              },
            });
          job = {
            ...job,
            stage: "completed",
            contextIds: [publication.entries[0].id],
          };
          options.onChange(job);
          playing = true;
          return job;
        },
        shutdown: async () => {},
      };
    }),
    createAgentRuntime: vi.fn((options) => {
      host = options.listening({});
      return {
        ableton: {
          inspectSession: async () => snapshot(),
          setPlaying: async (value) => {
            playing = value;
          },
          searchBrowser: async () => ({
            items: [
              {
                name: "Delay",
                root: "audio_effects",
                reference: "delay-item",
                path: [],
                uri: "query:delay",
                isBuiltInDevice: true,
                isDevice: true,
                isLoadable: true,
              },
            ],
          }),
          loadBrowserItem: async () => {
            if (failure === "insert") throw new Error("insert denied");
            const delay = {
              index: devices.length,
              reference: "delay",
              name: "Delay",
              className: "Delay",
              enabled: true,
            };
            devices.push(delay);
            return {
              verified: true,
              addedDevicesTruncated: false,
              reconfiguredDevicesTruncated: false,
              reconfiguredDevices: [],
              addedDevices: [delay],
            };
          },
          moveDevice: async (params) => {
            expect(params).toMatchObject({
              source: { device: { expectedReference: "delay", index: 1 } },
              destination: { deviceIndex: 0 },
            });
            devices.pop();
            devices[0].index = 1;
            devices.unshift({
              index: 0,
              reference: "delay",
              name: "Delay",
              className: "Delay",
              enabled: true,
            });
            target.binding.deviceIndex = 1;
            if (failure === "replacement")
              target.binding.expectedDeviceReference = "replacement";
            target.canonicalPath = "live_set tracks 0 devices 1";
            target.pathAttestation.canonicalDevicePath = target.canonicalPath;
            target.upstreamDevices = devices.map(({ reference }) => ({
              reference,
            }));
            listener.connectionId = "renewed-connection";
            listener.producer.instanceId = "renewed-instance";
            listener.producer.producerId = "renewed-producer";
            listener.registration.connectionEpoch = "renewed-epoch";
            listener.registration.deviceCanonicalPath = target.canonicalPath;
            return {
              verified: true,
              deviceReference: "delay",
              after: { kind: "track-device", device: { index: 0 } },
            };
          },
          inspectListeningContext: vi.fn(async () => ({
            listeners: [globalThis.structuredClone(target)],
            transport: {
              playing,
              currentBeat: playing ? manifest.capture.endBeat : 0,
              tempo: 120,
              safeToStart: !playing,
              recording: {
                recordMode: false,
                sessionRecord: false,
                arrangementOverdub: false,
                sessionAutomationRecord: false,
              },
            },
          })),
        },
        signals: {
          start: async () => {},
          stop: ingressStop,
          listeners: {
            inspectListeners: () => [globalThis.structuredClone(listener)],
            onListenerResult: (fn) => {
              results.add(fn);
              return () => results.delete(fn);
            },
          },
        },
        application: {
          start: async () => {},
          stop: appStop,
          getStatus: async () => {
            if (connectionError !== undefined) {
              vi.setSystemTime(Date.now() + manifest.timeoutMs + 1);
              return {
                state: "error",
                code: connectionError.code,
                message: connectionError.message,
              };
            }
            return {
              state: "connected",
              saved: true,
              liveSetId: "set",
              liveSetName: `${manifest.artifactPrefix}${runId}`,
              liveVersion: "test-only",
            };
          },
          inspectSession: async () => snapshot(),
          subscribe: (fn) => {
            events.add(fn);
            return () => events.delete(fn);
          },
          createManagedAgent: async (config) => {
            configuration = config;
            return "test-sdk";
          },
          sendToManagedAgent: async () => {
            const context = {
              sessionId: configuration.productionSessionId,
              agentId: configuration.instanceId,
              actorKind: "agent",
              trace: {
                traceId: randomUUID(),
                correlationId: "actor",
                causationId: "call",
              },
            };
            for (const params of [
              { action: "inspect-listeners" },
              {
                action: "play-arrangement-and-listen",
                ...manifest.capture,
                listenerIds: [listener.producer.producerId],
              },
            ]) {
              expect(
                await options.requestToolApproval({
                  metadata: {
                    name: "ableton_listening",
                    risk: params.action.startsWith("play")
                      ? "reversible"
                      : "read",
                  },
                  arguments: params,
                }),
              ).toBe(true);
              await host.executeListeningOperation(params, context);
              for (const fn of events) fn({ type: "operation.started" });
            }
            if (failure === "actor-tool") {
              for (const fn of events)
                fn({
                  type: "operation.failed",
                  message: "Invalid tool arguments",
                });
            }
            return "Synthetic actor finishes during arming";
          },
        },
      };
    }),
  };
  const runner = await createNativeListeningRunner({
    manifest,
    inputPath,
    directory: join(f.root, "runner"),
    environment: { ABLETON_AGENT_TOKEN: "x".repeat(40) },
    runId,
    services,
    waitForBridge: bridgeReadiness,
  });
  return {
    runner,
    services,
    p,
    listener,
    appStop,
    ingressStop,
    wait,
    bridgeReadiness,
    events,
    results,
    get hostOptions() {
      return hostOptions;
    },
  };
}

describe("v2 runner expectation forwarding and production typed context reopening (synthetic capture only)", () => {
  it("qualifies two distinct captures around an exact owned insert-before edit without rewriting the first context", async () => {
    const f = await runnerV2("native-descriptive-insert-before");
    try {
      const result = await f.runner.run(async () => {});
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.recovery).toMatchObject({
        initialDeviceIndex: 0,
        finalDeviceIndex: 1,
        listenerDeviceReference: "device",
        priorContextPreserved: true,
        first: { listenerId: "native", independentlyAcceptedNativeProof: true },
        second: {
          listenerId: "renewed-producer",
          independentlyAcceptedNativeProof: true,
        },
      });
      expect(result.jobs).toHaveLength(2);
      expect(f.wait).toHaveBeenCalledTimes(2);
      expect(
        new Set(
          f.p.snapshotNativeListeningExpectationV2.mock.calls.map(
            ([input]) => input.passId,
          ),
        ).size,
      ).toBe(2);
      expect(result.recovery.first.contextId).not.toBe(
        result.recovery.second.contextId,
      );
      expect(result.recovery.first.passId).not.toBe(
        result.recovery.second.passId,
      );
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });

  it.each(["insert", "replacement"])(
    "preserves the first pass and refuses re-capture on %s failure",
    async (failure) => {
      const f = await runnerV2("native-descriptive-insert-before", { failure });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.jobs).toHaveLength(1);
        expect(f.wait).toHaveBeenCalledOnce();
        expect(result.recovery).toBeUndefined();
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.ingressStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );

  it("waits for owned bridge readiness before starting the application", async () => {
    const f = await runnerV2(ids[0]);
    const validateOwnership = vi.fn(async () => {});
    try {
      const result = await f.runner.run(validateOwnership);
      expect(result.ok).toBe(true);
      expect(f.bridgeReadiness).toHaveBeenCalledExactlyOnceWith({
        port: 8765,
        validateOwnership,
      });
      const names = result.lifecycle.map((event) => event.name);
      const ready = names.indexOf(
        "integration.native_listening.bridge-readiness.completed",
      );
      expect(ready).toBeGreaterThan(0);
      expect(ready).toBeLessThan(
        names.indexOf("integration.native_listening.application-start.started"),
      );
      const stages = result.lifecycle.filter((event) =>
        event.name.includes("bridge-readiness."),
      );
      expect(stages.map((event) => event.stage)).toEqual([
        "queued",
        "started",
        "progress",
        "completed",
      ]);
      expect(new Set(stages.map((event) => event.trace.traceId)).size).toBe(1);
      expect(new Set(stages.map((event) => event.correlationId)).size).toBe(1);
      expect(stages.every((event) => event.durationMs >= 0)).toBe(true);
      for (let index = 1; index < stages.length; index++)
        expect(stages[index].causationId).toBe(stages[index - 1].id);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });

  it.each(["Error", "AbortError"])(
    "retains readiness %s and cleans up without actor calls",
    async (name) => {
      const failure = Object.assign(new Error("owned bridge unavailable"), {
        name,
      });
      const f = await runnerV2(ids[0], { bridgeReadinessError: failure });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain("owned bridge unavailable");
        expect(result.jobs).toEqual([]);
        expect(result.approvals).toEqual([]);
        expect(f.wait).not.toHaveBeenCalled();
        expect(
          result.lifecycle.some((event) =>
            event.name.includes("application-start."),
          ),
        ).toBe(false);
        expect(
          result.lifecycle.some((event) =>
            event.name.endsWith(
              `bridge-readiness.${name === "AbortError" ? "cancelled" : "failed"}`,
            ),
          ),
        ).toBe(true);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.ingressStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );

  it.each([
    {
      code: "connection_failed",
      message: "connect ECONNREFUSED 127.0.0.1:9877",
      expected: "ECONNREFUSED",
    },
    {
      code: "authentication_failed",
      message: `Unauthorized bearer ghp_${"a".repeat(40)} ${"x".repeat(4000)}`,
      expected: "Unauthorized",
    },
  ])(
    "retains bounded redacted $code preflight evidence without actor playback",
    async (connectionError) => {
      const f = await runnerV2(ids[0], { connectionError });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain(connectionError.code);
        expect(result.error).toContain(connectionError.expected);
        expect(result.error).not.toContain(`ghp_${"a".repeat(40)}`);
        expect(result.error.length).toBeLessThanOrEqual(2048);
        expect(result.jobs).toEqual([]);
        expect(f.wait).not.toHaveBeenCalled();
        expect(result.approvals).toEqual([]);
        const failure = result.lifecycle.find((event) =>
          event.name.endsWith("native-preflight.failed"),
        );
        expect(failure.attributes.message).toContain(connectionError.expected);
        expect(JSON.stringify(failure)).not.toContain(`ghp_${"a".repeat(40)}`);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.ingressStop).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        await f.runner.close({ processStopped: true });
      }
    },
  );

  it.each(ids)(
    "does not accept a corrected actor tool failure as a clean %s workflow",
    async (id) => {
      const f = await runnerV2(id, { failure: "actor-tool" });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain("tool failed");
        expect(f.wait).not.toHaveBeenCalled();
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.ingressStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );

  it.each([
    [ids[0], 44100, 128, 18],
    [ids[0], 48000, 64, 18],
    [ids[1], 44100, 64, 300],
    [ids[1], 48000, 128, 300],
    [ids[2], 44100, 128, 20],
    [ids[2], 48000, 64, 20],
    [ids[3], 44100, 64, 40],
    [ids[3], 48000, 128, 40],
  ])(
    "%s derives independent geometry at %s/vector%s before capture and verifies %s windows",
    async (id, rate, vector, windows) => {
      const { capture } = await load(id);
      const f = await runnerV2(id, { rate, vector });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.postconditions.passed).toBe(true);
        expect(result.postconditions.failedChecks).toEqual([]);
        expect(result.fixture.nativeVersion).toBe(2);
        expect(result.evidence.envelopeWindows).toBe(windows);
        const expected =
          f.p.snapshotNativeListeningExpectationV2.mock.results[0].value;
        expect(Object.isFrozen(expected)).toBe(true);
        expect(Object.isFrozen(expected.policy)).toBe(true);
        expect(Object.isFrozen(expected.geometry)).toBe(true);
        expect(expected).toMatchObject({
          listenerId: "native",
          passId: result.evidence.passId,
          policy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
          geometry: {
            sampleRate: rate,
            vectorSize: vector,
            tempoBpm: 120,
            startBeat: capture.startBeat,
            endBeat: capture.endBeat,
          },
        });
        expect(f.p.assertNativeCaptureObservationV2.mock.calls[0][2]).toEqual(
          expected,
        );
        expect(f.hostOptions.resolveTimingPolicy()).toEqual(expected.policy);
        expect(Object.isFrozen(f.hostOptions.resolveTimingPolicy())).toBe(true);
        expect(f.wait).toHaveBeenCalledOnce();
        expect(
          result.lifecycle.some((event) =>
            event.name.endsWith("typed-context-reopen.completed"),
          ),
        ).toBe(true);
      } finally {
        await f.runner.close({ processStopped: true });
      }
      expect(f.appStop).toHaveBeenCalledOnce();
      expect(f.ingressStop).toHaveBeenCalledOnce();
      expect(f.events.size).toBe(0);
      expect(f.results.size).toBe(0);
    },
  );
  it.each(
    ids.flatMap((id) =>
      ["policy-proof", "positioning", "cancelled", "capture"].map((failure) => [
        id,
        failure,
      ]),
    ),
  )(
    "%s fails %s without repair, retries or extra playback",
    async (id, failure) => {
      const f = await runnerV2(id, { failure });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.jobs).toHaveLength(1);
        expect(f.wait).toHaveBeenCalledOnce();
        expect(
          result.approvals.filter(
            (a) => a.arguments.action === "play-arrangement-and-listen",
          ),
        ).toHaveLength(1);
        if (failure !== "policy-proof")
          expect(result.jobs[0].contextIds).toEqual([]);
        else expect(result.error).toContain("policy_or_geometry_mismatch");
      } finally {
        await f.runner.close({ processStopped: true });
      }
      expect(f.appStop).toHaveBeenCalledOnce();
      expect(f.ingressStop).toHaveBeenCalledOnce();
    },
  );
  it("denies a legacy registration in an explicit v2 fixture before actor playback", async () => {
    const f = await runnerV2(ids[0], { version: 1 });
    try {
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("scope/sample rate/idle");
      expect(f.wait).not.toHaveBeenCalled();
      expect(result.jobs).toEqual([]);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
  it("keeps synthetic native completion/context separate from a failed final snapshot and retains exact diagnostic lifecycle through cleanup", async () => {
    const f = await runnerV2(ids[1], { failure: "postconditions" });
    try {
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        "Leave-running capture cleanup, immutable binding or recording state mismatch: snapshotPlaying",
      );
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].stage).toBe("completed");
      expect(result.jobs[0].contextIds).toHaveLength(1);
      expect(result.postconditions.failedChecks).toEqual(["snapshotPlaying"]);
      expect(result.postconditions.before.snapshotPlaying).toEqual({
        type: "boolean",
        value: false,
      });
      expect(result.postconditions.after.snapshotPlaying).toEqual({
        type: "boolean",
        value: false,
      });
      const events = result.lifecycle.filter((e) =>
        e.name.startsWith(
          "integration.native_listening.leave-running-postconditions.",
        ),
      );
      expect(events.map((e) => e.stage)).toEqual([
        "queued",
        "started",
        "progress",
        "failed",
      ]);
      expect(events.at(-1).attributes.postconditions.failedChecks).toEqual([
        "snapshotPlaying",
      ]);
      expect(events.at(-1).correlationId).toBe(
        result.lifecycle[0].correlationId,
      );
      expect(events.at(-1).trace.traceId).toBe(
        result.lifecycle[0].trace.traceId,
      );
      expect(
        result.lifecycle.some((e) =>
          e.name.endsWith("independent-verification.started"),
        ),
      ).toBe(false);
    } finally {
      await f.runner.close({ processStopped: true });
    }
    expect(f.appStop).toHaveBeenCalledOnce();
    expect(f.ingressStop).toHaveBeenCalledOnce();
    expect(f.events.size).toBe(0);
    expect(f.results.size).toBe(0);
  });
});
