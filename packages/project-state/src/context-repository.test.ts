import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  telemetryEventEnvelopeSchema,
  sanitizePersistedText,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";
import { type Database } from "sql.js";
import { createSyntheticNativeListeningFixtureV2 } from "@ableton-agent/protocol/testing";
import { loadSqlJs, SqliteProjectStateStore } from "./sqlite.js";
import { appSessionSchema } from "./schemas.js";
import { InMemoryProjectStateStore } from "./repository.js";
import {
  assessContextFreshness,
  CONTEXT_LIMITS,
  SESSION_CONTEXT_STORE_REFERENCE,
  sessionContextStoreReferenceSchema,
  type AppendContextPass,
  type ContextBindingEvidence,
  type ContextFreshnessAssessment,
} from "./context-schemas.js";
import {
  createInMemorySessionContextStore,
  openSessionContextStore,
  type SessionContextStore,
  type ContextOperationOptions,
} from "./context-repository.js";

const timestamp = "2026-10-12T00:00:00.000Z";
const trace = {
  traceId: "e1b8bc59-3c55-4b4e-844a-bf937759acdd",
  correlationId: "operation:1",
  causationId: "tool:1",
};
const ownership = { sessionId: "session:1", liveSetId: "set:1" };

function binding(): ContextBindingEvidence {
  return {
    version: 1,
    semanticLocator: { name: "Kick", trackId: "track:1", sceneIndex: 0 },
    sourceIdentity: "/Music/kick.wav",
    sourceContentHash: "content:1",
    playbackSettingsHash: "playback:1",
    upstreamProcessingHash: "upstream:1",
    routingHash: "routing:1",
    dependencyScope: "known",
    previousRuntimeBindings: ["runtime:1"],
  };
}

function publication(id = "1", listeners = 1): AppendContextPass {
  const passId = `pass:${id}`;
  const listenerIds = Array.from(
    { length: listeners },
    (_, index) => `listener:${index}`,
  );
  return {
    pass: {
      id: passId,
      ...ownership,
      initiatorAgentId: "agent:1",
      listenerIds,
      requestedMode: "session",
      actualMode: "session",
      requestedRange: { startBeat: 0, endBeat: 2 },
      actualRange: { startBeat: 0, endBeat: 2 },
      status: "completed",
      complete: true,
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: timestamp,
      interruptionReason: null,
      trace,
    },
    subjects: [
      {
        id: "subject:1",
        ...ownership,
        kind: "clip",
        trackId: "track:1",
        location: "session",
        binding: binding(),
      },
    ],
    entries: listenerIds.map((listenerId, index) => ({
      id: `entry:${id}:${index}`,
      ...ownership,
      passId,
      kind: "audio-observation/v1",
      producer: {
        listenerId,
        deviceId: `device:${index}`,
        agentId: "agent:1",
        connectionEpoch: "epoch:1",
        version: "1",
      },
      createdAt: timestamp,
      capturedAt: timestamp,
      trace,
      payload: {
        schema: "audio-observation/v1",
        listenerId,
        passId,
        sampleRate: 48_000,
        startSample: 0,
        endSample: 48_000,
        startBeat: 0,
        endBeat: 2,
        complete: true,
        limitations: [],
        algorithm: {
          name: "native",
          version: "1",
          windowSamples: 1_024,
          hopSamples: 512,
          settings: { attackThresholdDb: 6, minAttackSpacingSamples: 2_400 },
          units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
          timingUncertaintySamples: 64,
        },
        summaries: { peak: [0.5, 0.5], rmsDbfs: [-12, -12], centroidHz: 100 },
        samples: [
          {
            sample: 0,
            beat: 0,
            peak: [0.5, 0.5],
            rmsDbfs: [-12, -12],
            centroidHz: 100,
          },
        ],
        attacks: [{ sample: 1, beat: 0.01, strength: 0.5 }],
        reduction: { originalSamples: 1, originalAttacks: 1, truncated: false },
      },
    })),
    links: listenerIds.map((_, index) => ({
      id: `link:${id}:${index}`,
      ...ownership,
      entryId: `entry:${id}:${index}`,
      subjectId: "subject:1",
      relationship: "primary",
      coverage: { startBeat: 0, endBeat: 2 },
      attribution: "exclusive",
      observedContributorIds: [],
      sourceFingerprint: binding(),
      freshness: {
        status: "fresh",
        assessedAt: timestamp,
        reason: "Verified at capture",
      },
    })),
  };
}

const stores: SessionContextStore[] = [];
const roots: string[] = [];
async function memory(
  options: Parameters<typeof createInMemorySessionContextStore>[0] = ownership,
): Promise<SessionContextStore> {
  const store = await createInMemorySessionContextStore(options);
  stores.push(store);
  return store;
}
async function diskPath(): Promise<string> {
  const root = join(process.cwd(), `.test-context-${randomUUID()}`);
  await mkdir(root);
  roots.push(root);
  return join(root, "entity-context.sqlite");
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function descriptivePublication(id = "descriptive") {
  const legacy = publication(id);
  return {
    ...legacy,
    pass: {
      ...legacy.pass,
      requestedMode: "arrangement" as const,
      actualMode: "arrangement" as const,
    },
    entries: legacy.entries.map((entry) => ({
      ...entry,
      kind: "audio-observation/v2" as const,
      payload: createSyntheticNativeListeningFixtureV2({
        listenerId: entry.producer.listenerId,
        passId: entry.passId,
        endBeat: 2,
      }).observation,
    })),
    links: legacy.links.map((link) => ({
      ...link,
      attribution: "unknown" as const,
    })),
  };
}

function sessionPublication(endBeat = 2): AppendContextPass {
  const value = descriptivePublication("session");
  const clipReference = "00000000-0000-4000-8000-000000000001";
  const trackReference = "00000000-0000-4000-8000-000000000002";
  const clip = value.subjects[0]!;
  clip.id = "subject:session";
  clip.binding.previousRuntimeBindings = [clipReference];
  clip.binding.dependencyScope = "unknown";
  const track = {
    ...clip,
    id: "track:1",
    kind: "track" as const,
    location: "track" as const,
    binding: { ...clip.binding, previousRuntimeBindings: [trackReference] },
  };
  return {
    ...value,
    pass: {
      ...value.pass,
      requestedMode: "session",
      actualMode: "session",
      requestedRange: { startBeat: 0, endBeat: Math.min(endBeat, 4) },
      actualRange: { startBeat: 0, endBeat },
    },
    subjects: [clip, track],
    entries: value.entries.map((entry) => ({
      ...entry,
      kind: "session-audio-observation/v1",
      payload: {
        ...entry.payload,
        schema: "session-audio-observation/v1",
        endBeat,
        source: {
          view: "session",
          target: {
            view: "session",
            track: {
              kind: "regular",
              index: 0,
              expectedReference: trackReference,
              expectedName: "Track",
            },
            sceneIndex: 0,
            expectedClipReference: clipReference,
            expectedClipName: "Clip",
          },
          kind: "warped-audio",
          coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat },
          transport: { startBeat: 100, endBeat: 100 + endBeat },
          origin: {
            evidence: "message-rate-start-time-with-native-transport",
            clipStartTimeBeats: 100,
            observedAtGlobalBeat: 100.1,
          },
          continuity: {
            evidence: "message-rate-monitored",
            followActions: "unknown",
          },
        },
      },
    })),
    links: [
      {
        ...value.links[0]!,
        subjectId: clip.id,
        coverage: {
          coordinate: "clip-local-beats",
          iteration: 0,
          startBeat: 0,
          endBeat,
        },
        observedContributorIds: [track.id],
        freshness: {
          status: "unknown",
          assessedAt: timestamp,
          reason: "Historical evidence",
        },
      },
      {
        ...value.links[0]!,
        id: "link:track",
        subjectId: track.id,
        relationship: "contributor",
        coverage: {
          coordinate: "transport-beats",
          startBeat: 100,
          endBeat: 100 + endBeat,
        },
        sourceFingerprint: track.binding,
        observedContributorIds: [track.id],
        freshness: {
          status: "unknown",
          assessedAt: timestamp,
          reason: "Historical evidence",
        },
      },
    ],
  };
}

describe("typed descriptive context history", () => {
  it("reopens exact rounded Session coverage while rejecting oversized nominal requests", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    const value = sessionPublication(4.001);
    const invalid = structuredClone(value);
    invalid.pass.requestedRange.endBeat = 4.001;
    await expect(store.appendPass(invalid)).rejects.toThrow("local coverage");
    expect(await store.getPass(value.pass.id)).toBeUndefined();
    await store.appendPass(value);
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(
      (await reopened.getPass(value.pass.id))?.requestedRange.endBeat,
    ).toBe(4);
    expect((await reopened.getPass(value.pass.id))?.actualRange?.endBeat).toBe(
      4.001,
    );
    expect(
      (await reopened.getEntry(value.entries[0]!.id))?.payload.endBeat,
    ).toBe(4.001);
    expect(
      (await reopened.listLinks({ includeHistorical: true })).items.map(
        (link) => link.coverage.endBeat,
      ),
    ).toEqual([4.001, 104.001]);
  });

  it("retains old store references and registers both bounded observation kinds", () => {
    expect(
      sessionContextStoreReferenceSchema.parse({
        ...SESSION_CONTEXT_STORE_REFERENCE,
        kinds: ["audio-observation/v1"],
      }).kinds,
    ).toEqual(["audio-observation/v1"]);
    expect(SESSION_CONTEXT_STORE_REFERENCE.kinds).toEqual([
      "audio-observation/v1",
      "audio-observation/v2",
      "session-audio-observation/v1",
    ]);
    expect(
      sessionContextStoreReferenceSchema.safeParse({
        ...SESSION_CONTEXT_STORE_REFERENCE,
        kinds: ["audio-observation/v2", "audio-observation/v2"],
      }).success,
    ).toBe(false);
  });

  it("reopens additive Session history alongside unchanged legacy shapes with bounded sanitized summaries", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    await store.appendPass(publication("legacy"));
    await store.appendPass(descriptivePublication());
    const value = sessionPublication();
    const payload = value.entries[0]!.payload;
    if (payload.schema !== "session-audio-observation/v1")
      throw new Error("Expected Session payload");
    const rawClipName = `password=p ${"x".repeat(117)}`;
    const rawTrackName = `token=t ${"y".repeat(120)}`;
    payload.source.target.expectedClipName = rawClipName;
    payload.source.target.track.expectedName = rawTrackName;
    value.subjects[0]!.binding.semanticLocator.name = sanitizePersistedText(
      rawClipName,
    ).slice(0, 128);
    const quality = structuredClone(payload.alignment);
    value.entries[0]!.payload.limitations = [
      "Authorization: Bearer secret-session-token",
    ];
    await store.appendPass(value);
    const page = await store.listEntries({
      kind: "session-audio-observation/v1",
      includeHistorical: true,
    });
    expect(page.items[0]?.payload).toMatchObject({
      schema: "session-audio-observation/v1",
      alignment: { verifiedAbsoluteErrorBoundSamples: null },
      source: {
        coordinate: { unit: "beats", iteration: 0 },
        transport: { startBeat: 100, endBeat: 102 },
      },
    });
    expect(JSON.stringify(page)).not.toContain("secret-session-token");
    expect(page.items[0]?.payload).not.toHaveProperty("samples");
    expect(page.items[0]?.payload).toMatchObject({
      alignment: quality,
    });
    expect(JSON.stringify(page)).not.toContain("password=p ");
    expect(JSON.stringify(page)).not.toContain("token=t ");
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(
      (await reopened.listEntries({ includeHistorical: true })).items,
    ).toHaveLength(3);
    expect(
      (await reopened.getEntry(value.entries[0]!.id))?.payload.schema,
    ).toBe("session-audio-observation/v1");
    for (const retained of [
      page.items[0]?.payload,
      (await reopened.getEntry(value.entries[0]!.id))?.payload,
    ]) {
      if (retained?.schema !== "session-audio-observation/v1")
        throw new Error("Expected retained Session payload");
      expect(retained.alignment).toEqual(quality);
      for (const name of [
        retained.source.target.expectedClipName,
        retained.source.target.track.expectedName,
      ]) {
        expect(name).toContain("[REDACTED]");
        expect(name.length).toBeLessThanOrEqual(128);
        expect(name).not.toContain("password=p ");
        expect(name).not.toContain("token=t ");
      }
    }
    expect(
      (
        await reopened.listLinks({
          subjectId: "track:1",
          includeHistorical: true,
        })
      ).items[0]?.coverage,
    ).toEqual({ coordinate: "transport-beats", startBeat: 100, endBeat: 102 });
  });

  it.each([
    "coverage",
    "exclusive",
    "mode",
    "fresh",
    "binding",
    "cancelled",
    "quota",
  ] as const)(
    "rolls back Session %s violations without affecting legacy history",
    async (failure) => {
      const store = await memory();
      await store.appendPass(publication("legacy"));
      const value = sessionPublication();
      if (failure === "coverage")
        value.links[1]!.coverage = { startBeat: 0, endBeat: 2 };
      if (failure === "exclusive") value.links[0]!.attribution = "exclusive";
      if (failure === "mode") value.pass.actualMode = "arrangement";
      if (failure === "fresh") value.links[0]!.freshness.status = "fresh";
      if (failure === "binding")
        value.subjects[0]!.binding.previousRuntimeBindings = ["unrelated"];
      if (failure === "quota")
        value.entries[0]!.payload.limitations = [
          "x".repeat(CONTEXT_LIMITS.entryBytes),
        ];
      const controller = new AbortController();
      if (failure === "cancelled") controller.abort(new Error("cancelled"));
      await expect(
        store.appendPass(value, { signal: controller.signal }),
      ).rejects.toThrow();
      expect(
        (await store.listEntries({ includeHistorical: true })).items,
      ).toHaveLength(1);
    },
  );

  it("persists v1/v2 together and preserves approximate quality in typed summaries and reopened detail", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    await store.appendPass(publication("legacy"));
    const value = descriptivePublication();
    await store.appendPass(value);
    const page = await store.listEntries({
      kind: "audio-observation/v2",
      includeHistorical: true,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.payload).toMatchObject({
      schema: "audio-observation/v2",
      alignment: {
        alignment: "approximate",
        intendedUse: "descriptive-only",
        estimatedAbsoluteErrorSamples: null,
        verifiedAbsoluteErrorBoundSamples: null,
        policy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
      },
    });
    expect(page.items[0]?.payload).not.toHaveProperty("samples");
    expect(page.items[0]?.payload).not.toHaveProperty("attacks");
    expect(page.items[0]?.payload.algorithm).not.toHaveProperty(
      "timingUncertaintySamples",
    );
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(await reopened.getEntry(value.entries[0]!.id)).toEqual(
      value.entries[0],
    );
    expect((await reopened.getEntry("entry:legacy:0"))?.payload).toMatchObject({
      schema: "audio-observation/v1",
      algorithm: { timingUncertaintySamples: 64 },
    });
  });

  it.each(["kind", "exclusive", "incomplete", "cancelled"] as const)(
    "does not publish a descriptive %s violation",
    async (failure) => {
      const store = await memory();
      const value = descriptivePublication();
      const input =
        failure === "kind"
          ? {
              ...value,
              entries: value.entries.map((entry) => ({
                ...entry,
                kind: "audio-observation/v1" as const,
              })),
            }
          : failure === "exclusive"
            ? {
                ...value,
                links: value.links.map((link) => ({
                  ...link,
                  attribution: "exclusive" as const,
                })),
              }
            : value;
      if (failure === "incomplete") input.entries[0]!.payload.complete = false;
      const controller = new AbortController();
      if (failure === "cancelled") controller.abort(new Error("cancelled"));
      await expect(
        store.appendPass(input, {
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(await store.getPass(value.pass.id)).toBeUndefined();
      expect(await store.getEntry(value.entries[0]!.id)).toBeUndefined();
    },
  );
});

describe.each(["memory", "sqlite"] as const)(
  "session entity context (%s)",
  (adapter) => {
    async function store(): Promise<SessionContextStore> {
      if (adapter === "memory") return memory();
      const context = await openSessionContextStore({
        ...ownership,
        path: await diskPath(),
      });
      stores.push(context);
      return context;
    }

    it("publishes all listeners atomically, keeps immutable evidence, and returns bounded compact pages", async () => {
      const context = await store();
      const input = publication("1", 2);
      await context.appendPass(input);
      expect(await context.getPass(input.pass.id)).toEqual(input.pass);
      expect(await context.getEntry("entry:1:0")).toEqual(input.entries[0]);
      expect(await context.getSubject("subject:1")).toEqual(input.subjects[0]);
      expect((await context.getLink("link:1:0"))?.freshness.status).toBe(
        "unknown",
      );
      expect(
        (
          await context.listLinks({
            entryId: "entry:1:1",
            includeHistorical: true,
          })
        ).items.map((link) => link.id),
      ).toEqual(["link:1:1"]);
      expect(
        (await context.listPasses({ entryId: "entry:missing" })).items,
      ).toEqual([]);
      input.entries[0]!.payload.summaries.peak[0] = 1;
      expect(
        (await context.getEntry("entry:1:0"))?.payload.summaries.peak[0],
      ).toBe(0.5);
      await expect(context.appendPass(publication())).rejects.toThrow(
        "immutable",
      );
      const first = await context.listEntries({
        includeHistorical: true,
        limit: 1,
      });
      expect(first.items[0]?.payload).not.toHaveProperty("samples");
      expect(first.items[0]?.payload).not.toHaveProperty("attacks");
      expect(first.nextCursor).toBeDefined();
      const next = await context.listEntries({
        includeHistorical: true,
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(next.items[0]?.id).toBe("entry:1:1");
      expect(next.nextCursor).toBeUndefined();
      await expect(context.listEntries({ limit: 101 })).rejects.toThrow();
      await expect(
        context.listEntries({
          includeHistorical: true,
          limit: 2,
          cursor: first.nextCursor!,
        }),
      ).rejects.toThrow("cursor");
      expect(
        (
          await context.listPasses({
            listenerId: "listener:1",
            subjectId: "subject:1",
          })
        ).items,
      ).toHaveLength(1);
      expect(
        (
          await context.listEntries({
            range: { startBeat: 3, endBeat: 4 },
            includeHistorical: true,
          })
        ).items,
      ).toHaveLength(0);
    });

    it("rejects cross-session/Set, raw payloads, unknown kinds and inconsistent linkage without partial writes", async () => {
      const context = await store();
      for (const change of [
        "session",
        "set",
        "link",
        "listener",
        "raw",
        "kind",
        "agent",
        "trace",
        "coverage",
        "subject",
        "actual",
      ] as const) {
        const input = publication();
        if (change === "session") input.entries[0]!.sessionId = "session:2";
        if (change === "set") input.subjects[0]!.liveSetId = "set:2";
        if (change === "link") input.links[0]!.entryId = "entry:missing";
        if (change === "listener")
          input.entries[0]!.producer.listenerId = "listener:unknown";
        if (change === "raw")
          Object.assign(input.entries[0]!.payload, { rawAudio: "secret" });
        if (change === "kind")
          Object.assign(input.entries[0]!, { kind: "notes/v1" });
        if (change === "agent") input.entries[0]!.producer.agentId = "agent:2";
        if (change === "trace")
          input.entries[0]!.trace = { ...trace, correlationId: "operation:2" };
        if (change === "coverage") input.links[0]!.coverage.endBeat = 3;
        if (change === "subject") delete input.subjects[0]!.trackId;
        if (change === "actual") input.pass.actualRange = null;
        await expect(context.appendPass(input)).rejects.toThrow();
        expect(await context.getPass("pass:1")).toBeUndefined();
      }
      await context.appendPass(publication());
      const conflicting = publication("2", 2);
      conflicting.entries[1]!.id = "entry:1:0";
      await expect(context.appendPass(conflicting)).rejects.toThrow();
      expect(await context.getPass("pass:2")).toBeUndefined();
      expect(await context.getEntry("entry:2:0")).toBeUndefined();
    });

    it("prunes only explicit IDs, preserves other passes and cascades links/orphan subjects", async () => {
      const context = await store();
      await context.appendPass(publication("1", 2));
      await context.appendPass(publication("2"));
      await expect(context.prune({ trace })).rejects.toThrow("explicit");
      expect(await context.prune({ passIds: ["pass:1"], trace })).toEqual({
        deletedPasses: 1,
        deletedEntries: 2,
        deletedLinks: 2,
        deletedSubjects: 0,
      });
      expect(await context.getPass("pass:2")).toBeDefined();
      expect(await context.prune({ entryIds: ["entry:2:0"], trace })).toEqual({
        deletedPasses: 0,
        deletedEntries: 1,
        deletedLinks: 1,
        deletedSubjects: 1,
      });
      expect(await context.getPass("pass:2")).toBeDefined();
      expect(await context.getSubject("subject:1")).toBeUndefined();
      expect(
        (await context.listLinks({ includeHistorical: true })).items,
      ).toEqual([]);
    });

    it("redacts embedded credentials in every persisted free-text boundary", async () => {
      const context = await store();
      const input = publication();
      input.subjects[0]!.binding.semanticLocator.name =
        "Kick api_key=hidden-secret";
      input.subjects[0]!.binding.sourceIdentity =
        "https://alice:password@example.com/audio";
      input.links[0]!.sourceFingerprint = input.subjects[0]!.binding;
      input.links[0]!.freshness.reason = "Authorization: Bearer secret-auth";
      input.entries[0]!.payload.limitations = ["token=hidden-token"];
      input.entries[0]!.payload.algorithm.name = "password=hidden-password";
      await context.appendPass(input);
      const text = JSON.stringify([
        await context.getSubject("subject:1"),
        await context.getEntry("entry:1:0"),
        await context.listLinks({ includeHistorical: true }),
      ]);
      expect(text).toContain("[REDACTED]");
      for (const secret of [
        "hidden-secret",
        "alice:password",
        "secret-auth",
        "hidden-token",
        "hidden-password",
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  },
);

describe("context persistence lifecycle and recovery", () => {
  it("attributes every read to the invoking query, not the cached store opening context", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const openingTrace = {
      traceId: randomUUID(),
      correlationId: "open:1",
      causationId: "host:1",
    };
    const revalidationOptions: ContextOperationOptions[] = [];
    const context = await memory({
      ...ownership,
      trace: openingTrace,
      recorder: {
        enqueue: (event) => {
          events.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
      revalidate: async (subject, link, options) => {
        revalidationOptions.push(options);
        return {
          status: "fresh",
          assessedAt: timestamp,
          reason: `Verified ${subject.id}/${link.id}`,
        };
      },
    });
    await context.appendPass(publication());
    const reads = [
      [
        "get-pass",
        (options: ContextOperationOptions) =>
          context.getPass("pass:1", options),
      ],
      [
        "list-passes",
        (options: ContextOperationOptions) =>
          context.listPasses({ freshness: "fresh" }, options),
      ],
      [
        "get-entry",
        (options: ContextOperationOptions) =>
          context.getEntry("entry:1:0", options),
      ],
      [
        "list-entries",
        (options: ContextOperationOptions) => context.listEntries({}, options),
      ],
      [
        "get-subject",
        (options: ContextOperationOptions) =>
          context.getSubject("subject:1", options),
      ],
      [
        "get-link",
        (options: ContextOperationOptions) =>
          context.getLink("link:1:0", options),
      ],
      [
        "list-links",
        (options: ContextOperationOptions) => context.listLinks({}, options),
      ],
    ] as const;
    for (const agent of ["agent:query-a", "agent:query-b"]) {
      for (const [action, read] of reads) {
        const options = {
          trace: {
            traceId: randomUUID(),
            correlationId: `tool:${action}`,
            causationId: `request:${agent}`,
          },
          activeAgentId: agent,
        };
        await read(options);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const lifecycle = events.filter(
          (event) => event.trace?.traceId === options.trace.traceId,
        );
        expect(lifecycle.map((event) => event.name)).toEqual(
          ["queued", "started", "progress", "completed"].map(
            (stage) => `context.${action}.${stage}`,
          ),
        );
        expect(
          lifecycle.every(
            (event) =>
              event.activeAgentId === agent &&
              event.correlationId === options.trace.correlationId &&
              event.sessionId === ownership.sessionId &&
              event.liveSetId === ownership.liveSetId,
          ),
        ).toBe(true);
        expect(lifecycle[0]?.causationId).toBe(options.trace.causationId);
        for (let index = 1; index < lifecycle.length; index++) {
          expect(lifecycle[index]?.causationId).toBe(lifecycle[index - 1]?.id);
        }
        expect(lifecycle[1]?.durationMs).toBeGreaterThanOrEqual(0);
        expect(lifecycle.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
        expect(lifecycle[2]?.attributes.phase).toBe(
          "querying-and-revalidating",
        );
      }
    }
    expect(revalidationOptions).toHaveLength(8);
    expect(
      revalidationOptions.every(
        (options) =>
          options.trace?.traceId !== openingTrace.traceId &&
          ["agent:query-a", "agent:query-b"].includes(
            options.activeAgentId ?? "",
          ),
      ),
    ).toBe(true);
    expect(await context.getPass("pass:1")).toEqual(publication().pass);
    await expect(
      context.listEntries(
        { limit: 101 },
        {
          trace: openingTrace,
          activeAgentId: "agent:invalid-query",
        },
      ),
    ).rejects.toThrow();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(events.at(-1)?.name).toBe("context.list-entries.failed");
    expect(events.at(-1)?.activeAgentId).toBe("agent:invalid-query");
  });

  it("cancels queued reads before revalidation without attributing them to the preceding reader", async () => {
    const events: TelemetryEventEnvelope[] = [];
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => {
      entered!();
      await blocking;
      return { status: "fresh", assessedAt: timestamp, reason: "Verified" };
    });
    const context = await memory({
      ...ownership,
      revalidate,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await context.appendPass(publication());
    const first = context.getLink("link:1:0", {
      trace,
      activeAgentId: "agent:reader-a",
    });
    await started;
    const abort = new AbortController();
    const queuedTrace = {
      traceId: randomUUID(),
      correlationId: "query:queued",
      causationId: "tool:queued",
    };
    const queued = context.listLinks(
      {},
      {
        trace: queuedTrace,
        signal: abort.signal,
        activeAgentId: "agent:reader-b",
      },
    );
    const rejected = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    release!();
    await first;
    await rejected;
    expect(revalidate).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const lifecycle = events.filter(
      (event) => event.trace?.traceId === queuedTrace.traceId,
    );
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "cancelled",
    ]);
    expect(
      lifecycle.every((event) => event.activeAgentId === "agent:reader-b"),
    ).toBe(true);
    expect(await context.getPass("pass:1")).toBeDefined();
  });

  it.each(["get-link", "list-passes", "list-entries", "list-links"] as const)(
    "cancels %s during revalidation, releases the queue and removes cancellation listeners",
    async (action) => {
      const events: TelemetryEventEnvelope[] = [];
      let finish:
        ((assessment: ContextFreshnessAssessment) => void) | undefined;
      let entered: (() => void) | undefined;
      const blocking = new Promise<ContextFreshnessAssessment>((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const seen: ContextOperationOptions[] = [];
      const context = await memory({
        ...ownership,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
        revalidate: (_subject, _link, options) => {
          seen.push(options);
          entered!();
          return blocking;
        },
      });
      await context.appendPass(publication());
      const abort = new AbortController();
      const added = vi.spyOn(abort.signal, "addEventListener");
      const removed = vi.spyOn(abort.signal, "removeEventListener");
      const queryTrace = {
        traceId: randomUUID(),
        correlationId: "query:active",
        causationId: "tool:active",
      };
      const options = {
        trace: queryTrace,
        signal: abort.signal,
        activeAgentId: "agent:active-reader",
      };
      const pending =
        action === "get-link"
          ? context.getLink("link:1:0", options)
          : action === "list-passes"
            ? context.listPasses({ freshness: "fresh" }, options)
            : action === "list-entries"
              ? context.listEntries({}, options)
              : context.listLinks({}, options);
      await started;
      expect(seen[0]).toEqual(options);
      const rejected = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      abort.abort();
      await rejected;
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledTimes(1);
      expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1]);
      expect(await context.getPass("pass:1")).toBeDefined();
      await context.close();
      // A legacy two-argument revalidator may ignore cancellation and resolve after close.
      finish!({
        status: "fresh",
        assessedAt: timestamp,
        reason: "Late result",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const lifecycle = events.filter(
        (event) => event.trace?.traceId === queryTrace.traceId,
      );
      expect(lifecycle.map((event) => event.stage)).toEqual([
        "queued",
        "started",
        "progress",
        "cancelled",
      ]);
      expect(
        lifecycle.every(
          (event) => event.activeAgentId === "agent:active-reader",
        ),
      ).toBe(true);
    },
  );

  it("publishes the owning session registry/manifest before context, retrying failures and cancellation", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const publishSessionContext = vi.fn(async () => undefined);
    const context = await memory({
      ...ownership,
      publishSessionContext,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    publishSessionContext.mockRejectedValueOnce(
      new Error("session registry unavailable"),
    );
    await expect(context.appendPass(publication())).rejects.toThrow(
      "registry unavailable",
    );
    expect(await context.getPass("pass:1")).toBeUndefined();
    await context.appendPass(publication());
    expect(publishSessionContext).toHaveBeenCalledTimes(2);
    expect(publishSessionContext).toHaveBeenLastCalledWith({
      ...ownership,
      contextStore: SESSION_CONTEXT_STORE_REFERENCE,
      trace,
      activeAgentId: "agent:1",
    });
    await context.appendPass(publication("2"));
    expect(publishSessionContext).toHaveBeenCalledTimes(2);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const successfulStages = events
      .filter((event) => event.name.startsWith("context.session-publication."))
      .map((event) => event.stage);
    expect(successfulStages).toEqual([
      "queued",
      "started",
      "progress",
      "failed",
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    const publicationCompleted = events.findIndex(
      (event) => event.name === "context.session-publication.completed",
    );
    const contextCompleted = events.findIndex(
      (event) => event.name === "context.publish.completed",
    );
    expect(publicationCompleted).toBeLessThan(contextCompleted);
    const abort = new AbortController();
    const cancelled = await memory({
      ...ownership,
      publishSessionContext: async () => {
        abort.abort();
      },
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await expect(
      cancelled.appendPass(publication(), { signal: abort.signal }),
    ).rejects.toThrow();
    expect(await cancelled.getEntry("entry:1:0")).toBeUndefined();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(
      events.some(
        (event) => event.name === "context.session-publication.cancelled",
      ),
    ).toBe(true);
  });

  it("stores only a bounded context reference in existing App-session metadata repositories", async () => {
    const session = {
      id: randomUUID(),
      activeLiveSetId: randomUUID(),
      startedAt: timestamp,
      updatedAt: timestamp,
      contextStore: SESSION_CONTEXT_STORE_REFERENCE,
    };
    const memoryMetadata = new InMemoryProjectStateStore();
    await memoryMetadata.sessions.save(session);
    expect(await memoryMetadata.sessions.get(session.id)).toEqual(session);
    const path = await diskPath();
    const metadata = await SqliteProjectStateStore.open({ path });
    await metadata.sessions.save(session);
    await metadata.close();
    const reopened = await SqliteProjectStateStore.open({ path });
    try {
      expect(await reopened.sessions.get(session.id)).toEqual(session);
    } finally {
      await reopened.close();
    }
    expect(() =>
      appSessionSchema.parse({
        ...session,
        contextStore: {
          ...SESSION_CONTEXT_STORE_REFERENCE,
          relativePath: "/arbitrary/path",
        },
      }),
    ).toThrow();
    expect(() =>
      appSessionSchema.parse({
        ...session,
        contextStore: { ...SESSION_CONTEXT_STORE_REFERENCE, measurements: [1] },
      }),
    ).toThrow();
  });

  it("reopens durable evidence, prevents concurrent writers and rejects wrong ownership", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ path, ...ownership });
    stores.push(store);
    await store.appendPass(publication());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      openSessionContextStore({ path, ...ownership }),
    ).rejects.toThrow("already open");
    await store.close();
    await expect(
      openSessionContextStore({
        path,
        sessionId: "session:2",
        liveSetId: "set:1",
      }),
    ).rejects.toThrow("another");
    await expect(
      openSessionContextStore({
        path,
        sessionId: "session:1",
        liveSetId: "set:2",
      }),
    ).rejects.toThrow("another");
    const reopened = await openSessionContextStore({ path, ...ownership });
    stores.push(reopened);
    expect(await reopened.getEntry("entry:1:0")).toEqual(
      publication().entries[0],
    );
    expect(
      (await reopened.listLinks({ includeHistorical: true })).items[0]
        ?.freshness.status,
    ).toBe("unknown");
    expect((await reopened.listEntries({ freshness: "fresh" })).items).toEqual(
      [],
    );
    const independent = await memory({
      sessionId: "session:2",
      liveSetId: "set:1",
    });
    expect(await independent.getEntry("entry:1:0")).toBeUndefined();
    await reopened.close();
    await expect(reopened.getPass("pass:1")).rejects.toThrow("closed");
  });

  it("reports corruption without replacing the store and reclaims dead-owner locks", async () => {
    const path = await diskPath();
    await writeFile(path, "not sqlite");
    await expect(
      openSessionContextStore({ path, ...ownership }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("not sqlite");
    await writeFile(path, "");
    await expect(
      openSessionContextStore({ path, ...ownership }),
    ).rejects.toThrow("corrupt");
    await rm(path);
    await writeFile(`${path}.lock`, "99999999");
    const reopened = await openSessionContextStore({ path, ...ownership });
    stores.push(reopened);
    await reopened.appendPass(publication());
    await reopened.close();
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("enforces publication and physical quotas/reservations atomically, without implicit retention", async () => {
    const context = await memory({ ...ownership, maxPassBytes: 100 });
    await expect(context.appendPass(publication())).rejects.toThrow("quota");
    expect(await context.getPass("pass:1")).toBeUndefined();
    const physical = await memory({ ...ownership, maxStoreBytes: 160_000 });
    await physical.reservePass("pass:1", 20_000, { trace });
    await expect(physical.reservePass("pass:2", 100_000)).rejects.toThrow(
      "quota",
    );
    await physical.releaseReservation("pass:1", { trace });
    await physical.reservePass("pass:2", 30_000, { trace });
    await physical.appendPass(publication("2"));
    await expect(physical.reservePass("pass:2", 1)).rejects.toThrow();
    expect(await physical.getPass("pass:2")).toBeDefined();
    await expect(
      physical.reservePass("pass:3", CONTEXT_LIMITS.passBytes + 1),
    ).rejects.toThrow();
    const underReserved = await memory();
    await underReserved.reservePass("pass:1", 1);
    await expect(underReserved.appendPass(publication())).rejects.toThrow(
      "quota",
    );
    expect(await underReserved.getPass("pass:1")).toBeUndefined();
    await underReserved.releaseReservation("pass:1");
    await underReserved.appendPass(publication());
    const tooLarge = publication("3", 2);
    for (const entry of tooLarge.entries) {
      entry.payload.samples = Array.from({ length: 1_024 }, (_, sample) => ({
        sample,
        beat: sample / 1_024,
        peak: [0.513569821, 0.536914374],
        rmsDbfs: [-12.232592477, -12.237156224],
        centroidHz: 103.64682537,
      }));
      entry.payload.reduction.originalSamples = 1_024;
    }
    await expect(physical.appendPass(tooLarge)).rejects.toThrow("quota");
    expect(await physical.getPass("pass:3")).toBeUndefined();
    expect(await physical.getEntry("entry:3:0")).toBeUndefined();
    expect(await physical.getPass("pass:2")).toBeDefined();
  });

  it("rolls back in-memory evidence when atomic disk publication fails, and cleans staging files", async () => {
    const path = await diskPath();
    const context = await openSessionContextStore({ path, ...ownership });
    stores.push(context);
    await rm(path);
    await mkdir(path);
    await expect(context.appendPass(publication())).rejects.toThrow();
    expect(await context.getPass("pass:1")).toBeUndefined();
    expect(await readdir(dirname(path))).toEqual([
      "entity-context.sqlite",
      "entity-context.sqlite.lock",
    ]);
    await rm(path, { recursive: true });
    await context.appendPass(publication());
    expect(await context.getPass("pass:1")).toBeDefined();
  });

  it.each([publication, sessionPublication])(
    "records ordered attributed timing, failures and cancellation independently of journal state (%#)",
    async (makePublication) => {
      const events: TelemetryEventEnvelope[] = [];
      const context = await memory({
        ...ownership,
        recorder: {
          enqueue: (event) => {
            events.push(telemetryEventEnvelopeSchema.parse(event));
          },
        },
      });
      await context.appendPass(makePublication());
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const lifecycle = events.filter((event) =>
        event.name.startsWith("context.publish."),
      );
      expect(lifecycle.map((event) => event.stage)).toEqual([
        "queued",
        "started",
        "progress",
        "completed",
      ]);
      expect(
        lifecycle.every(
          (event) =>
            event.sessionId === ownership.sessionId &&
            event.activeAgentId === "agent:1" &&
            event.liveSetId === ownership.liveSetId &&
            event.trace?.traceId === trace.traceId &&
            event.correlationId === trace.correlationId,
        ),
      ).toBe(true);
      expect(lifecycle[0]?.causationId).toBe(trace.causationId);
      expect(lifecycle[1]?.causationId).toBe(lifecycle[0]?.id);
      expect(lifecycle.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
      const abort = new AbortController();
      abort.abort();
      await expect(
        context.appendPass(makePublication(), { signal: abort.signal }),
      ).rejects.toThrow();
      await expect(context.appendPass(makePublication())).rejects.toThrow(
        "immutable",
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(
        events.some((event) => event.name === "context.publish.cancelled"),
      ).toBe(true);
      expect(
        events.some((event) => event.name === "context.publish.failed"),
      ).toBe(true);
      expect(await context.getPass("pass:2")).toBeUndefined();
      const disabledJournal = await memory({
        ...ownership,
        recorder: {
          enqueue: () => {
            throw new Error("journal disabled");
          },
        },
      });
      await disabledJournal.appendPass(makePublication());
      expect(
        await disabledJournal.getPass(makePublication().pass.id),
      ).toBeDefined();
    },
  );

  it("revalidates current links and supports independent historical invalidation", async () => {
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => ({
      status: "fresh",
      assessedAt: timestamp,
      reason: "Verified current source",
    }));
    const context = await memory({ ...ownership, revalidate });
    await context.appendPass(publication());
    expect(
      (await context.listEntries({ freshness: "fresh" })).items,
    ).toHaveLength(1);
    expect(revalidate).toHaveBeenCalled();
    await context.assessLink(
      "link:1:0",
      { status: "stale", assessedAt: timestamp, reason: "Source replaced" },
      { trace },
    );
    expect((await context.getEntry("entry:1:0"))?.payload).toEqual(
      publication().entries[0]?.payload,
    );
    revalidate.mockImplementation(async () => ({
      status: "stale",
      assessedAt: timestamp,
      reason: "Source replaced",
    }));
    expect((await context.listEntries()).items).toHaveLength(0);
    expect(
      (
        await context.listEntries({
          includeHistorical: true,
          freshness: "stale",
        })
      ).items,
    ).toHaveLength(1);
    revalidate.mockRejectedValue(new Error("bridge unavailable"));
    expect(
      (await context.listLinks({ includeHistorical: true })).items[0]?.freshness
        .status,
    ).toBe("unknown");
  });

  it("serializes bounded work, cancels queued publication and still closes a full queue", async () => {
    let unblock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const context = await memory({
      ...ownership,
      maxPendingOperations: 2,
      revalidate: async () => {
        await blocker;
        return { status: "fresh", assessedAt: timestamp, reason: "Verified" };
      },
    });
    await context.appendPass(publication());
    const reading = context.listLinks();
    const abort = new AbortController();
    const pending = context.appendPass(publication("2"), {
      signal: abort.signal,
    });
    await expect(context.reservePass("pass:3", 100)).rejects.toThrow(
      "queue is full",
    );
    abort.abort();
    const rejected = expect(pending).rejects.toThrow();
    const closing = context.close();
    expect(context.close()).toBe(closing);
    unblock!();
    await reading;
    await rejected;
    await closing;
    await expect(context.getPass("pass:1")).rejects.toThrow("closed");
  });

  it("combines range/listener/freshness on the same link and bounds privileged revalidation work", async () => {
    const revalidate = vi.fn(
      async (
        subject: { id: string },
        link: { id: string },
      ): Promise<ContextFreshnessAssessment> => ({
        status: link.id === "link:1:1" ? "stale" : "fresh",
        assessedAt: timestamp,
        reason: `Verified ${subject.id}`,
      }),
    );
    const context = await memory({ ...ownership, revalidate });
    const input = publication("1", 2);
    input.links[0]!.coverage = { startBeat: 0, endBeat: 0.5 };
    input.links[1]!.coverage = { startBeat: 1, endBeat: 2 };
    await context.appendPass(input);
    expect(
      (
        await context.listPasses({
          range: { startBeat: 1, endBeat: 2 },
          freshness: "fresh",
          includeHistorical: true,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await context.listPasses({
          listenerId: "listener:1",
          freshness: "fresh",
          includeHistorical: true,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await context.listEntries({
          range: { startBeat: 1, endBeat: 2 },
          freshness: "stale",
          includeHistorical: true,
        })
      ).items.map((entry) => entry.id),
    ).toEqual(["entry:1:1"]);
    const many = publication("2", 8);
    const originalLinks = many.links;
    many.links = many.entries.flatMap((entry, index) =>
      Array.from({ length: 24 }, (_, link) => ({
        ...originalLinks[index]!,
        id: `link:2:${index}:${link}`,
        entryId: entry.id,
      })),
    );
    await context.appendPass(many);
    revalidate.mockClear();
    await context.listEntries({
      passId: "pass:2",
      freshness: "stale",
      includeHistorical: true,
    });
    expect(revalidate).toHaveBeenCalledTimes(
      CONTEXT_LIMITS.revalidationsPerQuery,
    );
  });

  it("preserves original provenance through explicit first-save ownership transitions and reopen", async () => {
    const path = await diskPath();
    const context = await openSessionContextStore({ path, ...ownership });
    stores.push(context);
    await context.appendPass(publication());
    await context.reservePass("pass:2", 5_000);
    await expect(
      context.transitionLiveSetOwnership("set:saved", { trace }),
    ).rejects.toThrow("reserved");
    await context.releaseReservation("pass:2");
    await context.transitionLiveSetOwnership("set:saved", { trace });
    expect(context.liveSetId).toBe("set:saved");
    expect((await context.getPass("pass:1"))?.liveSetId).toBe("set:1");
    expect((await context.getEntry("entry:1:0"))?.liveSetId).toBe("set:1");
    await expect(context.appendPass(publication("2"))).rejects.toThrow(
      "ownership",
    );
    const saved = publication("2");
    saved.subjects = [];
    for (const record of [saved.pass, ...saved.entries, ...saved.links])
      record.liveSetId = "set:saved";
    await context.appendPass(saved);
    await context.close();
    const resumed = await openSessionContextStore({
      ...ownership,
      liveSetId: "set:saved",
      path,
    });
    stores.push(resumed);
    expect(
      (await resumed.listPasses()).items.map((pass) => pass.liveSetId),
    ).toEqual(["set:1", "set:saved"]);
    expect((await resumed.getSubject("subject:1"))?.liveSetId).toBe("set:1");
  });

  it("migrates recognized context schemas, rejects future versions and records recovery failure", async () => {
    const path = await diskPath();
    const initial = await openSessionContextStore({ ...ownership, path });
    await initial.appendPass(publication());
    await initial.close();
    const sql = await loadSqlJs();
    async function mutate(
      operation: (database: Database) => void,
    ): Promise<void> {
      const database = new sql.Database(await readFile(path));
      operation(database);
      await writeFile(path, database.export());
      database.close();
    }
    await mutate((database) => {
      database.run(
        "DROP TABLE context_live_set_ownership; PRAGMA user_version = 1",
      );
    });
    const migrated = await openSessionContextStore({ ...ownership, path });
    expect(migrated.schemaVersion).toBe(2);
    expect(await migrated.getEntry("entry:1:0")).toBeDefined();
    await migrated.close();
    await mutate((database) => {
      database.run("PRAGMA user_version = 999");
    });
    const events: TelemetryEventEnvelope[] = [];
    await expect(
      openSessionContextStore({
        ...ownership,
        path,
        trace,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
      }),
    ).rejects.toThrow("unsupported");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(events.at(-1)?.name).toBe("context.open.failed");
    expect(events.at(-1)?.trace?.traceId).toBe(trace.traceId);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("dependency-scoped context freshness", () => {
  it("ignores rename/runtime IDs but detects exact source, playback, routing and upstream changes", () => {
    const captured = binding();
    const renamed = {
      ...binding(),
      semanticLocator: { ...binding().semanticLocator, name: "Renamed" },
      previousRuntimeBindings: ["new-runtime"],
    };
    expect(
      assessContextFreshness(captured, renamed, true, timestamp).status,
    ).toBe("fresh");
    for (const key of [
      "sourceIdentity",
      "sourceContentHash",
      "playbackSettingsHash",
      "upstreamProcessingHash",
      "routingHash",
    ] as const) {
      expect(
        assessContextFreshness(
          captured,
          { ...binding(), [key]: "changed" },
          true,
          timestamp,
        ).status,
      ).toBe("stale");
    }
    expect(
      assessContextFreshness(
        captured,
        {
          ...binding(),
          semanticLocator: { ...binding().semanticLocator, sceneIndex: 1 },
        },
        true,
        timestamp,
      ).status,
    ).toBe("stale");
    expect(
      assessContextFreshness(captured, binding(), false, timestamp).status,
    ).toBe("unresolved");
    expect(
      assessContextFreshness(captured, undefined, true, timestamp).status,
    ).toBe("unresolved");
    expect(
      assessContextFreshness(
        captured,
        { ...binding(), dependencyScope: "unknown" },
        true,
        timestamp,
      ).status,
    ).toBe("unknown");
    const noHash = binding();
    delete noHash.sourceContentHash;
    expect(
      assessContextFreshness(captured, noHash, true, timestamp).status,
    ).toBe("unknown");
  });
});
