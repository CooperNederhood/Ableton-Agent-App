import { join } from "node:path";
import { JsonSessionStore } from "../../apps/desktop/src/main/desktop-service.js";
import { sessionSchema } from "../../apps/desktop/src/contracts.js";
import {
  openSessionContextStore,
  SESSION_CONTEXT_STORE_REFERENCE,
} from "../../packages/project-state/src/index.js";
import {
  resolveLiveAgentStorage,
  resolveNestedSessionStorage,
} from "../../packages/storage/src/index.js";
import { createSyntheticMetricRecordStreamFixture } from "../../packages/protocol/src/testing.js";

export const listeningFixtureSessionId = "electron-listening-context";

/** Synthetic persistence/IPC fixture; never evidence of measured Max DSP. */
export async function seedListeningContext(profile: string): Promise<void> {
  const layout = resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(profile, "live-agent"),
      LIVE_AGENT_PROFILE: "default",
    },
  });
  const ownership = {
    sessionId: listeningFixtureSessionId,
    liveSetId: "electron-listening-set",
  };
  const paths = resolveNestedSessionStorage(layout, ownership);
  const timestamp = "2026-10-12T00:00:00.000Z";
  const registry = new JsonSessionStore(layout.sessionsPath, layout);
  const session = sessionSchema.parse({
    version: 4,
    id: ownership.sessionId,
    title: "Listening context fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    liveSetId: ownership.liveSetId,
    liveSetName: "Synthetic fixture Set",
    activeAgents: [],
    productionPlan: [],
    outputAssignments: [],
    liveEvents: [],
    armedMonitorTracks: [],
    contextStore: SESSION_CONTEXT_STORE_REFERENCE,
  });
  await registry.save([session]);
  const repository = await openSessionContextStore({
    path: paths.entityContextPath,
    ...ownership,
    publishSessionContext: async () => registry.save([session]),
  });
  try {
    const fixture = await createSyntheticMetricRecordStreamFixture();
    if (fixture.descriptor.source.view !== "arrangement")
      throw new Error("Expected an Arrangement fixture");
    const nativeOwner = fixture.descriptor.ownership;
    const trace = {
      traceId: nativeOwner.traceId,
      correlationId: nativeOwner.correlationId,
      causationId: nativeOwner.causationId,
    };
    const range = {
      startBeat: fixture.descriptor.geometry.startBeat,
      endBeat: fixture.descriptor.geometry.endBeat,
    };
    const pass = {
      id: nativeOwner.passId,
      ...ownership,
      initiatorAgentId: "fixture-agent",
      listenerIds: [nativeOwner.listenerId],
      requestedMode: "arrangement" as const,
      actualMode: "arrangement" as const,
      requestedRange: range,
      actualRange: range,
      status: "partial" as const,
      complete: false,
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: "2026-10-12T00:00:00.500Z",
      interruptionReason: null,
      trace,
    };
    const capture = await repository.beginMetricCapture({
      descriptor: fixture.descriptor,
      metadata: {
        id: "electron-stream-capture",
        trace,
        producer: {
          listenerId: nativeOwner.listenerId,
          deviceId: "fixture-device",
          agentId: "fixture-agent",
          connectionEpoch: nativeOwner.connectionEpoch,
          version: "synthetic",
        },
        pass,
        subject: {
          id: "fixture-subject",
          ...ownership,
          kind: "arrangement-range",
          trackId: "fixture-track",
          location: "arrangement",
          binding: {
            version: 1,
            semanticLocator: {
              name: "Synthetic stream persistence fixture",
              trackId: "fixture-track",
              arrangementRange: range,
            },
            sourceIdentity: "synthetic",
            playbackSettingsHash: "fixture-settings",
            upstreamProcessingHash: "fixture-chain",
            routingHash: "fixture-routing",
            dependencyScope: "unknown",
            previousRuntimeBindings: [
              fixture.descriptor.source.target.expectedReference,
            ],
          },
        },
      },
    });
    for await (const chunk of fixture.chunks())
      await repository.appendMetricChunk(capture, chunk);
    await repository.finalizeMetricCapture(capture, fixture.manifest, {
      ...pass,
      status: "completed",
      complete: true,
    });
  } finally {
    await repository.close();
  }
}
