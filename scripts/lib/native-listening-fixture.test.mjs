import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import * as storageServices from "@ableton-agent/storage";
import * as applicationServices from "@ableton-agent/application";
import * as runtimeServices from "@ableton-agent/runtime";
import * as observabilityServices from "@ableton-agent/observability";
import * as protocol from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixture } from "@ableton-agent/protocol/testing";
import { JsonSessionStore } from "../../apps/desktop/src/main/desktop-service.ts";
import { createDesktopSessionContextManager } from "../../apps/desktop/src/main/desktop-session-context.ts";
import { sessionSchema } from "../../apps/desktop/src/contracts.ts";
import { publishSignalSecrets } from "../../apps/desktop/src/main/signal-credentials.ts";

import {
  inspectNativeFixtureSet,
  stageNativeListeningFixture,
} from "./native-listening-fixture.mjs";
import { createNativeListeningRunner } from "./native-listening-runner.mjs";

const roots = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

export async function nativeFixtureInput() {
  const root = resolve(".test-artifacts", `native-unit-${randomUUID()}`);
  roots.push(root);
  const directory = join(root, "Native-Listener-Candidate");
  await mkdir(directory, { recursive: true });
  const device = Buffer.from(
    "test-only native candidate, never loaded in Live",
  );
  const resource = Buffer.from("test-only code");
  const manifest = JSON.stringify({
    nativeMode: true,
    nativeScope: "arrangement-beat0-120bpm-48000hz-vector64/v1",
    realLiveValidated: false,
    deviceFile: "Candidate.amxd",
    deviceSha256: hash(device),
    externalAuthoringBridge: false,
    resources: [
      { name: "engine.js", sha256: hash(resource), bytes: resource.length },
    ],
  });
  await writeFile(join(directory, "Candidate.amxd"), device);
  await writeFile(join(directory, "engine.js"), resource);
  await writeFile(join(directory, "audio-listener-manifest.json"), manifest);
  await writeFile(
    join(directory, "agent_signal_storage.js"),
    "test-only old discovery, never executed",
  );
  const source = gzipSync(
    `<Ableton MajorVersion="5"><FileRef><RelativePathType Value="3" /><RelativePath Value="Native-Listener-Candidate/Candidate.amxd" /><Path Value="${directory}/Candidate.amxd" /></FileRef></Ableton>`,
  );
  const sourceSet = join(root, "Source.als");
  await writeFile(sourceSet, source);
  const input = {
    formatVersion: 1,
    sourceSet,
    sourceSetSha256: hash(source),
    candidateDirectory: directory,
    candidateManifestSha256: hash(manifest),
    deviceFile: "Candidate.amxd",
    deviceSha256: hash(device),
    audioFiles: [],
    artifactPrefix: "AA_SMOKE_NATIVE_TEST",
    canonicalPath: "live_set tracks 0 devices 0",
    trackName: "Fixture",
    deviceName: "Candidate",
  };
  const storage = resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(root, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
    },
  });
  return {
    root,
    input,
    storage,
    source,
    destination: join(root, "copied-set"),
  };
}

describe("native listening fixture staging", () => {
  it("copies immutable input bytes, pins code/device hashes and changes only owned discovery", async () => {
    const f = await nativeFixtureInput();
    const staged = await stageNativeListeningFixture(f);
    expect(await readFile(staged.setPath)).toEqual(f.source);
    await expect(
      access(join(f.destination, "Ableton Project Info")),
    ).resolves.toBeUndefined();
    expect(await readFile(f.input.sourceSet)).toEqual(f.source);
    expect(
      await readFile(
        join(f.input.candidateDirectory, "agent_signal_storage.js"),
        "utf8",
      ),
    ).toBe("test-only old discovery, never executed");
    const discovery = await readFile(
      join(
        f.destination,
        "Native-Listener-Candidate",
        "agent_signal_storage.js",
      ),
      "utf8",
    );
    expect(discovery).toContain(f.storage.signalIngressDescriptorPath);
    expect(discovery).toContain(f.storage.signalIngressSecretPath);
    expect(staged.sourceSetSha256).toBe(f.input.sourceSetSha256);
    await staged.cleanup();
    await expect(access(f.destination)).rejects.toThrow();
    await expect(access(f.input.sourceSet)).resolves.toBeUndefined();
  });

  async function runnerFixture({
    failure,
    terminal = "completed",
    humanGate = false,
    journalFlushFailure = false,
  } = {}) {
    const f = await nativeFixtureInput();
    const inputPath = join(f.root, "provisioned-input.json");
    await writeFile(inputPath, JSON.stringify(f.input));
    const manifest = JSON.parse(
      await readFile(
        "integration/live-scenarios/native-playback-and-listen.json",
      ),
    );
    const runId = randomUUID();
    const subscribers = new Set();
    const appEvents = new Set();
    const close = vi.fn();
    const journalClose = vi.fn();
    const wait = vi.fn();
    let ingressStarted = false;
    const startIngress = vi.fn(async () => {
      expect((await stat(options.signal.secretPath)).mode & 0o777).toBe(0o600);
      expect((await readFile(options.signal.secretPath, "utf8")).trim()).toBe(
        "x".repeat(40),
      );
      if (failure === "signal-start")
        throw new Error("test signal start failure");
      ingressStarted = true;
    });
    const stopIngress = vi.fn(async () => {
      ingressStarted = false;
      if (failure === "signal-stop")
        throw new Error("test signal stop failure");
    });
    let configuration;
    let agentServiceStarted = false;
    let playing = false;
    let ports;
    let job;
    let actorContext;
    let options;
    const listener = {
      connectionId: "connection",
      producer: {
        producerId: "native",
        instanceId: "instance",
        signalKind: "audio",
        schemaVersion: "audio-observation/v1",
        track: { id: "track" },
        device: { id: "device" },
      },
      binding: { trackId: "track", deviceId: "device" },
      registration: {
        connectionEpoch: "epoch",
        nativeStatus: {
          scope: protocol.NATIVE_LISTENER_SCOPE,
          timing: "UNVERIFIED",
          readiness: "BLOCKED",
          reason: "native_per_pass_validation_required",
        },
        sampleRate: 48000,
        deviceCanonicalPath: f.input.canonicalPath,
      },
      phase: "idle",
    };
    const target = {
      binding: {
        track: { expectedReference: "track", expectedName: f.input.trackName },
        expectedDeviceReference: "device",
        expectedDeviceName: f.input.deviceName,
      },
      canonicalPath: f.input.canonicalPath,
      pathAttestation: { canonicalDevicePath: f.input.canonicalPath },
      enabled: true,
      sessionOverride: false,
      clipsTruncated: false,
      dependenciesTruncated: false,
      clips: [],
      upstreamDevices: [],
    };
    const listeningOptions = {};
    const services = {
      ...applicationServices,
      ...runtimeServices,
      ...observabilityServices,
      ...storageServices,
      JsonSessionStore,
      LocalObservabilityJournal: {
        open: async (options) => {
          const journal =
            await observabilityServices.LocalObservabilityJournal.open(options);
          const flush = journal.flush.bind(journal);
          const close = journal.close.bind(journal);
          journal.flush = async () => {
            await flush();
            if (journalFlushFailure)
              throw new Error("test journal flush failure");
          };
          journal.close = async () => {
            journalClose();
            await close();
          };
          return journal;
        },
      },
      createDesktopSessionContextManager,
      publishSignalSecrets: vi.fn(async (...args) => {
        if (failure === "credentials")
          throw new Error("test credential publication failure");
        return publishSignalSecrets(...args);
      }),
      sessionSchema,
      protocol,
      createListeningRuntimeHost: vi.fn((_dependencies, supplied) => {
        Object.assign(listeningOptions, supplied);
        return {
          shutdown: vi.fn(),
          executeListeningOperation: async (params, context) => {
            await supplied.resolveOwner(context);
            if (params.action === "inspect-listeners")
              return {
                action: params.action,
                truncated: false,
                listeners: [
                  {
                    listenerId: "native",
                    ready: false,
                    limitations: ["native_per_pass_validation_required"],
                    trackReference: "track",
                    deviceReference: "device",
                  },
                ],
              };
            if (params.action === "play-arrangement-and-listen") {
              actorContext = context;
              job = {
                passId: randomUUID(),
                stage: "arming",
                contextIds: [],
                cleanupPolicy: "leave-running",
              };
              supplied.onChange(job);
              return { action: params.action, job };
            }
            return { action: params.action, job };
          },
          waitForListeningPass: async () => {
            wait();
            if (failure === "cancelled")
              throw new globalThis.DOMException(
                "test cancellation",
                "AbortError",
              );
            if (terminal !== "completed") {
              job = {
                ...job,
                stage: terminal,
                ...(failure === "marker"
                  ? {
                      error:
                        "Arrangement insert marker does not match the requested start",
                    }
                  : {}),
                ...(failure === "clock-and-policy"
                  ? { error: "native_clock_discontinuity" }
                  : {}),
              };
              supplied.onChange(job);
              return job;
            }
            const owner = await supplied.resolveOwner(actorContext);
            const repository = await supplied.resolveRepository(
              owner,
              actorContext,
            );
            const { proof, observation } =
              createSyntheticNativeListeningFixture({
                passId: job.passId,
                listenerId: "native",
              });
            observation.attacks = [0, 1, 2, 3].map((beat) => ({
              beat,
              sample: observation.startSample + beat * 24000,
              strength: 1,
            }));
            observation.reduction.originalAttacks = 4;
            const at = new Date().toISOString();
            const subject = (kind) => ({
              id: randomUUID(),
              sessionId: owner.sessionId,
              liveSetId: owner.liveSetId,
              kind,
              trackId: "track",
              binding: {
                version: 1,
                semanticLocator: {
                  name: "Fixture",
                  trackId: "track",
                  ...(kind === "arrangement-range"
                    ? { arrangementRange: { startBeat: 0, endBeat: 4 } }
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
            const publication = applicationServices.buildListeningPublication({
              passId: job.passId,
              owner,
              trace: actorContext.trace,
              requestedMode: "arrangement",
              actualMode: "arrangement",
              requestedRange: { startBeat: 0, endBeat: 4 },
              createdAt: at,
              startedAt: at,
              endedAt: at,
              observations: [observation],
              bindings: [
                {
                  listenerId: "native",
                  deviceReference: "device",
                  connectionEpoch: "epoch",
                  version: "1.0.0",
                  primary: subject("arrangement-range"),
                  contributors: [subject("track")],
                  attribution: "unknown",
                },
              ],
            });
            await repository.appendPass(publication, {
              trace: actorContext.trace,
              activeAgentId: owner.agentId,
            });
            for (const subscribe of subscribers)
              subscribe({
                connectionId: "connection",
                producer: listener.producer,
                binding: listener.binding,
                result: {
                  status: "completed",
                  connectionEpoch: "epoch",
                  passId: job.passId,
                  ...actorContext.trace,
                  nativeCapture: failure === "proof" ? undefined : proof,
                  observation,
                },
              });
            job = {
              ...job,
              stage: "completed",
              contextIds: [publication.entries[0].id],
            };
            supplied.onChange(job);
            playing = true;
            return job;
          },
        };
      }),
      createAgentRuntime: vi.fn((supplied) => {
        options = supplied;
        ports = supplied.listening({});
        return {
          ableton: {
            inspectListeningContext: async () => ({
              listeners: [target],
              transport: {
                playing,
                currentBeat: playing ? 4 : 0,
                tempo: 120,
                safeToStart: !playing,
                recording: {
                  recordMode: false,
                  sessionRecord: false,
                  arrangementOverdub: false,
                  sessionAutomationRecord: false,
                },
              },
            }),
          },
          signals: {
            start: startIngress,
            stop: stopIngress,
            listeners: {
              inspectListeners: () => [globalThis.structuredClone(listener)],
              onListenerResult: (subscriber) => {
                subscribers.add(subscriber);
                return () => subscribers.delete(subscriber);
              },
            },
          },
          application: {
            start: async ({ startAgent }) => {
              if (!ingressStarted)
                throw new Error("Signal ingress must start before application");
              if (failure === "start") throw new Error("test start failure");
              agentServiceStarted = startAgent === true;
            },
            stop: async () => {
              close();
              if (failure === "stop") throw new Error("test stop failure");
            },
            getStatus: async () => ({
              state: "connected",
              saved: true,
              liveSetId: "set",
              liveSetName: `${manifest.artifactPrefix}${runId}`,
              liveVersion: "11.3.43",
            }),
            inspectSession: async () => ({ isPlaying: playing, trackCount: 1 }),
            subscribe: (subscriber) => {
              appEvents.add(subscriber);
              return () => appEvents.delete(subscriber);
            },
            createManagedAgent: async (config) => {
              if (!agentServiceStarted)
                throw new Error("Copilot agent service is not started");
              configuration = config;
              return "sdk-session";
            },
            sendToManagedAgent: async () => {
              if (humanGate) {
                for (const subscriber of appEvents)
                  subscriber({ type: "agent.elicitation_requested" });
                return "No supplied answer";
              }
              const context = {
                sessionId: configuration.productionSessionId,
                agentId: configuration.instanceId,
                actorKind: "agent",
                trace: {
                  traceId: randomUUID(),
                  correlationId: "actor",
                  causationId: "invocation",
                },
              };
              for (const action of [
                "inspect-listeners",
                "play-arrangement-and-listen",
                "get-pass",
              ]) {
                const params =
                  action === "play-arrangement-and-listen"
                    ? {
                        action,
                        listenerIds: ["native"],
                        startBeat: 0,
                        endBeat: 4,
                        maximumDurationMs: 8000,
                      }
                    : action === "get-pass"
                      ? { action, passId: job.passId }
                      : { action };
                const allowed = await supplied.requestToolApproval({
                  metadata: {
                    name: "ableton_listening",
                    risk: params.action.startsWith("play")
                      ? "reversible"
                      : "read",
                  },
                  arguments: params,
                  agentInstanceId: configuration.instanceId,
                });
                if (!allowed) throw new Error("Test actor approval denied");
                await ports.executeListeningOperation(params, context);
                for (const subscriber of appEvents)
                  subscriber({ type: "operation.started" });
              }
              if (failure === "clock-and-policy")
                expect(
                  await supplied.requestToolApproval({
                    metadata: { name: "ableton_context", risk: "read" },
                    arguments: {
                      action: "get",
                      contextId: job.passId,
                      includeHistorical: true,
                    },
                    agentInstanceId: configuration.instanceId,
                  }),
                ).toBe(false);
              expect(job.stage).toBe("arming");
              return "Test model ends its turn while real terminal work remains";
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
    });
    return {
      ...f,
      runner,
      services,
      close,
      journalClose,
      wait,
      startIngress,
      stopIngress,
      subscribers,
      appEvents,
      get configuration() {
        return configuration;
      },
      get options() {
        return options;
      },
    };
  }

  describe("native runner orchestration with production typed context services and test-only actor/capture", () => {
    it("fails credential publication before ingress startup or actor work", async () => {
      const f = await runnerFixture({ failure: "credentials" });
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("test credential publication failure");
      expect(f.startIngress).not.toHaveBeenCalled();
      expect(f.stopIngress).toHaveBeenCalledOnce();
      expect(f.wait).not.toHaveBeenCalled();
      expect(result.jobs).toEqual([]);
      await expect(
        access(f.runner.storage.signalIngressSecretPath),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await f.runner.close({ processStopped: true });
    });
    it.each(["signal-start", "signal-stop"])(
      "reports %s and always attempts owned ingress shutdown",
      async (failure) => {
        const f = await runnerFixture({ failure });
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error ?? result.cleanupError).toContain(
          failure === "signal-start"
            ? "test signal start failure"
            : "test signal stop failure",
        );
        expect(f.startIngress).toHaveBeenCalledOnce();
        expect(f.stopIngress).toHaveBeenCalledOnce();
        expect(f.services.publishSignalSecrets).toHaveBeenCalledOnce();
        await expect(
          access(f.runner.storage.signalIngressSecretPath),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(f.close).toHaveBeenCalledOnce();
        await f.runner.close({ processStopped: true });
      },
    );
    it("fails a post-arm insert-marker denial without seeking, retrying or publishing context", async () => {
      const f = await runnerFixture({ failure: "marker", terminal: "failed" });
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        "Arrangement insert marker does not match the requested start",
      );
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]).toMatchObject({
        stage: "failed",
        contextIds: [],
        error: "Arrangement insert marker does not match the requested start",
      });
      expect(f.wait).toHaveBeenCalledOnce();
      expect(f.services.createAgentRuntime).toHaveBeenCalledOnce();
      const sessions = await new JsonSessionStore(
        f.runner.storage.sessionsPath,
        f.runner.storage,
      ).load();
      const manager = createDesktopSessionContextManager({
        storage: f.runner.storage,
        resolveSession: async () => sessions[0],
        publishSessionContext: async () => {
          throw new Error("Denied pass must never publish");
        },
      });
      try {
        const repository = await manager.resolveRepository({
          sessionId: sessions[0].id,
          agentId: sessions[0].activeAgents[0].id,
          actorKind: "application",
          trace: {
            traceId: randomUUID(),
            correlationId: "denial",
            causationId: "post-arm",
          },
        });
        expect(
          (await repository.listEntries({ includeHistorical: true, limit: 20 }))
            .items,
        ).toEqual([]);
      } finally {
        await manager.close();
        await f.runner.close({ processStopped: true });
      }
    });
    it("closes its journal even if final evidence flushing fails", async () => {
      const f = await runnerFixture({
        failure: "start",
        journalFlushFailure: true,
      });
      expect((await f.runner.run(async () => {})).ok).toBe(false);
      await expect(f.runner.close({ processStopped: true })).rejects.toThrow(
        "test journal flush failure",
      );
      expect(f.journalClose).toHaveBeenCalledOnce();
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    });
    it("retains a terminal native failure ahead of a secondary denied context request", async () => {
      const f = await runnerFixture({
        failure: "clock-and-policy",
        terminal: "failed",
      });
      const result = await f.runner.run(async () => {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("native_clock_discontinuity");
      expect(result.approvals.filter((item) => !item.approved)).toHaveLength(1);
      expect(result.jobs).toEqual([
        expect.objectContaining({
          stage: "failed",
          error: "native_clock_discontinuity",
          contextIds: [],
        }),
      ]);
      expect(f.wait).toHaveBeenCalledOnce();
      expect(f.stopIngress).toHaveBeenCalledOnce();
      await f.runner.close({ processStopped: true });
    });
    it("waits after model arming acceptance, verifies one atomic context and actually reopens the production store", async () => {
      const f = await runnerFixture();
      const ownership = vi.fn(async () => {});
      const result = await f.runner.run(ownership);
      expect(result.error).toBeUndefined();
      expect(result.cleanupError).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(f.wait).toHaveBeenCalledOnce();
      expect(f.services.createListeningRuntimeHost).toHaveBeenCalledOnce();
      expect(result.evidence.stereoFrames).toBe(96000);
      expect(result.lifecycle.map((event) => event.name)).toContain(
        "integration.native_listening.typed-context-reopen.completed",
      );
      expect(f.configuration.resolvedOperations).toContain(
        "listening.play_arrangement_and_listen",
      );
      expect(f.options.agent.baseDirectory).toBe(
        f.runner.storage.copilotDirectory,
      );
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.startIngress).toHaveBeenCalledOnce();
      expect(f.stopIngress).toHaveBeenCalledOnce();
      expect(result.lifecycle.map((event) => event.name)).toContain(
        "integration.native_listening.signal-start.completed",
      );
      expect(result.lifecycle.map((event) => event.name)).toContain(
        "integration.native_listening.signal-shutdown.completed",
      );
      expect(f.subscribers.size).toBe(0);
      expect(f.appEvents.size).toBe(0);
      await f.runner.close({ processStopped: true });
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    });
    it.each(["start", "proof", "cancelled", "stop"])(
      "fails %s without inferring success and closes only its own services",
      async (failure) => {
        const f = await runnerFixture({ failure });
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        if (failure === "start")
          expect(result.error).toContain("test start failure");
        if (failure === "cancelled")
          expect(result.error).toContain("test cancellation");
        if (failure === "proof") expect(result.error).toContain("expected");
        if (failure === "stop")
          expect(result.cleanupError).toContain("test stop failure");
        expect(f.close).toHaveBeenCalledOnce();
        expect(f.stopIngress).toHaveBeenCalledOnce();
        expect(f.subscribers.size).toBe(0);
        await f.runner.close({ processStopped: true });
      },
    );
    it("denies a human gate and failed terminal state; never deletes a surviving process's fixture", async () => {
      for (const opts of [{ humanGate: true }, { terminal: "failed" }]) {
        const f = await runnerFixture(opts);
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error).toContain(
          opts.humanGate ? "human gate" : "terminal job did not complete",
        );
        await expect(f.runner.close({ processStopped: false })).rejects.toThrow(
          "retained staging",
        );
        await expect(access(f.runner.fixture.setPath)).resolves.toBeUndefined();
      }
    });
  });

  it.each(["sourceSetSha256", "deviceSha256", "candidateManifestSha256"])(
    "rejects a mismatched %s before staging",
    async (field) => {
      const f = await nativeFixtureInput();
      f.input[field] = "f".repeat(64);
      await expect(stageNativeListeningFixture(f)).rejects.toThrow(
        /hash mismatch|Unsupported/,
      );
      await expect(access(f.destination)).rejects.toThrow();
    },
  );

  it("refuses missing resources, unexpected resources and symlinks", async () => {
    const f = await nativeFixtureInput();
    await rm(join(f.input.candidateDirectory, "engine.js"));
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("Missing");
    await symlink(
      f.input.sourceSet,
      join(f.input.candidateDirectory, "engine.js"),
    );
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("regular");
    await rm(join(f.input.candidateDirectory, "engine.js"));
    await writeFile(
      join(f.input.candidateDirectory, "unreviewed.js"),
      "unreviewed",
    );
    await expect(stageNativeListeningFixture(f)).rejects.toThrow("Unreviewed");
  });

  it("denies external unscoped Max code, unprovisioned audio and unsupported reference encodings", async () => {
    const f = await nativeFixtureInput();
    for (const path of [
      "/operator-owned/old.amxd",
      "/operator-owned/unprovisioned.wav",
      "/operator-owned/unprovisioned.aif",
    ]) {
      const source = gzipSync(
        `<Ableton ><FileRef><RelativePathType Value="3" /><RelativePath Value="Native-Listener-Candidate/Candidate.amxd" /><Path Value="${path}" /></FileRef></Ableton>`,
      );
      expect(() => inspectNativeFixtureSet(source, f.input)).toThrow(
        /Unsafe fixture/,
      );
    }
    expect(() =>
      inspectNativeFixtureSet(
        gzipSync("<!DOCTYPE example><Ableton />"),
        f.input,
      ),
    ).toThrow("Unsupported");
  });

  it("cancels without copying and preserves pre-existing destinations", async () => {
    const f = await nativeFixtureInput();
    const abort = new globalThis.AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      stageNativeListeningFixture({ ...f, signal: abort.signal }),
    ).rejects.toThrow("cancelled");
    await expect(access(f.destination)).rejects.toThrow();
    await mkdir(f.destination);
    await writeFile(join(f.destination, "owned-by-someone-else"), "preserve");
    await expect(stageNativeListeningFixture(f)).rejects.toThrow();
    expect(await readdir(f.destination)).toEqual(["owned-by-someone-else"]);
  });

  it("cleans a partially written owned copy on cancellation", async () => {
    const f = await nativeFixtureInput();
    const abort = new globalThis.AbortController();
    let checks = 0;
    const signal = {
      throwIfAborted() {
        if (++checks === 9) abort.abort(new Error("cancelled during copy"));
        abort.signal.throwIfAborted();
      },
    };
    await expect(stageNativeListeningFixture({ ...f, signal })).rejects.toThrow(
      "cancelled",
    );
    await expect(access(f.destination)).rejects.toThrow();
    expect(await readFile(f.input.sourceSet)).toEqual(f.source);
  });
});
