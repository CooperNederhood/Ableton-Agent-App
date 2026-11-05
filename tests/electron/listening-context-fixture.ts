import { JsonSessionStore } from "../../apps/desktop/src/main/desktop-service.js";
import { join } from "node:path";
import { sessionSchema } from "../../apps/desktop/src/contracts.js";
import {
  buildListeningPublication,
  buildMetricListeningPublication,
} from "../../packages/application/src/listening-publication.js";
import {
  openSessionContextStore,
  SESSION_CONTEXT_STORE_REFERENCE,
} from "../../packages/project-state/src/index.js";
import {
  resolveLiveAgentStorage,
  resolveNestedSessionStorage,
} from "../../packages/storage/src/index.js";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.js";
import {
  createSyntheticNativeListeningFixtureV2,
  createSyntheticMetricListeningObservation,
} from "../../packages/protocol/src/testing.js";
import {
  mapSessionAudioObservation,
  MEL_BAND_PROFILE,
  melBandTimelineSchema,
  createMetricObservationReportRows,
} from "../../packages/protocol/src/index.js";

export const listeningFixtureSessionId = "electron-listening-context";
export const listeningFixturePassId = "electron-listening-pass";
export const descriptiveFixturePassId = "electron-descriptive-pass";
export const sessionFixturePassId = "electron-session-pass";
export const melFixturePassId = "electron-mel-pass";

export async function seedMelListeningContext(profile: string): Promise<void> {
  await seedListeningContext(profile, false, true);
}

/** Synthetic persistence/IPC fixture; never evidence of measured Max DSP. */
export async function seedListeningContext(
  profile: string,
  includeDescriptive = false,
  includeMel = false,
): Promise<void> {
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
    contextStore: SESSION_CONTEXT_STORE_REFERENCE,
  });
  await registry.save([session]);
  const repository = await openSessionContextStore({
    path: paths.entityContextPath,
    ...ownership,
    publishSessionContext: async () => registry.save([session]),
  });
  try {
    const fixture = createKnownListeningFixture("quarter-sine");
    const trace = {
      traceId: "00000000-0000-4000-8000-000000000001",
      correlationId: "electron-fixture",
      causationId: "seed",
    };
    await repository.appendPass(
      buildListeningPublication({
        passId: listeningFixturePassId,
        owner: { ...ownership, agentId: "fixture-agent" },
        trace,
        requestedMode: "arrangement",
        actualMode: "arrangement",
        requestedRange: { startBeat: 0, endBeat: 4 },
        createdAt: timestamp,
        startedAt: timestamp,
        endedAt: "2026-10-12T00:00:02.000Z",
        observations: [
          {
            schema: "audio-observation/v1",
            listenerId: "fixture-listener",
            passId: listeningFixturePassId,
            sampleRate: fixture.sampleRate,
            startSample: 0,
            endSample: 96_000,
            startBeat: 0,
            endBeat: 4,
            complete: true,
            limitations: [
              "Synthetic persistence fixture, not measured listener output",
            ],
            algorithm: {
              name: "synthetic-persistence-fixture",
              version: "1",
              windowSamples: 2048,
              hopSamples: 4800,
              settings: { attackThresholdDb: 6, minAttackSpacingSamples: 6000 },
              units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
              timingUncertaintySamples: 64,
            },
            summaries: {
              peak: [...fixture.reference.peak],
              rmsDbfs: [...fixture.reference.rmsDbfs],
              centroidHz: fixture.frequencyHz,
            },
            samples: [],
            attacks: [],
            reduction: {
              originalSamples: 0,
              originalAttacks: 0,
              truncated: false,
            },
          },
        ],
        bindings: [
          {
            listenerId: "fixture-listener",
            deviceReference: "fixture-device",
            connectionEpoch: "fixture-epoch",
            version: "1",
            attribution: "unknown",
            contributors: [],
            primary: {
              id: "fixture-subject",
              ...ownership,
              kind: "arrangement-range",
              trackId: "fixture-track",
              location: "arrangement",
              binding: {
                version: 1,
                semanticLocator: {
                  name: "Known sine persistence fixture",
                  trackId: "fixture-track",
                  arrangementRange: { startBeat: 0, endBeat: 4 },
                },
                sourceIdentity: "synthetic-fixture",
                playbackSettingsHash: "fixture-settings",
                upstreamProcessingHash: "fixture-chain",
                routingHash: "fixture-routing",
                dependencyScope: "unknown",
                previousRuntimeBindings: [],
              },
            },
          },
        ],
      }),
      { trace, activeAgentId: "fixture-agent" },
    );
    if (includeMel) {
      const observation = createSyntheticMetricListeningObservation({
        endBeat: 0.2,
      });
      Object.assign(observation.ownership, trace, {
        passId: melFixturePassId,
        listenerId: "fixture-mel-listener",
      });
      observation.requestedMetrics.push("mel-bands");
      observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
        schema: "mel-band-timeline/v1",
        status: "complete",
        profile: MEL_BAND_PROFILE,
        sampleRate: observation.geometry.sampleRate,
        sourceSupport: observation.sourceCoverage,
        expectedRecords: 2,
        frames: [0, 1].map((index) => ({
          index,
          support: {
            startSample: observation.geometry.startSample + index * 2_048,
            endSample: observation.geometry.startSample + (index + 1) * 2_048,
          },
          magnitudes: [
            Array.from({ length: 24 }, (_, band) =>
              index === 0 ? band + 1 : 0,
            ),
            Array.from({ length: 24 }, (_, band) =>
              index === 0
                ? band + 101
                : band === 2
                  ? 1e-12
                  : band >= 2 && band < 9
                    ? 0
                    : 1,
            ),
          ],
        })),
        gaps: [],
      });
      observation.rows = createMetricObservationReportRows(observation);
      observation.limitations = [
        "Synthetic persistence/IPC fixture; not measured Max DSP",
      ];
      await repository.appendPass(
        buildMetricListeningPublication({
          passId: melFixturePassId,
          owner: { ...ownership, agentId: "fixture-agent" },
          trace,
          requestedMode: "arrangement",
          actualMode: "arrangement",
          requestedRange: { startBeat: 0, endBeat: 0.2 },
          createdAt: timestamp,
          startedAt: timestamp,
          endedAt: "2026-10-12T00:00:02.000Z",
          observations: [observation],
          bindings: [
            {
              listenerId: observation.ownership.listenerId,
              deviceReference: "fixture-mel-device",
              connectionEpoch: observation.ownership.connectionEpoch,
              version: observation.schema,
              attribution: "unknown",
              contributors: [],
              primary: {
                id: "fixture-mel-subject",
                ...ownership,
                kind: "track",
                trackId: "fixture-mel-track",
                location: "track",
                binding: {
                  version: 1,
                  semanticLocator: {
                    name: "Synthetic mel-band persistence fixture",
                    trackId: "fixture-mel-track",
                  },
                  sourceIdentity: "synthetic-fixture",
                  playbackSettingsHash: "fixture-settings",
                  upstreamProcessingHash: "fixture-chain",
                  routingHash: "fixture-routing",
                  dependencyScope: "unknown",
                  previousRuntimeBindings: [observation.ownership.connectionId],
                },
              },
            },
          ],
        }),
        { trace, activeAgentId: "fixture-agent" },
      );
    }
    if (includeDescriptive) {
      const { observation } = createSyntheticNativeListeningFixtureV2({
        listenerId: "fixture-descriptive-listener",
        passId: descriptiveFixturePassId,
        geometry: {
          sampleRate: 44_100,
          vectorSize: 128,
          tempoBpm: 127.5,
          startBeat: 5.25,
          endBeat: 9.50001,
        },
      });
      observation.alignment.observedClockDisagreementSamples = 64;
      observation.alignment.observedBeatDisagreementSamples = 32;
      observation.limitations = [
        "Synthetic persistence/quality-format fixture; not measured native DSP",
      ];
      await repository.appendPass(
        buildListeningPublication({
          passId: descriptiveFixturePassId,
          owner: { ...ownership, agentId: "fixture-agent" },
          trace,
          requestedMode: "arrangement",
          actualMode: "arrangement",
          requestedRange: { startBeat: 5.25, endBeat: 9.50001 },
          createdAt: timestamp,
          startedAt: timestamp,
          endedAt: "2026-10-12T00:00:02.000Z",
          observations: [observation],
          bindings: [
            {
              listenerId: observation.listenerId,
              deviceReference: "fixture-descriptive-device",
              connectionEpoch: "fixture-descriptive-epoch",
              version: observation.algorithm.version,
              attribution: "unknown",
              contributors: [],
              primary: {
                id: "fixture-descriptive-subject",
                ...ownership,
                kind: "arrangement-range",
                trackId: "fixture-track",
                location: "arrangement",
                binding: {
                  version: 1,
                  semanticLocator: {
                    name: "Descriptive persistence fixture",
                    trackId: "fixture-track",
                    arrangementRange: { startBeat: 5.25, endBeat: 9.50001 },
                  },
                  sourceIdentity: "synthetic-fixture",
                  playbackSettingsHash: "fixture-settings",
                  upstreamProcessingHash: "fixture-chain",
                  routingHash: "fixture-routing",
                  dependencyScope: "unknown",
                  previousRuntimeBindings: [],
                },
              },
            },
          ],
        }),
        { trace, activeAgentId: "fixture-agent" },
      );
      const target = {
        view: "session" as const,
        track: {
          kind: "regular" as const,
          index: 0,
          expectedReference: "00000000-0000-4000-8000-000000000063",
          expectedName: "Synthetic instrument",
        },
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000064",
        expectedClipName: "Synthetic Session leading rests",
      };
      const raw = createSyntheticNativeListeningFixtureV2({
        listenerId: "fixture-session-listener",
        passId: sessionFixturePassId,
        geometry: {
          sampleRate: 48000,
          vectorSize: 64,
          tempoBpm: 120,
          startBeat: 12,
          endBeat: 16,
        },
      }).observation;
      const sessionObservation = mapSessionAudioObservation(raw, {
        view: "session",
        target,
        kind: "midi",
        coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
        transport: { startBeat: 12, endBeat: 16 },
        origin: {
          evidence: "message-rate-start-time-with-native-transport",
          clipStartTimeBeats: 12,
          observedAtGlobalBeat: 12.2,
        },
        continuity: {
          evidence: "message-rate-monitored",
          followActions: "unknown",
        },
      });
      const trackId = "fixture-session-track";
      const sharedBinding = {
        version: 1 as const,
        sourceIdentity: "synthetic-session-source",
        playbackSettingsHash: "fixture-settings",
        upstreamProcessingHash: "fixture-chain",
        routingHash: "fixture-routing",
        dependencyScope: "unknown" as const,
      };
      await repository.appendPass(
        buildListeningPublication({
          passId: sessionFixturePassId,
          owner: { ...ownership, agentId: "fixture-agent" },
          trace,
          requestedMode: "session",
          actualMode: "session",
          requestedRange: { startBeat: 0, endBeat: 4 },
          createdAt: timestamp,
          startedAt: timestamp,
          endedAt: "2026-10-12T00:00:02.000Z",
          observations: [sessionObservation],
          bindings: [
            {
              listenerId: sessionObservation.listenerId,
              deviceReference: "fixture-session-device",
              connectionEpoch: "fixture-session-epoch",
              version: sessionObservation.algorithm.version,
              attribution: "unknown",
              primary: {
                id: "fixture-session-clip",
                ...ownership,
                kind: "clip",
                location: "session",
                trackId,
                binding: {
                  ...sharedBinding,
                  semanticLocator: {
                    name: target.expectedClipName,
                    trackId,
                    sceneIndex: 0,
                  },
                  previousRuntimeBindings: [target.expectedClipReference],
                },
              },
              contributors: [
                {
                  id: trackId,
                  ...ownership,
                  kind: "track",
                  location: "track",
                  trackId,
                  binding: {
                    ...sharedBinding,
                    semanticLocator: {
                      name: target.track.expectedName,
                      trackId,
                    },
                    previousRuntimeBindings: [target.track.expectedReference],
                  },
                },
              ],
            },
          ],
        }),
        { trace, activeAgentId: "fixture-agent" },
      );
    }
  } finally {
    await repository.close();
  }
}

export async function seedMixedListeningContext(
  profile: string,
): Promise<void> {
  await seedListeningContext(profile, true);
}
