import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySessionContextStore,
  CONTEXT_LIMITS,
  type ContextSubject,
  type EntityContextRepository,
} from "@ableton-agent/project-state";
import type { AudioObservation } from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixtureV2 } from "@ableton-agent/protocol/testing";
import { sanitizePersistedText } from "@ableton-agent/observability";
import {
  buildListeningPublication,
  persistListeningObservations,
  reserveListeningPublication,
  type ListeningPublicationInput,
} from "./listening-publication.js";

const stores: EntityContextRepository[] = [];
const owner = { sessionId: "session", liveSetId: "set", agentId: "agent" };
const trace = {
  traceId: "00000000-0000-4000-8000-000000000001",
  correlationId: "capture",
  causationId: "publication",
};
const timestamp = "2026-10-12T00:00:00.000Z";

const reservationInput = {
  passId: "reservation",
  owner,
  trace,
  request: {
    mode: "arrangement" as const,
    listenerIds: ["listener"],
    startBeat: 0,
    endBeat: 4,
    maximumDurationMs: 1000,
  },
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function fixture(): ListeningPublicationInput {
  const primary: ContextSubject = {
    id: "track-subject",
    sessionId: owner.sessionId,
    liveSetId: owner.liveSetId,
    kind: "track",
    location: "track",
    trackId: "track",
    binding: {
      version: 1,
      semanticLocator: { name: "Known source track", trackId: "track" },
      sourceIdentity: "runtime-only:track",
      playbackSettingsHash: "settings-inspected",
      upstreamProcessingHash: "upstream-inspected",
      routingHash: "routing-inspected",
      dependencyScope: "unknown",
      previousRuntimeBindings: ["bridge-track-reference"],
    },
  };
  const observation: AudioObservation = {
    schema: "audio-observation/v1",
    listenerId: "listener",
    passId: "pass",
    sampleRate: 48_000,
    startSample: 0,
    endSample: 96_000,
    startBeat: 0,
    endBeat: 4,
    complete: true,
    limitations: ["Synthetic publication fixture"],
    algorithm: {
      name: "synthetic",
      version: "1",
      windowSamples: 2048,
      hopSamples: 4800,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 6000 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
      timingUncertaintySamples: 64,
    },
    summaries: { peak: [0.5, 0.5], rmsDbfs: [-12, -12], centroidHz: 440 },
    samples: [],
    attacks: [],
    reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
  };
  return {
    passId: "pass",
    owner,
    trace,
    requestedMode: "arrangement",
    actualMode: "arrangement",
    requestedRange: { startBeat: 0, endBeat: 4 },
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: "2026-10-12T00:00:02.000Z",
    observations: [observation],
    bindings: [
      {
        listenerId: "listener",
        deviceReference: "device",
        connectionEpoch: "epoch",
        version: "1",
        primary,
        contributors: [],
        attribution: "unknown",
      },
    ],
  };
}

function sessionFixture(): ListeningPublicationInput {
  const base = fixture();
  const trackReference = "00000000-0000-4000-8000-000000000002";
  const clipReference = "00000000-0000-4000-8000-000000000003";
  const track = {
    ...base.bindings[0]!.primary,
    id: "track",
    binding: {
      ...base.bindings[0]!.primary.binding,
      previousRuntimeBindings: [trackReference],
    },
  };
  return {
    ...base,
    requestedMode: "session",
    actualMode: "session",
    observations: [
      {
        ...createSyntheticNativeListeningFixtureV2({ listenerId: "listener" })
          .observation,
        schema: "session-audio-observation/v1",
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
            sceneIndex: 2,
            expectedClipReference: clipReference,
            expectedClipName: "Clip",
          },
          kind: "midi",
          coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
          transport: { startBeat: 100, endBeat: 104 },
          origin: {
            evidence: "message-rate-start-time-with-native-transport",
            clipStartTimeBeats: 100,
            observedAtGlobalBeat: 100.1,
          },
          continuity: {
            evidence: "message-rate-monitored",
            followActions: "disabled",
          },
        },
      },
    ],
    bindings: [
      {
        ...base.bindings[0]!,
        primary: {
          ...track,
          id: "clip",
          kind: "clip",
          location: "session",
          binding: {
            ...track.binding,
            semanticLocator: { name: "Clip", trackId: "track", sceneIndex: 2 },
            previousRuntimeBindings: [clipReference],
          },
        },
        contributors: [track],
      },
    ],
  };
}

async function repository(sessionId = owner.sessionId) {
  const store = await createInMemorySessionContextStore({
    sessionId,
    liveSetId: owner.liveSetId,
  });
  stores.push(store);
  return store;
}

describe("atomic listening context publication", () => {
  it("uses exact Session references rather than raw names and redacts bounded source targets without changing caller quality", async () => {
    const base = sessionFixture();
    const observation = structuredClone(base.observations[0]!);
    if (observation.schema !== "session-audio-observation/v1")
      throw new Error("Expected Session observation");
    const rawClipName = `password=p ${"x".repeat(117)}`;
    const rawTrackName = `token=t ${"y".repeat(120)}`;
    observation.source.target.expectedClipName = rawClipName;
    observation.source.target.track.expectedName = rawTrackName;
    const binding = base.bindings[0]!;
    const input = {
      ...base,
      observations: [observation],
      bindings: [
        {
          ...binding,
          primary: {
            ...binding.primary,
            binding: {
              ...binding.primary.binding,
              semanticLocator: {
                ...binding.primary.binding.semanticLocator,
                name: sanitizePersistedText(rawClipName).slice(0, 128),
              },
            },
          },
        },
      ],
    };
    const before = structuredClone(input);
    expect(buildListeningPublication(input).entries[0]?.payload).toEqual(
      observation,
    );
    const store = await repository();
    const [entryId] = await persistListeningObservations(
      store,
      input,
      new AbortController().signal,
    );
    const entry = await store.getEntry(entryId!);
    if (entry?.payload.schema !== "session-audio-observation/v1")
      throw new Error("Expected Session entry");
    for (const name of [
      entry.payload.source.target.expectedClipName,
      entry.payload.source.target.track.expectedName,
    ]) {
      expect(name).toContain("[REDACTED]");
      expect(name.length).toBeLessThanOrEqual(128);
    }
    expect(entry.payload.alignment).toEqual(observation.alignment);
    const listed = await store.listEntries({
      kind: "session-audio-observation/v1",
      includeHistorical: true,
    });
    expect(listed.items[0]?.payload).toEqual(
      expect.objectContaining({
        source: entry.payload.source,
        alignment: observation.alignment,
      }),
    );
    expect(JSON.stringify({ entry, listed })).not.toContain("password=p ");
    expect(JSON.stringify({ entry, listed })).not.toContain("token=t ");
    expect(input).toEqual(before);
  });

  it("preserves nominal requested duration and rounded actual coverage in storage and both coordinate links", async () => {
    const base = sessionFixture();
    const observation = structuredClone(base.observations[0]!);
    if (observation.schema !== "session-audio-observation/v1")
      throw new Error("Expected Session observation");
    const endBeat = (Math.round((4 * 60 * 44_100) / 128) * 128) / (60 * 44_100);
    observation.sampleRate = observation.alignment.sampleRate = 44_100;
    observation.endSample =
      observation.startSample + Math.round((4 * 60 * 44_100) / 128);
    observation.endBeat = observation.source.coordinate.endBeat = endBeat;
    observation.source.transport.endBeat = 100 + endBeat;
    observation.samples = [
      {
        ...observation.samples.at(-1)!,
        sample: observation.endSample,
        beat: endBeat,
      },
    ];
    observation.attacks = [];
    observation.reduction.originalSamples = 1;
    observation.reduction.originalAttacks = 0;
    const input = { ...base, observations: [observation] };
    const value = buildListeningPublication(input);
    expect(value.pass.requestedRange).toEqual({ startBeat: 0, endBeat: 4 });
    expect(value.pass.actualRange).toEqual({ startBeat: 0, endBeat });
    expect(value.links.map((link) => link.coverage.endBeat)).toEqual([
      endBeat,
      100 + endBeat,
    ]);
    const store = await repository();
    await persistListeningObservations(
      store,
      input,
      new AbortController().signal,
    );
    const persisted = (
      await store.listEntries({ kind: "session-audio-observation/v1" })
    ).items[0]!;
    expect((await store.getEntry(persisted.id))?.payload).toEqual(observation);
    expect((await store.getPass(base.passId))?.actualRange?.endBeat).toBe(
      endBeat,
    );
    expect(() =>
      buildListeningPublication({
        ...input,
        requestedRange: { startBeat: 0, endBeat },
      }),
    ).toThrow("playback coordinates");
  });

  it("publishes Session clip-local primary and global track coverage without claiming freshness", async () => {
    const input = sessionFixture();
    const value = buildListeningPublication(input);
    expect(value.pass.actualRange).toEqual({ startBeat: 0, endBeat: 4 });
    expect(value.links.map((link) => link.coverage)).toEqual([
      {
        coordinate: "clip-local-beats",
        iteration: 0,
        startBeat: 0,
        endBeat: 4,
      },
      { coordinate: "transport-beats", startBeat: 100, endBeat: 104 },
    ]);
    expect(
      value.links.every((link) => link.freshness.status === "unknown"),
    ).toBe(true);
    const store = await repository();
    await persistListeningObservations(
      store,
      input,
      new AbortController().signal,
    );
    expect(
      (await store.listEntries({ kind: "session-audio-observation/v1" }))
        .items[0]?.payload,
    ).toMatchObject({
      schema: "session-audio-observation/v1",
      source: { transport: { startBeat: 100, endBeat: 104 } },
      alignment: { verifiedAbsoluteErrorBoundSamples: null },
    });
  });

  it.each([
    "mode",
    "actual",
    "exclusive",
    "scene",
    "clip",
    "track",
    "missing",
    "owner",
  ] as const)(
    "rejects Session %s evidence before persisting anything",
    async (failure) => {
      const base = sessionFixture();
      const binding = structuredClone(base.bindings[0]!);
      if (failure === "scene")
        binding.primary.binding.semanticLocator.sceneIndex = 3;
      if (failure === "clip")
        binding.primary.binding.previousRuntimeBindings = ["unrelated"];
      if (failure === "track")
        binding.contributors[0]!.binding.previousRuntimeBindings = [
          "unrelated",
        ];
      if (failure === "owner") binding.primary.sessionId = "foreign";
      const input = {
        ...base,
        ...(failure === "mode"
          ? { requestedMode: "arrangement" as const }
          : {}),
        ...(failure === "actual" ? { actualMode: "arrangement" as const } : {}),
        bindings: [
          {
            ...binding,
            ...(failure === "exclusive"
              ? { attribution: "exclusive" as const }
              : {}),
            ...(failure === "missing" ? { contributors: [] } : {}),
          },
        ],
      };
      const store = await repository();
      await expect(
        persistListeningObservations(
          store,
          input,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(
        (await store.listEntries({ includeHistorical: true })).items,
      ).toEqual([]);
    },
  );

  it("publishes v2 without relabelling its kind, range or unknown accuracy", async () => {
    const base = fixture();
    const { observation } = createSyntheticNativeListeningFixtureV2({
      listenerId: "listener",
    });
    observation.endSample += 1;
    observation.endBeat += 1 / 24_000;
    observation.samples.push({
      ...observation.samples.at(-1)!,
      sample: observation.endSample,
      beat: observation.endBeat,
    });
    observation.reduction.originalSamples += 1;
    const input = {
      ...base,
      requestedRange: { startBeat: 0, endBeat: 4 + 0.6 / 24_000 },
      observations: [observation],
    };
    const value = buildListeningPublication(input);
    expect(value.entries[0]).toMatchObject({
      kind: "audio-observation/v2",
      payload: {
        schema: "audio-observation/v2",
        alignment: {
          alignment: "approximate",
          verifiedAbsoluteErrorBoundSamples: null,
        },
      },
    });
    expect(value.pass.requestedRange).toEqual(input.requestedRange);
    expect(value.pass.actualRange?.endBeat).toBe(observation.endBeat);
    expect(value.pass.actualRange?.endBeat).not.toBe(
      input.requestedRange.endBeat,
    );
    const store = await repository();
    await persistListeningObservations(
      store,
      input,
      new AbortController().signal,
    );
    const entries = await store.listEntries({
      kind: "audio-observation/v2",
      includeHistorical: true,
    });
    expect(entries.items).toHaveLength(1);
    expect(entries.items[0]?.payload).toMatchObject({
      schema: "audio-observation/v2",
      alignment: observation.alignment,
    });
  });

  it("refuses exclusive attribution for v2 rather than silently downgrading it", () => {
    const base = fixture();
    const input = {
      ...base,
      observations: [
        createSyntheticNativeListeningFixtureV2({
          listenerId: "listener",
        }).observation,
      ],
      bindings: base.bindings.map((binding) => ({
        ...binding,
        attribution: "exclusive" as const,
      })),
    };
    expect(() => buildListeningPublication(input)).toThrow(
      "Approximate descriptive observations cannot certify exclusive attribution",
    );
  });

  it("reserves the bounded pass ceiling with caller attribution and releases once", async () => {
    const store = await repository();
    const reserve = vi.spyOn(store, "reservePass");
    const release = vi.spyOn(store, "releaseReservation");
    const signal = new AbortController().signal;
    const reservation = await reserveListeningPublication(store, {
      ...reservationInput,
      signal,
    });
    expect(reserve).toHaveBeenCalledWith(
      reservationInput.passId,
      CONTEXT_LIMITS.passBytes,
      { signal, trace, activeAgentId: owner.agentId },
    );
    expect(release).not.toHaveBeenCalled();
    await Promise.all([reservation.release(), reservation.release()]);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(reservationInput.passId, {
      trace,
      activeAgentId: owner.agentId,
    });
  });

  it("compensates a quota reservation that finishes after cancellation", async () => {
    const store = await repository();
    const controller = new AbortController();
    const original = store.reservePass.bind(store);
    vi.spyOn(store, "reservePass").mockImplementationOnce(async (...args) => {
      await original(...args);
      controller.abort(new Error("cancelled during reservation"));
    });
    const release = vi.spyOn(store, "releaseReservation");
    await expect(
      reserveListeningPublication(store, {
        ...reservationInput,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled during reservation");
    expect(release).toHaveBeenCalledOnce();
    await store.reservePass(reservationInput.passId, 1);
    await store.releaseReservation(reservationInput.passId);
  });

  it("rejects foreign owners and pre-cancelled requests before reservation", async () => {
    const store = await repository();
    const reserve = vi.spyOn(store, "reservePass");
    const controller = new AbortController();
    await expect(
      reserveListeningPublication(store, {
        ...reservationInput,
        owner: { ...owner, liveSetId: "foreign-set" },
        signal: controller.signal,
      }),
    ).rejects.toThrow("another session or Live Set");
    controller.abort(new Error("cancelled before reservation"));
    await expect(
      reserveListeningPublication(store, {
        ...reservationInput,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before reservation");
    expect(reserve).not.toHaveBeenCalled();
  });

  it("retains separate multi-tap observations and primary/contributing links without inventing freshness", async () => {
    const input = fixture();
    const binding = input.bindings[0]!;
    const first = input.observations[0]!;
    const clip: ContextSubject = {
      ...binding.primary,
      id: "clip-subject",
      kind: "clip",
      location: "arrangement",
    };
    const publication = buildListeningPublication({
      ...input,
      observations: [first, { ...first, listenerId: "second" }],
      bindings: [
        { ...binding, contributors: [clip], attribution: "mixed" },
        { ...binding, listenerId: "second", deviceReference: "second-device" },
      ],
    });
    expect(publication.entries).toHaveLength(2);
    expect(publication.subjects).toHaveLength(2);
    expect(publication.links).toHaveLength(3);
    expect(
      publication.entries.map(({ producer }) => producer.listenerId),
    ).toEqual(["listener", "second"]);
    expect(
      publication.links.every(
        ({ freshness }) => freshness.status === "unknown",
      ),
    ).toBe(true);
    expect(
      publication.links.filter(
        ({ relationship }) => relationship === "contributor",
      ),
    ).toMatchObject([{ subjectId: clip.id, attribution: "mixed" }]);
    const store = await repository();
    await store.appendPass(publication, {
      trace,
      activeAgentId: owner.agentId,
    });
    expect(
      (await store.listEntries({ includeHistorical: true })).items,
    ).toHaveLength(2);
  });

  it("returns committed entry IDs with exact invoking owner and trace", async () => {
    const input = fixture();
    const store = await repository();
    const append = vi.spyOn(store, "appendPass");
    const signal = new AbortController().signal;
    const ids = await persistListeningObservations(store, input, signal);
    expect(ids).toHaveLength(1);
    expect(append).toHaveBeenCalledWith(expect.any(Object), {
      signal,
      trace,
      activeAgentId: owner.agentId,
    });
    expect(await store.getEntry(ids[0]!)).toMatchObject({
      passId: input.passId,
      sessionId: owner.sessionId,
      producer: {
        agentId: owner.agentId,
        deviceId: "device",
        connectionEpoch: "epoch",
      },
      trace,
    });
  });

  it("denies cross-session repositories or subjects before publication", async () => {
    const input = fixture();
    const other = await repository("other-session");
    await expect(
      persistListeningObservations(other, input, new AbortController().signal),
    ).rejects.toThrow("another session");
    const binding = input.bindings[0]!;
    expect(() =>
      buildListeningPublication({
        ...input,
        bindings: [
          {
            ...binding,
            primary: { ...binding.primary, liveSetId: "other-set" },
          },
        ],
      }),
    ).toThrow("another App session or Live Set");
    expect((await other.listPasses()).items).toHaveLength(0);
  });

  it("rejects missing/duplicate bindings, incomplete captures and conflicting subject evidence", () => {
    const input = fixture();
    const binding = input.bindings[0]!;
    const observation = input.observations[0]!;
    for (const invalid of [
      { ...input, bindings: [] },
      {
        ...input,
        observations: [observation, observation],
        bindings: [binding, binding],
      },
      { ...input, observations: [{ ...observation, complete: false }] },
      { ...input, observations: [{ ...observation, passId: "other-pass" }] },
      { ...input, observations: [{ ...observation, endSample: 0 }] },
      { ...input, bindings: [{ ...binding, contributors: [binding.primary] }] },
      {
        ...input,
        observations: [observation, { ...observation, listenerId: "second" }],
        bindings: [
          binding,
          {
            ...binding,
            listenerId: "second",
            primary: {
              ...binding.primary,
              binding: {
                ...binding.primary.binding,
                sourceIdentity: "replacement",
              },
            },
          },
        ],
      },
    ]) {
      expect(() => buildListeningPublication(invalid)).toThrow();
    }
  });

  it("does not publish after cancellation and surfaces persistence failures without receipts", async () => {
    const store = await repository();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before publication"));
    await expect(
      persistListeningObservations(store, fixture(), controller.signal),
    ).rejects.toThrow("cancelled before publication");
    expect((await store.listPasses()).items).toHaveLength(0);
    vi.spyOn(store, "appendPass").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    await expect(
      persistListeningObservations(
        store,
        fixture(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("disk unavailable");
    expect(
      (await store.listEntries({ includeHistorical: true })).items,
    ).toHaveLength(0);
  });
});
