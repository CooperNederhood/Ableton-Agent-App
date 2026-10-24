import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INTEGRATION_DEVICE_INVENTORY,
  INTEGRATION_PAYLOAD_MANIFEST,
  MIDI_CAPTURE_PATH_PLACEHOLDER,
  readIntegrationDevicePayloads,
} from "./integration-device-payloads.js";
import { decodeAmxd, encodeAmxd, renderInstalledDevice } from "./max-device.js";
import type { MaxValue } from "./max-device.js";

const scratch = resolve(".test-artifacts/integration-payloads", randomUUID());
const generated = join(scratch, "generated");
beforeAll(async () => {
  await mkdir(scratch, { recursive: true });
  execFileSync(
    process.execPath,
    ["scripts/build-ableton-integrations.mjs", "--out", generated],
    { stdio: "pipe" },
  );
}, 30_000);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const path = join(scratch, randomUUID());
  await cp(generated, path, { recursive: true });
  return path;
}
async function manifestMutation(
  path: string,
  mutate: (manifest: {
    devices: {
      id: string;
      nativeVersion?: number;
      nativeAbiVersion?: number;
      files: { name: string; sha256: string; bytes: number }[];
    }[];
  }) => void,
): Promise<void> {
  const file = join(path, INTEGRATION_PAYLOAD_MANIFEST);
  const document = JSON.parse(await readFile(file, "utf8")) as Parameters<
    typeof mutate
  >[0];
  mutate(document);
  await writeFile(file, JSON.stringify(document));
}
async function rehash(
  path: string,
  id: string,
  name: string,
  raw: Buffer,
): Promise<void> {
  await writeFile(join(path, id, name), raw);
  await manifestMutation(path, (manifest) => {
    const file = manifest.devices
      .find((entry) => entry.id === id)!
      .files.find((entry) => entry.name === name)!;
    file.sha256 = createHash("sha256").update(raw).digest("hex");
    file.bytes = raw.length;
  });
}

describe("canonical integration payloads", () => {
  it("validates real generated dual-mode native4/ABI2 and portable MIDI inventories", async () => {
    const payloads = await readIntegrationDevicePayloads(generated);
    expect(payloads.map(({ id }) => id)).toEqual([
      "machine-listening",
      "midi-capture",
    ]);
    expect(payloads[0]).toMatchObject({
      nativeVersion: 4,
      nativeAbiVersion: 2,
      deviceFile: "Machine-Listening-Development.amxd",
    });
    expect(payloads[1]).toMatchObject({
      pathPlaceholder: MIDI_CAPTURE_PATH_PLACEHOLDER,
      deviceFile: "Midi-Capture.amxd",
    });
    for (const payload of payloads) {
      expect(payload.files.map(({ name }) => name).sort()).toEqual(
        [...INTEGRATION_DEVICE_INVENTORY[payload.id].files].sort(),
      );
      expect(
        payload.files.some(({ name }) =>
          /storage|receipt|token|secret/.test(name),
        ),
      ).toBe(false);
      const { document } = decodeAmxd(
        await readFile(join(payload.sourceDirectory, payload.deviceFile)),
      );
      expect(JSON.stringify(document)).not.toMatch(
        /mcp_bridge|m4l_mcp|\/Users\/|agent_signal_storage/,
      );
    }
  });

  it.each([undefined, 1, 2, 3, 5])(
    "rejects absent or wrong native version %s despite a complete inventory",
    async (version) => {
      const path = await fixture();
      await manifestMutation(path, ({ devices }) => {
        if (version === undefined) delete devices[0]!.nativeVersion;
        else devices[0]!.nativeVersion = version;
      });
      await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
        /version/,
      );
    },
  );
  it("rejects incorrect ABI and self-rehashed internal native versions", async () => {
    const path = await fixture();
    await manifestMutation(path, ({ devices }) => {
      devices[0]!.nativeAbiVersion = 1;
    });
    await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
      /version/,
    );
    const internal = await fixture();
    const raw = await readFile(
      join(internal, "machine-listening/audio-listener-manifest.json"),
      "utf8",
    );
    await rehash(
      internal,
      "machine-listening",
      "audio-listener-manifest.json",
      Buffer.from(raw.replace('"nativeVersion": 4', '"nativeVersion": 2')),
    );
    await expect(readIntegrationDevicePayloads(internal)).rejects.toThrow(
      /native manifest/,
    );
  });
  it.each(["missing", "tampered", "symlink", "oversize", "extra"])(
    "rejects %s companions and unmanifested files",
    async (kind) => {
      const path = await fixture();
      const file = join(path, "midi-capture/midi_capture_writer.js");
      if (kind === "missing") await rm(file);
      if (kind === "tampered") await writeFile(file, "// tampered");
      if (kind === "symlink") {
        await rm(file);
        await symlink(
          join(generated, "midi-capture/midi_capture_writer.js"),
          file,
        );
      }
      if (kind === "oversize")
        await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
      if (kind === "extra")
        await writeFile(
          join(path, "midi-capture/agent_signal_storage.js"),
          "profile credentials",
        );
      await expect(readIntegrationDevicePayloads(path)).rejects.toThrow();
    },
  );
  it("rejects device-directory symlinks, unsafe inventory and missing devices", async () => {
    const path = await fixture();
    await rm(join(path, "midi-capture"), { recursive: true });
    await symlink(join(generated, "midi-capture"), join(path, "midi-capture"));
    await expect(readIntegrationDevicePayloads(path)).rejects.toThrow();
    const unsafe = await fixture();
    await manifestMutation(unsafe, ({ devices }) => {
      devices[0]!.files[0]!.name = "../outside";
    });
    await expect(readIntegrationDevicePayloads(unsafe)).rejects.toThrow(
      /inventory/,
    );
    const missing = await fixture();
    await manifestMutation(missing, ({ devices }) => {
      devices.pop();
    });
    await expect(readIntegrationDevicePayloads(missing)).rejects.toThrow(
      /manifest/,
    );
  });
  it("checks native runtime wiring even after device hashes are recomputed", async () => {
    const path = await fixture();
    const name = "Machine-Listening-Development.amxd";
    const raw = await readFile(join(path, "machine-listening", name));
    const container = decodeAmxd(raw);
    const altered = JSON.parse(
      JSON.stringify(container.document).replace(
        "audio_listener_native_v4_max.js",
        "audio_listener_max.js",
      ),
    ) as MaxValue;
    await rehash(
      path,
      "machine-listening",
      name,
      encodeAmxd(container, altered),
    );
    await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
      /runtime entry/,
    );
    const missingLines = await fixture();
    const withoutLines = JSON.parse(JSON.stringify(container.document)) as {
      patcher: { lines: MaxValue[] };
    };
    withoutLines.patcher.lines = [];
    await rehash(
      missingLines,
      "machine-listening",
      name,
      encodeAmxd(container, withoutLines),
    );
    await expect(readIntegrationDevicePayloads(missingLines)).rejects.toThrow(
      /pass-through/,
    );
  });
  it.each(["mcp_bridge", "agent_signal_storage.js", "/Users/private/profile"])(
    "rejects self-rehashed nonportable device data %s",
    async (marker) => {
      const path = await fixture();
      const name = "Machine-Listening-Development.amxd";
      const container = decodeAmxd(
        await readFile(join(path, "machine-listening", name)),
      );
      it.each([
        { supportedModes: ["session"] },
        { supportedModes: ["arrangement"] },
        { modeNegotiation: "implicit" },
        { nativeScope: "session-transport-coupled/v1" },
        { realLiveValidated: true },
        {
          providerLimits: {
            durationMs: 60_000,
            maxWindows: 300,
            envelopeUpdatesPerSecond: 10,
          },
        },
      ])("rejects self-rehashed mode or resource claims %#", async (patch) => {
        const path = await fixture();
        const name = "audio-listener-manifest.json";
        const document = JSON.parse(
          await readFile(join(path, "machine-listening", name), "utf8"),
        ) as Record<string, unknown>;
        Object.assign(document, patch);
        await rehash(
          path,
          "machine-listening",
          name,
          Buffer.from(JSON.stringify(document)),
        );
        await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
          /native runtime metadata|native provider limits/,
        );
      });
      const document = JSON.parse(
        JSON.stringify(container.document).replace("ml_status_note", marker),
      ) as MaxValue;
      await rehash(
        path,
        "machine-listening",
        name,
        encodeAmxd(container, document),
      );
      await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
        /nonportable/,
      );
    },
  );
  it("denies canonical/root output and preserves unowned output content", async () => {
    const unowned = join(scratch, "unowned");
    await mkdir(unowned);
    await writeFile(join(unowned, "user-file.txt"), "preserve me");
    for (const path of [
      ".",
      "max-patches",
      "max-patches/audio-listener",
      unowned,
    ]) {
      expect(() =>
        execFileSync(
          process.execPath,
          ["scripts/build-ableton-integrations.mjs", "--out", path],
          { stdio: "pipe" },
        ),
      ).toThrow();
    }
    expect(await readFile(join(unowned, "user-file.txt"), "utf8")).toBe(
      "preserve me",
    );
  });
  it("requires MIDI placeholders in actual runtime entries, not unrelated strings", async () => {
    const path = await fixture();
    const name = "Midi-Capture.amxd";
    const container = decodeAmxd(
      await readFile(join(path, "midi-capture", name)),
    );
    const altered = JSON.parse(
      JSON.stringify(container.document).replace(
        `${MIDI_CAPTURE_PATH_PLACEHOLDER}/midi_capture_writer.js`,
        "midi_capture_writer.js",
      ),
    ) as MaxValue;
    await rehash(path, "midi-capture", name, encodeAmxd(container, altered));
    await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
      /runtime entry/,
    );
    const installed = renderInstalledDevice(
      container.document,
      "/portable/install",
      { pathPlaceholder: MIDI_CAPTURE_PATH_PLACEHOLDER },
    );
    expect(JSON.stringify(installed)).not.toContain(
      MIDI_CAPTURE_PATH_PLACEHOLDER,
    );
    expect(JSON.stringify(installed)).toContain(
      "/portable/install/midi_capture_writer.js",
    );
    expect(JSON.stringify(container.document)).toContain(
      MIDI_CAPTURE_PATH_PLACEHOLDER,
    );
  });
  it("replaces stale output without changing canonical sources or retaining profile state", async () => {
    const path = await fixture();
    const canonical = resolve(
      "max-patches/audio-listener/Machine-Listening-Development.amxd",
    );
    const midi = resolve("max-patches/midi-capture/Midi-Capture.amxd");
    const before = await Promise.all([readFile(canonical), readFile(midi)]);
    await writeFile(join(path, "stale-profile.js"), "secret");
    execFileSync(
      process.execPath,
      ["scripts/build-ableton-integrations.mjs", "--out", path],
      { stdio: "pipe" },
    );
    await expect(readIntegrationDevicePayloads(path)).resolves.toHaveLength(2);
    expect(await readdir(path)).not.toContain("stale-profile.js");
    expect(await Promise.all([readFile(canonical), readFile(midi)])).toEqual(
      before,
    );
  });
  it.each(["success", "cancelled", "failed"])(
    "emits bounded attributable %s lifecycle events and cleans staging",
    async (outcome) => {
      const path = await fixture();
      const events = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
      import { buildAbletonIntegrations } from "./scripts/build-ableton-integrations.mjs";
      import { readdirSync, writeFileSync } from "node:fs";
      import { dirname, basename, join } from "node:path";
      const controller = new AbortController();
      const events = [];
      try {
        await buildAbletonIntegrations(${JSON.stringify(path)}, {
          signal: controller.signal, traceId: "trace", correlationId: "correlation", causationId: "cause",
          onEvent(event) {
            if (event.operation !== "m4l.integrations.package") return;
            events.push(event);
            if (${JSON.stringify(outcome)} === "cancelled" && event.stage === "progress") controller.abort();
            if (${JSON.stringify(outcome)} === "failed" && event.stage === "progress") {
              const parent = dirname(${JSON.stringify(path)});
              const stage = readdirSync(parent).find(name => name.startsWith(basename(${JSON.stringify(path)}) + ".staged-"));
              writeFileSync(join(parent, stage, "machine-listening", "agent_signal_storage.js"), "forbidden profile");
            }
          },
        });
      } catch {}
      console.log(JSON.stringify(events));
    `,
          ],
          { encoding: "utf8" },
        ),
      ) as {
        operation: string;
        stage: string;
        durationMs: number;
        traceId: string;
        correlationId: string;
        causationId: string;
      }[];
      expect(events.slice(0, 2).map(({ stage }) => stage)).toEqual([
        "queued",
        "started",
      ]);
      expect(events.at(-1)?.stage).toBe(
        outcome === "success" ? "completed" : outcome,
      );
      for (const event of events) {
        expect(event).toMatchObject({
          operation: "m4l.integrations.package",
          traceId: "trace",
          correlationId: "correlation",
          causationId: "cause",
        });
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
        expect(event).not.toHaveProperty("payload");
      }
      expect(
        (await readdir(scratch)).some(
          (name) => name.includes(".staged-") || name.includes(".previous-"),
        ),
      ).toBe(false);
      await expect(readIntegrationDevicePayloads(path)).resolves.toHaveLength(
        2,
      );
    },
  );
});
