import { describe, expect, it } from "vitest";
import { FakeAbletonService } from "./fake-ableton-service.js";

describe("fake listening inspection", () => {
  it("never invents verified Live evidence for unsimulated listeners", async () => {
    const service = new FakeAbletonService();
    await expect(
      service.inspectListeningContext({
        schemaVersion: 1,
        listeners: [
          {
            track: {
              kind: "regular",
              index: 0,
              expectedReference: "00000000-0000-4000-8000-000000000001",
              expectedName: "Audio",
            },
            deviceIndex: 0,
            expectedDeviceReference: "00000000-0000-4000-8000-000000000002",
            expectedDeviceName: "Listener",
            expectedClassName: "MxDeviceAudioEffect",
          },
        ],
        range: { startBeat: 0, endBeat: 8 },
      }),
    ).rejects.toThrow(/inspectListeningContext/);
    expect(service.started).toBe(false);
  });
});
