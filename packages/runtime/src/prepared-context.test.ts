import { InMemoryEventPublisher } from "@ableton-agent/shared";
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
    expect(keys).not.toContain('"name":"Bass"');
    expect(keys).not.toContain('"volume"');
    expect(keys).not.toContain('"pan"');
    expect(keys).not.toContain('"noteCount"');
    expect(keys).not.toContain('"length"');
    expect(bass).toContain('"name":"Bass"');
    expect(bass).not.toContain('"name":"Keys"');
    expect(bass).not.toContain("Bass Verse");
    expect(keys).toContain('"projectRevision":7');
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
    expect(second).toBe(first);
    await vi.waitFor(() => expect(inspectSession).toHaveBeenCalledTimes(2));
    store.stop();
  });
});
