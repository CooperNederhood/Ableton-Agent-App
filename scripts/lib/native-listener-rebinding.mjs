import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export const NATIVE_LISTENER_EDIT = Object.freeze({
  action: "load-and-move",
  placement: "before",
  itemName: "Delay",
  initialDeviceIndex: 0,
  finalDeviceIndex: 1,
  registrationTimeoutMs: 8000,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyListenerInsertion(before, after, original, moved) {
  assert(
    original.binding.deviceIndex === 0 &&
      moved.binding.deviceIndex === 1 &&
      original.binding.expectedClassName === "MxDeviceAudioEffect" &&
      moved.binding.expectedClassName === "MxDeviceAudioEffect" &&
      original.binding.expectedDeviceReference ===
        moved.binding.expectedDeviceReference &&
      isDeepStrictEqual(original.binding.track, moved.binding.track) &&
      moved.enabled === true &&
      moved.pathAttestation?.deviceReference ===
        original.binding.expectedDeviceReference &&
      moved.pathAttestation?.canonicalDevicePath === moved.canonicalPath &&
      moved.canonicalPath ===
        original.canonicalPath.replace(/ devices 0$/, " devices 1"),
    "Edit did not retain the actual enabled listener at index 1",
  );
  const expected = globalThis.structuredClone(after);
  const track = expected.tracks.find(
    (item) => item.reference === original.binding.track.expectedReference,
  );
  const oldTrack = before.tracks.find(
    (item) => item.reference === original.binding.track.expectedReference,
  );
  assert(
    track &&
      oldTrack &&
      track.devicesTruncated === false &&
      oldTrack.devicesTruncated === false &&
      Array.isArray(track.devices) &&
      Array.isArray(oldTrack.devices) &&
      track.devices.length === oldTrack.devices.length + 1 &&
      track.devices[0].name === "Delay" &&
      track.devices[0].className === "Delay" &&
      track.devices[0].reference !== original.binding.expectedDeviceReference &&
      track.devices[1].reference === original.binding.expectedDeviceReference,
    "Exact Delay insertion and original listener identity were not independently observed",
  );
  track.devices.shift();
  track.devices.forEach((device, index) => {
    device.index = index;
  });
  const baseline = globalThis.structuredClone(before);
  delete baseline.isPlaying;
  delete expected.isPlaying;
  assert(
    isDeepStrictEqual(baseline, expected),
    "Unexpected Set mutation during listener edit",
  );
  assert(
    moved.upstreamDevices.length === 2 &&
      moved.upstreamDevices[0].reference ===
        after.tracks.find(
          (item) => item.reference === original.binding.track.expectedReference,
        ).devices[0].reference &&
      moved.upstreamDevices[1].reference ===
        original.binding.expectedDeviceReference &&
      moved.sessionOverride === false &&
      !moved.dependenciesTruncated &&
      !moved.clipsTruncated,
    `Moved listener source chain is not fully attested (devices=${moved.upstreamDevices.length}, dependenciesTruncated=${moved.dependenciesTruncated}, clipsTruncated=${moved.clipsTruncated}, sessionOverride=${moved.sessionOverride})`,
  );
}

/** Called only after the runner has qualified a first capture in its owned process. */
export async function insertBeforeNativeListener({
  ableton,
  service,
  original,
  listener,
  baseline,
  range,
  stage,
  now = Date.now,
  wait = delay,
}) {
  assert(
    original.binding.deviceIndex === 0 &&
      original.binding.track.kind === "regular" &&
      typeof ableton.loadBrowserItem === "function" &&
      typeof ableton.moveDevice === "function",
    "Reviewed insert-before fixture or supported Browser adapter is unavailable",
  );
  await stage("rebind-stop-for-edit", () => ableton.setPlaying(false));
  const inspect = (path) =>
    ableton.inspectListeningContext({
      schemaVersion: 1,
      bindingQueryId: randomUUID(),
      listeners: [{ canonicalPath: path }],
      range,
      maxClips: 32,
      maxParameters: 32,
    });
  const stopped = await stage("rebind-stopped-preflight", () =>
    inspect(original.canonicalPath),
  );
  assert(
    stopped.transport.playing === false &&
      stopped.transport.safeToStart &&
      Object.values(stopped.transport.recording).every(
        (value) => value === false,
      ) &&
      isDeepStrictEqual(stopped.listeners[0].binding, original.binding),
    "Edit requires stopped transport, recording off and the original exact listener",
  );
  const search = await stage("rebind-effect-discovery", () =>
    ableton.searchBrowser({
      query: "Delay",
      roots: ["audio_effects"],
      maxNodes: 256,
      maxResults: 32,
      maxDepth: 6,
      maxDurationMs: 250,
    }),
  );
  const matches = search.items.filter(
    (item) =>
      item.name === "Delay" &&
      item.root === "audio_effects" &&
      item.isBuiltInDevice &&
      item.isDevice &&
      item.isLoadable,
  );
  assert(matches.length === 1, "A unique supported built-in Delay is required");
  const item = matches[0];
  const loaded = await stage("rebind-load-effect", () =>
    ableton.loadBrowserItem({
      index: original.binding.track.index,
      expectedReference: original.binding.track.expectedReference,
      expectedName: original.binding.track.expectedName,
      expectedItemReference: item.reference,
      expectedItemRoot: item.root,
      expectedItemPath: item.path,
      expectedItemUri: item.uri,
      expectedItemName: item.name,
    }),
  );
  assert(
    loaded.verified === true &&
      loaded.addedDevicesTruncated === false &&
      loaded.reconfiguredDevicesTruncated === false &&
      loaded.reconfiguredDevices.length === 0 &&
      loaded.addedDevices.length === 1 &&
      loaded.addedDevices[0].name === "Delay" &&
      loaded.addedDevices[0].className === "Delay" &&
      loaded.addedDevices[0].reference !==
        original.binding.expectedDeviceReference,
    "Loading Delay did not add exactly one independently identified effect",
  );
  await stage("rebind-insert-before", async () => {
    const snapshot = await ableton.inspectSession();
    const track = snapshot.tracks.find(
      (item) => item.reference === original.binding.track.expectedReference,
    );
    assert(
      track?.devicesTruncated === false &&
        Array.isArray(track.devices) &&
        track.devices[0]?.reference ===
          original.binding.expectedDeviceReference,
      "Original listener moved unexpectedly while loading Delay",
    );
    const added = track.devices.filter(
      (device) => device.reference === loaded.addedDevices[0].reference,
    );
    assert(
      added.length === 1 &&
        added[0].name === "Delay" &&
        added[0].className === "Delay" &&
        added[0].index > 0,
      "Loaded Delay is not independently present after the original listener",
    );
    const expected = globalThis.structuredClone(snapshot);
    const expectedTrack = expected.tracks.find(
      (item) => item.reference === track.reference,
    );
    expectedTrack.devices = expectedTrack.devices.filter(
      (device) => device.reference !== added[0].reference,
    );
    expectedTrack.devices.forEach((device, index) => {
      device.index = index;
    });
    const baselineCopy = globalThis.structuredClone(baseline);
    delete expected.isPlaying;
    delete baselineCopy.isPlaying;
    assert(
      isDeepStrictEqual(expected, baselineCopy),
      "Unexpected Set mutation while loading Delay",
    );
    const exactTrack = {
      index: original.binding.track.index,
      expectedReference: original.binding.track.expectedReference,
      expectedName: original.binding.track.expectedName,
    };
    const result = await ableton.moveDevice({
      source: {
        kind: "track-device",
        track: exactTrack,
        device: {
          index: added[0].index,
          expectedReference: added[0].reference,
          expectedName: added[0].name,
        },
      },
      destination: { kind: "track", track: exactTrack, deviceIndex: 0 },
    });
    assert(
      result.verified === true &&
        result.deviceReference === added[0].reference &&
        result.after?.kind === "track-device" &&
        result.after.device.index === 0,
      "Delay move before the listener was not verified",
    );
  });
  const newPath = original.canonicalPath.replace(/ devices 0$/, " devices 1");
  const inspection = await stage("rebind-independent-placement", () =>
    inspect(newPath),
  );
  const moved = inspection.listeners[0];
  assert(
    inspection.transport.playing === false &&
      inspection.transport.safeToStart &&
      Object.values(inspection.transport.recording).every(
        (value) => value === false,
      ),
    "Transport or recording changed during the edit",
  );
  const snapshot = await stage("rebind-edit-postconditions", async () => {
    const snapshot = await ableton.inspectSession();
    verifyListenerInsertion(baseline, snapshot, original, moved);
    return snapshot;
  });
  const renewed = await stage("rebind-authenticated-registration", async () => {
    const deadline = now() + NATIVE_LISTENER_EDIT.registrationTimeoutMs;
    while (now() < deadline) {
      const inventory = service.inspectListeners();
      assert(
        inventory.length <= 128,
        "Listener inventory exceeded the bounded quota",
      );
      const candidates = inventory.filter(
        (entry) => entry.registration.deviceCanonicalPath === newPath,
      );
      assert(candidates.length <= 1, "Ambiguous moved listener registration");
      const current = candidates[0];
      if (
        current &&
        current.connectionId !== listener.connectionId &&
        current.producer.instanceId !== listener.producer.instanceId &&
        current.producer.producerId !== listener.producer.producerId &&
        current.registration.connectionEpoch !==
          listener.registration.connectionEpoch &&
        current.registration.trackCanonicalPath ===
          moved.pathAttestation.canonicalTrackPath &&
        current.producer.schemaVersion === listener.producer.schemaVersion &&
        current.registration.version === listener.registration.version &&
        current.registration.sampleRate === listener.registration.sampleRate &&
        current.registration.vectorSize === listener.registration.vectorSize &&
        current.phase === "idle" &&
        !inventory.some((entry) => entry.connectionId === listener.connectionId)
      )
        return globalThis.structuredClone(current);
      await wait(100);
    }
    throw new Error(
      "Listener placement registration did not refresh within 8000ms; no restart or retry",
    );
  });
  return {
    listener: renewed,
    target: moved,
    inspection,
    snapshot,
    canonicalPath: newPath,
  };
}
