import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const overrides = vi.hoisted(() => new Map());
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    readFile: vi.fn((path, options) => {
      const override = overrides.get(String(path));
      override?.onRead?.();
      return override?.bytes === undefined
        ? original.readFile(path, options)
        : Promise.resolve(Buffer.from(override.bytes));
    }),
  };
});

import { buildAbletonIntegrations } from "./build-ableton-integrations.mjs";
import { decodeAmxd, encodeAmxd } from "../packages/shared/dist/m4l-devices.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const midiSource = join(root, "max-patches", "midi-capture");
let directory;
let payload;

async function snapshot(directory) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      for (const [name, hash] of Object.entries(await snapshot(path)))
        files[`${entry.name}/${name}`] = hash;
    else
      files[entry.name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return files;
}

beforeAll(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "ableton-integrations-reuse-")),
  );
  payload = join(directory, "payload");
  await buildAbletonIntegrations(payload);
}, 30_000);

afterEach(() => {
  overrides.clear();
  vi.clearAllMocks();
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("identified integration payload reuse", () => {
  it("retains unchanged payload bytes and reports current MIDI source validation", async () => {
    const before = await snapshot(directory);
    const events = [];
    expect(
      await buildAbletonIntegrations(payload, {
        reuse: true,
        onEvent: (event) => events.push(event),
      }),
    ).toBe(payload);
    expect(await snapshot(directory)).toEqual(before);
    const validation = events.filter((event) =>
      event.name?.includes("midi-current-source-check."),
    );
    expect(validation.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    for (const [index, event] of validation.entries()) {
      expect(event.source).toBe("application");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.trace.traceId).toBe(events[0].traceId);
      if (index > 0) expect(event.causationId).toBe(validation[index - 1].id);
    }
  });

  it.each(["midi_capture_writer.js", "Midi-Capture.amxd"])(
    "rejects a canonical %s revision without rebuilding the existing bundle",
    async (name) => {
      const before = await snapshot(directory);
      const path = join(midiSource, name);
      const source = await readFile(path);
      let revised;
      if (name.endsWith(".amxd")) {
        const container = decodeAmxd(source);
        container.document.patcher.description = "Controlled source revision";
        revised = encodeAmxd(container, container.document);
      } else {
        revised = Buffer.concat([
          source,
          Buffer.from("\n// Source revision\n"),
        ]);
      }
      overrides.set(path, { bytes: revised });
      const events = [];
      await expect(
        buildAbletonIntegrations(payload, {
          reuse: true,
          traceId: "reuse-source-trace",
          correlationId: "reuse-source-correlation",
          causationId: "reuse-source-causation",
          onEvent: (event) => events.push(event),
        }),
      ).rejects.toThrow(`Current MIDI source differs from payload: ${name}`);
      expect(await snapshot(directory)).toEqual(before);
      expect(
        events.some((event) =>
          event.name?.endsWith("midi-current-source-check.failed"),
        ),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({
        stage: "failed",
        traceId: "reuse-source-trace",
        correlationId: "reuse-source-correlation",
        causationId: "reuse-source-causation",
      });
    },
  );

  it("cancels MIDI source checking without mutating the retained payload", async () => {
    const before = await snapshot(directory);
    const controller = new globalThis.AbortController();
    const events = [];
    overrides.set(join(midiSource, "midi_capture_writer.js"), {
      onRead: () => controller.abort(),
    });
    await expect(
      buildAbletonIntegrations(payload, {
        reuse: true,
        signal: controller.signal,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await snapshot(directory)).toEqual(before);
    expect(
      events
        .filter((event) => event.name?.includes("midi-current-source-check."))
        .map((event) => event.stage),
    ).toEqual(["queued", "started", "progress", "cancelled"]);
    expect(events.at(-1)).toMatchObject({ stage: "cancelled" });
  });
});
