import { describe, expect, it } from "vitest";

import {
  browserRootsMarkdown,
  devicesMarkdown,
  snapshotMarkdown,
  transportMarkdown,
} from "./presentation.js";

describe("structured CLI presentation", () => {
  it("builds a complete Ableton snapshot table", () => {
    const markdown = snapshotMarkdown({
      tempo: 128,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: true,
      trackCount: 1,
      tracks: [
        {
          index: 0,
          reference: "00000000-0000-4000-8000-000000000001",
          name: "DFAM-cap",
          kind: "audio",
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: true,
          volume: 0.8,
          pan: 0,
        },
      ],
      clips: [],
    });

    expect(markdown).toContain("128 BPM");
    expect(markdown).toContain("| 1 | DFAM-cap | audio |");
    expect(markdown).toContain("| yes |");
  });

  it("builds transport, device, and browser Markdown", () => {
    expect(
      transportMarkdown({
        loop: { enabled: false, start: 64, length: 64 },
        cuePoints: [
          {
            reference: "00000000-0000-4000-8000-000000000002",
            name: "test locator",
            time: 44,
          },
        ],
        totalCuePoints: 1,
        offset: 0,
        limit: 100,
      }),
    ).toContain("| 44 | test locator |");

    expect(
      devicesMarkdown(2, "DFAM-synth", {
        devices: [],
        total: 0,
        offset: 0,
        limit: 128,
      }),
    ).toContain("DFAM-synth");

    expect(
      browserRootsMarkdown({
        roots: [
          {
            reference: "00000000-0000-4000-8000-000000000003",
            root: "instruments",
            path: [],
            name: "Instruments",
            uri: "query:Synths",
            isFolder: false,
            isLoadable: false,
            isDevice: false,
            source: "",
            isBuiltInDevice: false,
          },
        ],
        cacheLimit: 512,
      }),
    ).toContain("| instruments | Instruments |");
  });
});
