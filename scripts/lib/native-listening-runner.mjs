import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { stageNativeListeningFixture } from "./native-listening-fixture.mjs";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";
import {
  createNativeScenarioApproval,
  verifyNativeListeningEvidence,
} from "./native-listening-verification.mjs";

export async function loadNativeRunnerServices() {
  const [
    runtime,
    application,
    observability,
    storage,
    protocol,
    desktop,
    context,
    contracts,
  ] = await Promise.all([
    import("../../packages/runtime/dist/index.js"),
    import("../../packages/application/dist/index.js"),
    import("../../packages/observability/dist/index.js"),
    import("../../packages/storage/dist/index.js"),
    import("../../packages/protocol/dist/index.js"),
    import("../../apps/desktop/dist/main/desktop-service.js"),
    import("../../apps/desktop/dist/main/desktop-session-context.js"),
    import("../../apps/desktop/dist/contracts.js"),
  ]);
  return {
    ...runtime,
    ...application,
    ...observability,
    ...storage,
    ...desktop,
    ...context,
    ...contracts,
    protocol,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Integration-only composition. The runtime, host, context manager and registry
 * are the production factories; no Desktop window or alternate capture adapter. */
export async function createNativeListeningRunner({
  manifest,
  inputPath,
  directory,
  environment,
  runId,
  services = undefined,
}) {
  const d = services ?? (await loadNativeRunnerServices());
  assert(
    manifest.id === "native-playback-and-listen" &&
      manifest.execution === "native-listening-runtime" &&
      manifest.timeoutMs === 60000 &&
      manifest.maxToolCalls === 8 &&
      manifest.maxMutations === 1,
    "Unreviewed native scenario contract",
  );
  assert(
    inputPath !== undefined,
    "--native-fixture-input is required; no user-file fallback",
  );
  const info = await lstat(inputPath);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024,
    "Native fixture input must be a bounded regular JSON file",
  );
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  assert(
    input.formatVersion === 1 &&
      /^live_set tracks (?:0|[1-9][0-9]?) devices (?:0|[1-9][0-9]?)$/.test(
        input.canonicalPath,
      ) &&
      typeof input.trackName === "string" &&
      input.trackName.length <= 128 &&
      typeof input.deviceName === "string" &&
      input.deviceName.length <= 128,
    "Explicit pinned native fixture identity is required",
  );
  const root = resolve(directory);
  const suffix = relative(resolve(".test-artifacts"), root);
  assert(
    suffix !== "" &&
      suffix !== ".." &&
      !suffix.startsWith(`..${sep}`) &&
      (await realpath(dirname(root))) === dirname(root),
    "Native runner directory must be a fresh nonsymlink artifact namespace",
  );
  await mkdir(root, { recursive: false, mode: 0o700 });
  const storage = d.resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(root, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
    },
  });
  const journal = await d.LocalObservabilityJournal.open({
    path: storage.eventJournalPath,
  });
  const closeJournal = async () => {
    try {
      await journal.flush();
    } finally {
      await journal.close();
    }
  };
  let telemetryFailed = false;
  const telemetry = d.createNonBlockingObservabilityRecorder(
    {
      enqueue: (event) => journal.enqueue(event),
      enqueueConfigurationSnapshot: (event) =>
        journal.enqueueConfigurationSnapshot(event),
    },
    {
      onFailure: () => {
        telemetryFailed = true;
      },
    },
  );
  const trace = {
    traceId: randomUUID(),
    correlationId: runId,
    causationId: randomUUID(),
  };
  const lifecycle = createNativeRunnerLifecycle({
    telemetry,
    sanitize: d.sanitizeTelemetryAttributes,
    trace,
  });
  let fixture;
  try {
    fixture = await stageNativeListeningFixture({
      input: { ...input, artifactPrefix: `${manifest.artifactPrefix}${runId}` },
      destination: join(root, "fixture"),
      storage,
      stage: lifecycle.stage,
    });
  } catch (error) {
    await closeJournal();
    throw error;
  }
  let runtime;
  let manager;
  let host;
  let unsubscribeResult;
  let unsubscribeApplication;
  let actorContext;
  let repository;
  const jobs = new Map();
  const received = [];
  const binding = {
    listenerId: undefined,
    passIds: new Set(),
    contextIds: new Set(),
  };
  const approvals = createNativeScenarioApproval(manifest, binding);
  const owner = {
    sessionId: randomUUID(),
    agentId: randomUUID(),
    liveSetId: undefined,
  };
  const contextStore = new d.JsonSessionStore(storage.sessionsPath, storage);
  let ownerSession;
  const makeManager = () =>
    d.createDesktopSessionContextManager({
      storage,
      recorder: telemetry,
      resolveSession: async (id) =>
        (await contextStore.load()).find((session) => session.id === id),
      publishSessionContext: async (request) => {
        assert(
          request.sessionId === owner.sessionId &&
            request.liveSetId === owner.liveSetId &&
            request.activeAgentId === owner.agentId,
          "Foreign context publication denied",
        );
        const sessions = await contextStore.load();
        const session = sessions.find((item) => item.id === request.sessionId);
        assert(session !== undefined, "Context owner is missing");
        const published = { ...session, contextStore: request.contextStore };
        await contextStore.save(
          sessions.map((item) => (item.id === session.id ? published : item)),
          {
            trace: request.trace,
            activeAgentId: request.activeAgentId,
            signal: request.signal,
          },
        );
        return published;
      },
    });
  const reader = () => ({
    sessionId: owner.sessionId,
    agentId: owner.agentId,
    actorKind: "application",
    trace,
  });
  const normalizeSnapshot = (input) => {
    const snapshot = { ...input };
    delete snapshot.isPlaying;
    return snapshot;
  };
  const normalizeInspection = (inspection) =>
    inspection.listeners.map((item) => ({
      binding: item.binding,
      canonicalPath: item.canonicalPath,
      enabled: item.enabled,
      clips: item.clips.map((clip) => ({
        target: clip.target,
        interval: clip.interval,
        settings: clip.settings,
      })),
      upstreamDevices: item.upstreamDevices,
    }));
  return {
    fixture,
    storage,
    async run(validateOwnership) {
      let result;
      try {
        manager = makeManager();
        const contextHost = d.createSessionContextHost({
          resolveRepository: (context) => manager.resolveRepository(context),
        });
        runtime = d.createAgentRuntime({
          ableton: d.resolveAbletonSettingsFromEnvironment(environment),
          agent: {
            ...d.resolveAgentSettingsFromEnvironment(environment),
            baseDirectory: storage.copilotDirectory,
            largeOutputDirectory: storage.copilotToolOutputDirectory,
            turnTimeoutMs: manifest.timeoutMs,
          },
          signal: {
            secret: environment.ABLETON_AGENT_TOKEN,
            port: 0,
            descriptorPath: storage.signalIngressDescriptorPath,
            secretPath: storage.signalIngressSecretPath,
          },
          telemetry,
          agentHistory: journal,
          setHistory: journal,
          currentAppSessionId: () => owner.sessionId,
          currentLiveSetId: () => owner.liveSetId,
          requestToolApproval: approvals.request,
          askForReadApproval: true,
          listening: (dependencies) => {
            host = d.createListeningRuntimeHost(dependencies, {
              contextPorts: contextHost,
              resolveOwner: async (context) => {
                assert(
                  context.sessionId === owner.sessionId &&
                    context.agentId === owner.agentId,
                  "Foreign listening actor denied",
                );
                return owner;
              },
              resolveRepository: (_owner, context) =>
                manager.resolveRepository(context),
              onChange: (job) => {
                assert(
                  jobs.has(job.passId) || jobs.size < 1,
                  "Native scenario pass quota exceeded",
                );
                jobs.set(job.passId, globalThis.structuredClone(job));
                binding.passIds.add(job.passId);
                for (const id of job.contextIds) binding.contextIds.add(id);
              },
            });
            return {
              ...host,
              executeListeningOperation: async (params, context) => {
                actorContext = context;
                return host.executeListeningOperation(params, context);
              },
            };
          },
        });
        await lifecycle.stage("application-start", () =>
          runtime.application.start({ startAgent: false }),
        );
        const deadline = Date.now() + manifest.timeoutMs;
        const boundedStage = (name, operation) =>
          lifecycle.stage(name, () =>
            d.awaitListeningBoundary(
              operation(),
              globalThis.AbortSignal.timeout(
                Math.max(1, deadline - Date.now()),
              ),
            ),
          );
        await lifecycle.stage("native-preflight", async () => {
          while (Date.now() < deadline) {
            await validateOwnership();
            const status = await runtime.application.getStatus();
            const listeners =
              runtime.signals.listeners?.inspectListeners() ?? [];
            const matches = listeners.filter(
              (item) =>
                item.registration.deviceCanonicalPath === input.canonicalPath,
            );
            if (status.state === "connected" && matches.length === 1) {
              owner.liveSetId = status.liveSetId;
              assert(
                typeof owner.liveSetId === "string" &&
                  status.saved === true &&
                  status.liveSetName === `${manifest.artifactPrefix}${runId}`,
                "Runner-owned copied Set identity mismatch",
              );
              binding.listenerId = matches[0].producer.producerId;
              break;
            }
            await new Promise((resolve_) => setTimeout(resolve_, 100));
          }
          assert(
            binding.listenerId !== undefined,
            "Timed out waiting for exact copied native candidate",
          );
        });
        const listener = runtime.signals.listeners
          .inspectListeners()
          .find((item) => item.producer.producerId === binding.listenerId);
        assert(
          listener.registration.nativeStatus?.scope ===
            d.protocol.NATIVE_LISTENER_SCOPE &&
            listener.registration.sampleRate === 48000 &&
            listener.phase === "idle",
          "Native candidate scope/sample rate/idle state mismatch",
        );
        const inspectionParams = {
          schemaVersion: 1,
          bindingQueryId: randomUUID(),
          listeners: [{ canonicalPath: input.canonicalPath }],
          range: { startBeat: 0, endBeat: 4 },
          maxClips: 32,
          maxParameters: 16,
        };
        const inspected =
          await runtime.ableton.inspectListeningContext(inspectionParams);
        const target = inspected.listeners[0];
        assert(
          inspected.transport.playing === false &&
            inspected.transport.currentBeat === 0 &&
            inspected.transport.tempo === 120 &&
            inspected.transport.safeToStart === true &&
            Object.values(inspected.transport.recording).every(
              (value) => value === false,
            ) &&
            inspected.listeners.length === 1 &&
            target.enabled === true &&
            target.sessionOverride === false &&
            target.pathAttestation?.canonicalDevicePath ===
              input.canonicalPath &&
            target.binding.track.expectedName === input.trackName &&
            target.binding.expectedDeviceName === input.deviceName &&
            !target.clipsTruncated &&
            !target.dependenciesTruncated,
          "Unsafe or mismatched stopped native preflight",
        );
        const baseline = normalizeSnapshot(
          await runtime.application.inspectSession(),
        );
        const actorConfiguration = {
          instanceId: owner.agentId,
          productionSessionId: owner.sessionId,
          definitionName: "native-listening-integration",
          label: "Native listening integration",
          description:
            "Reviewed native Arrangement playback-and-listen integration scenario.",
          systemPrompt: "Execute only the reviewed listening scenario.",
          resolvedTools: manifest.allowedTools,
          resolvedOperations: [
            "listening.inspect_listeners",
            "listening.play_arrangement_and_listen",
            "listening.get_pass",
            "listening.list_passes",
            "context.list",
            "context.get",
          ],
          editScope: ["session"],
          boundTracks: [],
          skills: [],
        };
        ownerSession = d.sessionSchema.parse({
          version: 4,
          id: owner.sessionId,
          title: `${manifest.artifactPrefix}${runId}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          liveSetId: owner.liveSetId,
          liveSetName: `${manifest.artifactPrefix}${runId}`,
          selectedAgentInstanceId: owner.agentId,
          activeAgents: [
            {
              id: owner.agentId,
              label: actorConfiguration.label,
              definitionName: actorConfiguration.definitionName,
              definitionFingerprint: input.deviceSha256,
              autoApprove: false,
              modified: false,
              lifecycle: "ready",
              boundTracks: [],
              eventListeners: [],
              outputSubscriptions: [],
              config: {
                description: actorConfiguration.description,
                systemPrompt: actorConfiguration.systemPrompt,
                tools: manifest.allowedTools,
                resolvedTools: manifest.allowedTools,
                resolvedOperations: actorConfiguration.resolvedOperations,
                editScope: ["session"],
                skills: [],
                inputChannels: [],
              },
            },
          ],
        });
        await lifecycle.stage("session-ownership", () =>
          contextStore.save([ownerSession], { trace }),
        );
        repository = await manager.resolveRepository(reader());
        assert(
          (await repository.listEntries({ includeHistorical: true, limit: 20 }))
            .items.length === 0,
          "Native scenario did not begin with empty owned context",
        );
        const view = await host.executeListeningOperation(
          { action: "inspect-listeners" },
          reader(),
        );
        const candidateView = view.listeners.find(
          (item) => item.listenerId === binding.listenerId,
        );
        assert(
          candidateView?.ready === false &&
            candidateView.limitations.includes(
              "native_per_pass_validation_required",
            ) &&
            candidateView.trackReference ===
              target.binding.track.expectedReference &&
            candidateView.deviceReference ===
              target.binding.expectedDeviceReference,
          "Candidate readiness or independently resolved identity mismatch",
        );
        unsubscribeResult = runtime.signals.listeners.onListenerResult(
          (event) => {
            if (
              event.producer.producerId === binding.listenerId &&
              event.result.status === "completed"
            ) {
              if (received.length < 2)
                received.push(globalThis.structuredClone(event));
            }
          },
        );
        let humanGate;
        let humanGateError;
        const humanGatePromise = new Promise((_resolve, reject) => {
          humanGate = reject;
        });
        void humanGatePromise.catch(() => {});
        let actorToolCalls = 0;
        unsubscribeApplication = runtime.application.subscribe((event) => {
          if (event.type === "operation.started") actorToolCalls++;
          if (
            [
              "agent.elicitation_requested",
              "agent.plan_approval_requested",
            ].includes(event.type)
          ) {
            humanGateError = new Error(
              "Native scenario cannot answer a human gate",
            );
            humanGate(humanGateError);
          }
        });
        const sdkSessionId = await boundedStage("actor-session-start", () =>
          runtime.application.createManagedAgent(actorConfiguration),
        );
        assert(
          typeof sdkSessionId === "string" &&
            sdkSessionId.length > 0 &&
            sdkSessionId.length <= 200,
          "Managed actor did not return a bounded SDK session identity",
        );
        await lifecycle.stage("actor-session-publication", () =>
          contextStore.save(
            [
              {
                ...ownerSession,
                activeAgents: ownerSession.activeAgents.map((agent) => ({
                  ...agent,
                  sdkSessionId,
                })),
              },
            ],
            { trace, activeAgentId: owner.agentId },
          ),
        );
        await boundedStage("actor-turn", () =>
          Promise.race([
            runtime.application.sendToManagedAgent(
              owner.agentId,
              `${manifest.prompt}\nExact runner-owned listener ID: ${binding.listenerId}. No other ID is approved. Historical context queries must set includeHistorical=true.`,
              "interactive",
            ),
            humanGatePromise,
          ]),
        );
        if (humanGateError !== undefined) throw humanGateError;
        assert(
          actorContext?.sessionId === owner.sessionId &&
            actorContext.agentId === owner.agentId &&
            actorContext.actorKind !== "application" &&
            jobs.size === 1 &&
            approvals.mutationCount === 1 &&
            approvals.decisions.every((item) => item.approved) &&
            actorToolCalls <= manifest.maxToolCalls,
          "A real owned actor call, exact pass and reviewed tool budget are required",
        );
        const passId = [...jobs.keys()][0];
        // The model may return during arming. Keep the real services alive through
        // the production coordinator's bounded terminal boundary.
        const terminal = await boundedStage("terminal-job", () =>
          host.waitForListeningPass(passId, actorContext),
        );
        assert(
          terminal.passId === passId && terminal.stage === "completed",
          `Listening terminal job did not complete (${terminal.stage})${terminal.error === undefined ? "" : `: ${terminal.error}`}`,
        );
        const jobResult = await host.executeListeningOperation(
          { action: "get-pass", passId },
          actorContext,
        );
        const job = jobResult.job;
        const pass = await repository.getPass(passId);
        const rows = (
          await repository.listEntries({ includeHistorical: true, limit: 20 })
        ).items;
        const entries = await Promise.all(
          rows.map((item) => repository.getEntry(item.id)),
        );
        const links = (
          await repository.listLinks({ includeHistorical: true, limit: 20 })
        ).items;
        const subjects = await Promise.all(
          [...new Set(links.map((item) => item.subjectId))].map((id) =>
            repository.getSubject(id),
          ),
        );
        const typed = await contextHost.executeContextOperation(
          {
            action: "get",
            contextId: job.contextIds[0],
            includeHistorical: true,
          },
          reader(),
        );
        await lifecycle.stage("context-close", () => manager.close());
        manager = makeManager();
        const resumedHost = d.createSessionContextHost({
          resolveRepository: (context) => manager.resolveRepository(context),
        });
        const resumed = await lifecycle.stage("typed-context-reopen", () =>
          resumedHost.executeContextOperation(
            {
              action: "get",
              contextId: job.contextIds[0],
              includeHistorical: true,
            },
            reader(),
          ),
        );
        await validateOwnership();
        const finalInspection =
          await runtime.ableton.inspectListeningContext(inspectionParams);
        const finalSnapshot = await runtime.application.inspectSession();
        const finalListener = runtime.signals.listeners
          .inspectListeners()
          .find((item) => item.producer.producerId === binding.listenerId);
        assert(
          finalSnapshot.isPlaying === true &&
            finalInspection.transport.playing === true &&
            Object.values(finalInspection.transport.recording).every(
              (value) => value === false,
            ) &&
            finalListener?.phase === "idle" &&
            finalListener.passId === undefined &&
            finalListener.jobId === undefined &&
            finalListener.connectionId === listener.connectionId &&
            isDeepStrictEqual(
              finalListener.registration,
              listener.registration,
            ) &&
            isDeepStrictEqual(
              normalizeInspection(inspected),
              normalizeInspection(finalInspection),
            ),
          "Leave-running capture cleanup, immutable binding or recording state mismatch",
        );
        const evidence = await lifecycle.stage(
          "independent-verification",
          async () =>
            verifyNativeListeningEvidence(
              {
                job,
                pass,
                entries,
                links,
                subjects,
                received,
                listener,
                owner,
                baseline,
                final: normalizeSnapshot(finalSnapshot),
                typed,
                resumed,
                target,
              },
              d.protocol,
            ),
        );
        assert(
          !telemetryFailed,
          "Native scenario observability persistence failed",
        );
        result = {
          ok: true,
          evidence,
          fixture: {
            sourceSetSha256: fixture.sourceSetSha256,
            deviceSha256: fixture.deviceSha256,
            discoverySha256: fixture.discoverySha256,
            resourceCount: fixture.resourceCount,
          },
          observedLiveVersion: (await runtime.application.getStatus())
            .liveVersion,
          supportedTargetQualified: false,
          actorToolCalls,
        };
      } catch (error) {
        result = {
          ok: false,
          error: d
            .sanitizePersistedText(String(error?.message ?? error))
            .slice(0, 2048),
        };
      } finally {
        unsubscribeResult?.();
        unsubscribeApplication?.();
        try {
          await lifecycle.stage("application-shutdown", async () => {
            await runtime?.application.stop();
            await manager?.close();
          });
        } catch (error) {
          result = {
            ...result,
            ok: false,
            cleanupError: d
              .sanitizePersistedText(String(error?.message ?? error))
              .slice(0, 2048),
          };
        }
      }
      return {
        ...result,
        approvals: approvals.decisions.map((item) =>
          d.sanitizeTelemetryAttributes(item),
        ),
        jobs: [...jobs.values()].map((job) => ({
          passId: job.passId,
          stage: job.stage,
          cleanupPolicy: job.cleanupPolicy,
          contextIds: job.contextIds,
          ...(job.error === undefined
            ? {}
            : {
                error: d.sanitizePersistedText(job.error).slice(0, 2048),
              }),
        })),
        lifecycle: lifecycle.events,
      };
    },
    async close({ processStopped }) {
      try {
        if (processStopped) await fixture.cleanup();
        else
          throw new Error(
            "Runner process still owns the fixture: retained staging, no deletion",
          );
      } finally {
        await closeJournal();
      }
    },
  };
}
