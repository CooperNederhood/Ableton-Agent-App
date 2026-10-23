import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  insertBeforeNativeListener,
  NATIVE_LISTENER_EDIT,
  verifyListenerInsertion,
} from "./native-listener-rebinding.mjs";
import { reviewNativeScenario } from "./native-listening-runner.mjs";
import { createNativeScenarioApproval } from "./native-listening-verification.mjs";

const load = async () =>
  JSON.parse(
    await readFile(
      "integration/live-scenarios/native-descriptive-insert-before.json",
      "utf8",
    ),
  );

function fixture() {
  const binding = {
    track: {
      kind: "regular",
      index: 0,
      expectedReference: "track",
      expectedName: "Fixture",
    },
    deviceIndex: 0,
    expectedDeviceReference: "device",
    expectedDeviceName: "Listener",
    expectedClassName: "MxDeviceAudioEffect",
  };
  const original = { binding, canonicalPath: "live_set tracks 0 devices 0" };
  const moved = {
    binding: { ...binding, deviceIndex: 1 },
    canonicalPath: "live_set tracks 0 devices 1",
    enabled: true,
    pathAttestation: {
      canonicalDevicePath: "live_set tracks 0 devices 1",
      canonicalTrackPath: "live_set tracks 0",
      deviceReference: "device",
    },
    upstreamDevices: [{ reference: "delay" }, { reference: "device" }],
    sessionOverride: false,
    dependenciesTruncated: false,
    clipsTruncated: false,
  };
  const device = { index: 0, reference: "device", name: "Listener" };
  const before = {
    isPlaying: true,
    tracks: [
      {
        reference: "track",
        devices: [device],
        devicesTruncated: false,
      },
    ],
  };
  const after = {
    isPlaying: false,
    tracks: [
      {
        reference: "track",
        devices: [
          { index: 0, reference: "delay", name: "Delay", className: "Delay" },
          { ...device, index: 1 },
        ],
        devicesTruncated: false,
      },
    ],
  };
  const listener = {
    connectionId: "old",
    producer: {
      producerId: "old",
      instanceId: "old",
      schemaVersion: "audio-observation/v2",
    },
    registration: {
      deviceCanonicalPath: original.canonicalPath,
      trackCanonicalPath: "live_set tracks 0",
      connectionEpoch: "old",
      version: 2,
      sampleRate: 48000,
      vectorSize: 64,
    },
  };
  const renewed = {
    ...listener,
    connectionId: "new",
    producer: { ...listener.producer, producerId: "new", instanceId: "new" },
    registration: {
      ...listener.registration,
      connectionEpoch: "new",
      deviceCanonicalPath: moved.canonicalPath,
    },
    phase: "idle",
  };
  const transport = {
    playing: false,
    safeToStart: true,
    recording: { recordMode: false },
  };
  const ableton = {
    setPlaying: vi.fn(async () => {}),
    inspectListeningContext: vi.fn(async ({ listeners }) => ({
      transport,
      listeners:
        listeners[0].canonicalPath === original.canonicalPath
          ? [original]
          : [moved],
    })),
    searchBrowser: vi.fn(async () => ({
      items: [
        {
          name: "Delay",
          root: "audio_effects",
          isBuiltInDevice: true,
          isDevice: true,
          isLoadable: true,
          reference: "item",
          path: [],
          uri: "uri",
        },
      ],
    })),
    loadBrowserItem: vi.fn(async () => ({
      verified: true,
      addedDevicesTruncated: false,
      reconfiguredDevicesTruncated: false,
      reconfiguredDevices: [],
      addedDevices: [
        { index: 1, reference: "delay", name: "Delay", className: "Delay" },
      ],
    })),
    moveDevice: vi.fn(async () => ({
      verified: true,
      deviceReference: "delay",
      after: { kind: "track-device", device: { index: 0 } },
    })),
    inspectSession: vi
      .fn()
      .mockImplementationOnce(async () => ({
        ...after,
        tracks: [
          {
            ...after.tracks[0],
            devices: [
              { ...after.tracks[0].devices[1], index: 0 },
              { ...after.tracks[0].devices[0], index: 1 },
            ],
          },
        ],
      }))
      .mockImplementation(async () => after),
  };
  const service = { inspectListeners: vi.fn(() => [renewed]) };
  let time = 0;
  const stage = vi.fn(async (_name, operation) => operation());
  const run = () =>
    insertBeforeNativeListener({
      ableton,
      service,
      listener,
      original,
      baseline: before,
      range: { startBeat: 0, endBeat: 4 },
      stage,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
    });
  return {
    original,
    moved,
    before,
    after,
    ableton,
    service,
    listener,
    renewed,
    stage,
    run,
  };
}

describe("native listener edit scenario guard and deterministic verification", () => {
  it("admits only the reviewed two-phase mutation and exact budgets", async () => {
    const manifest = await load();
    expect(reviewNativeScenario(manifest)).toMatchObject({
      nativeVersion: 2,
      rebinding: true,
    });
    expect(manifest.setupContract.placementEdit).toEqual(NATIVE_LISTENER_EDIT);
    for (const mutate of [
      (m) => {
        m.setupContract.placementEdit.placement = "after";
      },
      (m) => {
        m.setupContract.placementEdit.itemName = "Echo";
      },
      (m) => {
        m.maxMutations = 3;
      },
      (m) => {
        m.maxToolCalls = 17;
      },
    ]) {
      const changed = globalThis.structuredClone(manifest);
      mutate(changed);
      expect(() => reviewNativeScenario(changed)).toThrow("Unreviewed");
    }
  });

  it("does not permit the second capture until the runner qualifies the edit and refreshes identity", async () => {
    const binding = {
      listenerId: "old",
      passIds: new Set(),
      contextIds: new Set(),
    };
    const approval = createNativeScenarioApproval(await load(), binding);
    const inspect = () =>
      approval.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      });
    const play = (id) =>
      approval.request({
        toolName: "ableton_listening",
        risk: "reversible",
        arguments: {
          action: "play-arrangement-and-listen",
          listenerIds: [id],
          startBeat: 0,
          endBeat: 4,
          maximumDurationMs: 8000,
        },
      });
    await inspect();
    expect(await play("old")).toBe(true);
    await inspect();
    expect(await play("old")).toBe(false);
    binding.listenerId = "new";
    binding.captureLimit = 2;
    expect(await play("old")).toBe(false);
    await inspect();
    expect(await play("new")).toBe(true);
    await inspect();
    expect(await play("new")).toBe(false);
  });

  it("stops, inserts before the original exact device, verifies independently and awaits a fresh registration", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.listener).toEqual(f.renewed);
    expect(result.target.binding.expectedDeviceReference).toBe("device");
    expect(f.ableton.setPlaying).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.ableton.moveDevice).toHaveBeenCalledExactlyOnceWith({
      source: {
        kind: "track-device",
        track: {
          index: 0,
          expectedReference: "track",
          expectedName: "Fixture",
        },
        device: { expectedReference: "delay", expectedName: "Delay", index: 1 },
      },
      destination: {
        kind: "track",
        deviceIndex: 0,
        track: {
          index: 0,
          expectedReference: "track",
          expectedName: "Fixture",
        },
      },
    });
    expect(f.ableton.loadBrowserItem).toHaveBeenCalledExactlyOnceWith({
      index: 0,
      expectedReference: "track",
      expectedName: "Fixture",
      expectedItemReference: "item",
      expectedItemRoot: "audio_effects",
      expectedItemPath: [],
      expectedItemUri: "uri",
      expectedItemName: "Delay",
    });
    expect(f.stage.mock.calls.map(([name]) => name)).toEqual([
      "rebind-stop-for-edit",
      "rebind-stopped-preflight",
      "rebind-effect-discovery",
      "rebind-load-effect",
      "rebind-insert-before",
      "rebind-independent-placement",
      "rebind-edit-postconditions",
      "rebind-authenticated-registration",
    ]);
  });

  it.each([
    "replace",
    "extra-edit",
    "wrong-class",
    "truncated",
    "missing-devices",
    "missing-completeness",
    "wrong-path",
    "wrong-source",
  ])(
    "refuses %s rather than accepting approximate device placement",
    (mode) => {
      const f = fixture();
      if (mode === "replace") f.moved.binding.expectedDeviceReference = "other";
      if (mode === "extra-edit") f.after.tracks.push({ reference: "extra" });
      if (mode === "wrong-class")
        f.after.tracks[0].devices[0].className = "Other";
      if (mode === "truncated") f.after.tracks[0].devicesTruncated = true;
      if (mode === "missing-devices") delete f.after.tracks[0].devices;
      if (mode === "missing-completeness")
        delete f.after.tracks[0].devicesTruncated;
      if (mode === "wrong-path") {
        f.moved.canonicalPath = "live_set tracks 1 devices 1";
        f.moved.pathAttestation.canonicalDevicePath = f.moved.canonicalPath;
      }
      if (mode === "wrong-source")
        f.moved.upstreamDevices[0].reference = "other";
      expect(() =>
        verifyListenerInsertion(f.before, f.after, f.original, f.moved),
      ).toThrow();
    },
  );

  it.each(["stale", "ambiguous", "old-still-live"])(
    "fails bounded registration recovery for %s, without restart or capture retry",
    async (mode) => {
      const f = fixture();
      f.service.inspectListeners.mockReturnValue(
        mode === "stale"
          ? [f.listener]
          : mode === "ambiguous"
            ? [f.renewed, f.renewed]
            : [f.listener, f.renewed],
      );
      await expect(f.run()).rejects.toThrow(
        mode === "ambiguous" ? "Ambiguous" : "8000ms",
      );
      expect(f.ableton.moveDevice).toHaveBeenCalledOnce();
      expect(f.service.inspectListeners.mock.calls.length).toBeLessThanOrEqual(
        80,
      );
    },
  );

  it("requests the existing bounded 32-parameter inspection for the added effect and listener", async () => {
    const f = fixture();
    f.ableton.inspectListeningContext.mockImplementation(async (params) => ({
      transport: {
        playing: false,
        safeToStart: true,
        recording: { recordMode: false },
      },
      listeners: [
        params.listeners[0].canonicalPath === f.original.canonicalPath
          ? f.original
          : { ...f.moved, dependenciesTruncated: params.maxParameters < 32 },
      ],
    }));
    await expect(f.run()).resolves.toHaveProperty("listener", f.renewed);
    expect(
      f.ableton.inspectListeningContext.mock.calls.every(
        ([params]) => params.maxParameters === 32,
      ),
    ).toBe(true);
  });

  it("does not insert while recording or if stopped-state proof is unavailable", async () => {
    const f = fixture();
    f.ableton.inspectListeningContext.mockResolvedValue({
      transport: {
        playing: false,
        safeToStart: false,
        recording: { recordMode: true },
      },
      listeners: [f.original],
    });
    await expect(f.run()).rejects.toThrow("recording off");
    expect(f.ableton.loadBrowserItem).not.toHaveBeenCalled();
    expect(f.ableton.moveDevice).not.toHaveBeenCalled();
  });

  it.each(["load", "move", "unexpected-edit"])(
    "preserves a partial edit and refuses second capture on %s failure",
    async (mode) => {
      const f = fixture();
      if (mode === "load")
        f.ableton.loadBrowserItem.mockRejectedValue(new Error("load failed"));
      if (mode === "move")
        f.ableton.moveDevice.mockRejectedValue(new Error("move failed"));
      if (mode === "unexpected-edit")
        f.ableton.inspectSession
          .mockReset()
          .mockResolvedValue({ ...f.after, tempo: 99 });
      await expect(f.run()).rejects.toThrow();
      expect(f.ableton.loadBrowserItem).toHaveBeenCalledOnce();
      if (mode !== "move") expect(f.ableton.moveDevice).not.toHaveBeenCalled();
      expect(f.service.inspectListeners).not.toHaveBeenCalled();
    },
  );

  it.each(["wrong-class", "multiple", "reconfigured", "truncated"])(
    "refuses %s load evidence before moving any device",
    async (mode) => {
      const f = fixture();
      const loaded = {
        verified: true,
        addedDevicesTruncated: mode === "truncated",
        reconfiguredDevicesTruncated: false,
        reconfiguredDevices:
          mode === "reconfigured" ? [{ reference: "device" }] : [],
        addedDevices: [
          {
            index: 1,
            reference: "delay",
            name: "Delay",
            className: mode === "wrong-class" ? "Other" : "Delay",
          },
        ],
      };
      if (mode === "multiple")
        loaded.addedDevices.push({
          ...loaded.addedDevices[0],
          reference: "extra",
        });
      f.ableton.loadBrowserItem.mockResolvedValue(loaded);
      await expect(f.run()).rejects.toThrow("exactly one");
      expect(f.ableton.moveDevice).not.toHaveBeenCalled();
      expect(f.service.inspectListeners).not.toHaveBeenCalled();
    },
  );
});
