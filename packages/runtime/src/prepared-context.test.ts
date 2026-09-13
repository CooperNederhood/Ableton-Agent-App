import { InMemoryEventPublisher } from "@ableton-agent/shared";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { describe, expect, it, vi } from "vitest";

import { PreparedProjectContextStore } from "./prepared-context.js";

const connected = {
  state: "connected" as const,
  liveVersion: "12.1",
  remoteScriptVersion: "1.0.0",
  projectId: "project-1",
};

const snapshot = {
  tempo: 124,
  timeSignature: { numerator: 4, denominator: 4 },
  isPlaying: true,
  trackCount: 2,
  tracks: [
    {
      index: 0,
      reference: "00000000-0000-4000-8000-000000000010",
      name: "Keys",
      kind: "midi" as const,
      color: null,
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      volume: 0.8,
      pan: 0,
      devices: [
        {
          index: 0,
          reference: "00000000-0000-4000-8000-000000000030",
          name: "Instrument Rack",
          className: "InstrumentGroupDevice",
          classDisplayName: "Instrument Rack",
          enabled: true,
          parameterCount: 8,
        },
        {
          index: 1,
          reference: "00000000-0000-4000-8000-000000000031",
          name: "Echo",
          className: "Echo",
          classDisplayName: "Echo",
          enabled: true,
          parameterCount: 52,
        },
      ],
      devicesTruncated: false,
    },
    {
      index: 1,
      reference: "00000000-0000-4000-8000-000000000011",
      name: "Bass",
      kind: "audio" as const,
      color: null,
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      volume: 0.7,
      pan: 0,
      devices: [],
      devicesTruncated: false,
    },
  ],
  clips: [
    {
      reference: "00000000-0000-4000-8000-000000000020",
      trackReference: "00000000-0000-4000-8000-000000000010",
      trackIndex: 0,
      sceneIndex: 0,
      name: "Keys Verse",
      kind: "midi" as const,
      length: 4,
      noteCount: 8,
    },
    {
      reference: "00000000-0000-4000-8000-000000000021",
      trackReference: "00000000-0000-4000-8000-000000000011",
      trackIndex: 1,
      sceneIndex: 0,
      name: "Bass Verse",
      kind: "audio" as const,
      length: 4,
      noteCount: null,
    },
  ],
};

describe("PreparedProjectContextStore", () => {
  it("deduplicates refreshes and materializes context per listener binding", async () => {
    const inspectSession = vi.fn(async () => snapshot);
    const store = new PreparedProjectContextStore({
      events: new InMemoryEventPublisher(),
      getAbletonStatus: async () => connected,
      inspectSession,
      getProjectRevision: () => 7,
      now: () => new Date("2026-08-30T20:00:00.000Z"),
    });

    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);

    const keys = store.getPreparedContext("agent-1", {
      id: "event-listener.00000000-0000-4000-8000-000000000001",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      enabled: true,
      responseMode: "automatic",
      preparedContext: {
        scope: "selected-tracks",
        tracks: [{ track: { name: "Keys", occurrence: 0 } }],
        includeSessionClips: true,
      },
    });
    const bass = store.getPreparedContext("agent-2", {
      id: "event-listener.00000000-0000-4000-8000-000000000002",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      enabled: true,
      responseMode: "automatic",
      preparedContext: {
        scope: "selected-tracks",
        tracks: [{ track: { name: "Bass", occurrence: 0 } }],
        includeSessionClips: false,
      },
    });

    expect(inspectSession).toHaveBeenCalledOnce();
    expect(keys).toContain('"name":"Keys"');
    expect(keys).toContain('"name":"Keys Verse"');
    expect(keys).toContain('"name":"Echo"');
    expect(keys).toContain('"parameterCount":52');
    expect(keys).not.toContain('"name":"Bass"');
    expect(keys).not.toContain('"volume"');
    expect(keys).not.toContain('"pan"');
    expect(keys).not.toContain('"noteCount"');
    expect(keys).not.toContain('"length"');
    expect(bass).toContain('"name":"Bass"');
    expect(bass).not.toContain('"name":"Keys"');
    expect(bass).not.toContain('"name":"Echo"');
    expect(bass).not.toContain("Bass Verse");
    expect(keys).toContain('"projectRevision":7');
    expect(keys).toContain('"identityPolicy":"guarded-exact-reference"');
  });

  it("serves stale facts immediately while scheduling one refresh", async () => {
    const events = new InMemoryEventPublisher();
    let now = new Date("2026-08-30T20:00:00.000Z");
    const inspectSession = vi.fn(async () => snapshot);
    const store = new PreparedProjectContextStore({
      events,
      getAbletonStatus: async () => connected,
      inspectSession,
      now: () => now,
      ttlMs: 100,
    });
    store.start();
    await store.warm();
    expect(store.getPreparedContext("agent-1")).toContain(
      '"freshness":"fresh"',
    );
    now = new Date("2026-08-30T20:00:01.000Z");

    const first = store.getPreparedContext("agent-1");
    const second = store.getPreparedContext("agent-1");

    expect(first).toContain('"freshness":"stale"');
    expect(first).toContain(
      "freshness describes mutable state age, not exact identity validity",
    );
    expect(first).toContain('"identityPolicy":"guarded-exact-reference"');
    expect(second).toBe(first);
    await vi.waitFor(() => expect(inspectSession).toHaveBeenCalledTimes(2));
    store.stop();
  });

  it("records bounded identity diagnostics without prepared context content", async () => {
    const recorded: TelemetryEventEnvelope[] = [];
    const store = new PreparedProjectContextStore({
      events: new InMemoryEventPublisher(),
      getAbletonStatus: async () => connected,
      inspectSession: async () => snapshot,
      getProjectRevision: () => 7,
      now: () => new Date("2026-08-30T20:00:00.000Z"),
      telemetry: { enqueue: (event) => recorded.push(event) },
    });
    await store.warm();

    store.getPreparedContext("agent-1");

    const materialized = recorded.find(
      ({ name }) => name === "project-context.cache.materialized",
    );
    expect(materialized?.attributes).toMatchObject({
      contextAgeMs: 0,
      projectRevision: 7,
      stateAgeExpired: false,
      selectedTrackCount: 2,
      deviceCount: 2,
      deviceListsTruncated: false,
      sessionClipCount: 2,
      hasExactTrackReferences: true,
      hasExactSessionClipReferences: true,
      tracksTruncated: false,
      sessionClipsTruncated: false,
      unresolvedTrackLocatorCount: 0,
    });

    expect(JSON.stringify(materialized)).not.toContain("Keys Verse");
    expect(JSON.stringify(materialized)).not.toContain(
      "00000000-0000-4000-8000-000000000020",
    );
  });

  it("invalidates and refreshes after an application-owned mutation event", async () => {
    const events = new InMemoryEventPublisher();
    const inspectSession = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        tracks: snapshot.tracks.map((track, index) =>
          index === 0
            ? {
                ...track,
                devices: [
                  ...(track.devices ?? []),
                  {
                    index: 2,
                    reference: "00000000-0000-4000-8000-000000000032",
                    name: "Auto Filter",
                    className: "AutoFilter",
                    classDisplayName: "Auto Filter",
                    enabled: true,
                    parameterCount: 18,
                  },
                ],
              }
            : track,
        ),
      });
    const store = new PreparedProjectContextStore({
      events,
      getAbletonStatus: async () => connected,
      inspectSession,
      refreshDebounceMs: 0,
    });
    store.start();
    await store.warm();

    events.publish({
      type: "ableton.project_mutated",
      command: "browser.load_item",
      requestId: "00000000-0000-4000-8000-000000000099",
      projectRevision: 8,
    });

    await vi.waitFor(() => expect(inspectSession).toHaveBeenCalledTimes(2));
    expect(store.getPreparedContext("agent-1")).toContain(
      '"name":"Auto Filter"',
    );
    store.stop();
  });

  it("reports unresolved and truncated identity sets as insufficient", async () => {
    const recorded: TelemetryEventEnvelope[] = [];
    const devices = Array.from({ length: 33 }, (_, index) => ({
      ...snapshot.tracks[0]!.devices[0]!,
      index,
      reference: `20000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
      name: `Device ${index}`,
    }));
    const tracks = Array.from({ length: 17 }, (_, index) => ({
      ...snapshot.tracks[0]!,
      index,
      reference: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      name: `Track ${index}`,
      devices: index === 0 ? devices : [],
      devicesTruncated: index === 0,
    }));
    const clips = Array.from({ length: 129 }, (_, index) => ({
      ...snapshot.clips[0]!,
      reference: `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      trackReference: tracks[0]!.reference,
      sceneIndex: index,
    }));
    const store = new PreparedProjectContextStore({
      events: new InMemoryEventPublisher(),
      getAbletonStatus: async () => connected,
      inspectSession: async () => ({
        ...snapshot,
        trackCount: tracks.length,
        tracks,
        clips,
      }),
      telemetry: { enqueue: (event) => recorded.push(event) },
    });
    await store.warm();

    const wholeSession = store.getPreparedContext("agent-1");
    const unresolved = store.getPreparedContext("agent-1", {
      id: "event-listener.00000000-0000-4000-8000-000000000003",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      enabled: true,
      responseMode: "automatic",
      preparedContext: {
        scope: "selected-tracks",
        tracks: [{ track: { name: "Missing", occurrence: 0 } }],
        includeSessionClips: true,
      },
    });

    expect(wholeSession).toContain('"tracksTruncated":true');
    expect(wholeSession).toContain('"sessionClipsTruncated":true');
    expect(wholeSession).toContain('"devicesTruncated":true');
    expect(wholeSession).toContain('"name":"Device 31"');
    expect(wholeSession).not.toContain('"name":"Device 32"');
    expect(unresolved).toContain(
      '"unresolvedTrackLocators":[{"name":"Missing","occurrence":0}]',
    );
    const materialized = recorded.filter(
      ({ name }) => name === "project-context.cache.materialized",
    );
    expect(materialized[0]?.attributes).toMatchObject({
      selectedTrackCount: 16,
      deviceCount: 32,
      deviceListsTruncated: true,
      sessionClipCount: 128,
      hasExactTrackReferences: true,
      hasExactSessionClipReferences: true,
      tracksTruncated: true,
      sessionClipsTruncated: true,
      unresolvedTrackLocatorCount: 0,
    });
    expect(materialized[1]?.attributes).toMatchObject({
      selectedTrackCount: 0,
      sessionClipCount: 0,
      hasExactTrackReferences: false,
      hasExactSessionClipReferences: false,
      tracksTruncated: false,
      sessionClipsTruncated: false,
      unresolvedTrackLocatorCount: 1,
    });
  });
});
