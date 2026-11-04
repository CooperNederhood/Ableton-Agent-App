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
import { FLUCOMA_DEPENDENCY_FILES } from "./flucoma-dependency.js";

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
      measurementDelivery?: string;
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
  it.each(["missing", "tampered", "self-rehashed", "linked-parent", "extra"])(
    "rejects %s FluCoMa dependency before installation",
    async (failure) => {
      const path = await fixture();
      const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755)!;
      const file = join(path, "machine-listening", pin.name);
      if (failure === "missing") await rm(file);
      if (failure === "tampered" || failure === "self-rehashed") {
        const bytes = await readFile(file);
        bytes[100] = bytes[100]! ^ 1;
        if (failure === "self-rehashed")
          await rehash(path, "machine-listening", pin.name, bytes);
        else await writeFile(file, bytes);
      }
      if (failure === "linked-parent") {
        const root = join(path, "machine-listening/dependencies");
        await rm(root, { recursive: true });
        await symlink(join(generated, "machine-listening/dependencies"), root);
      }
      if (failure === "extra")
        await writeFile(
          join(path, "machine-listening/dependencies/flucoma/unpinned.js"),
          "not authorized",
        );
      await expect(readIntegrationDevicePayloads(path)).rejects.toThrow();
    },
  );

  it.each([
    ["live.thisdevice", "loadbang"],
    ["pack dsp 0 0. 0", "pack dsp 0 0 0"],
    ["route adapter-started", "route ignored-startup"],
  ])("rejects self-rehashed startup substitution %s", async (from, to) => {
    const path = await fixture();
    const name = "Machine-Listening-Development.amxd";
    const container = decodeAmxd(
      await readFile(join(path, "machine-listening", name)),
    );
    const serialized = JSON.stringify(container.document);
    expect(serialized).toContain(from);
    const document = JSON.parse(serialized.replace(from, to)) as MaxValue;
    await rehash(
      path,
      "machine-listening",
      name,
      encodeAmxd(container, document),
    );
    await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
      /listening startup/,
    );
  });

  it("validates generated metric native5/ABI3, pinned codec provenance and portable MIDI inventories", async () => {
    const payloads = await readIntegrationDevicePayloads(generated);
    expect(payloads.map(({ id }) => id)).toEqual([
      "machine-listening",
      "midi-capture",
    ]);
    expect(payloads[0]).toMatchObject({
      nativeVersion: 5,
      nativeAbiVersion: 3,
      measurementDelivery: "independent-metric-timelines/v1",
      deviceFile: "Machine-Listening-Development.amxd",
    });
    expect(payloads[1]).toMatchObject({
      pathPlaceholder: MIDI_CAPTURE_PATH_PLACEHOLDER,
      deviceFile: "Midi-Capture.amxd",
    });
    const native = JSON.parse(
      await readFile(
        join(payloads[0]!.sourceDirectory, "audio-listener-manifest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(native).toMatchObject({
      nativeVersion: 5,
      nativeAbiVersion: 3,
      algorithmVersion: "3.0.0",
      realLiveValidated: false,
      metricProtocol: { schema: "native-metric-protocol-bundle/v1" },
    });
    expect(payloads[0]).toHaveProperty("metricProtocol", native.metricProtocol);
    expect(
      payloads[0]!.files.some(({ name }) =>
        /^audio_listener_(?:engine|runtime|max|native_(?:coordinates|assembler|controller|v[234]_max))\.js$/.test(
          name,
        ),
      ),
    ).toBe(false);
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

  it.each([undefined, 1, 2, 3, 4, 6])(
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
  it("returns a deeply immutable snapshot of validated compiler/input provenance", async () => {
    const payloads = await readIntegrationDevicePayloads(generated);
    const provenance = payloads[0]!.metricProtocol!;
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Object.isFrozen(provenance.compiler)).toBe(true);
    expect(Object.isFrozen(provenance.inputs)).toBe(true);
    expect(provenance.inputs.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(provenance, "sha256", "0".repeat(64))).toBe(false);
    expect(Reflect.set(provenance.inputs[0]!, "path", "../foreign")).toBe(
      false,
    );
  });
  it.each(["missing-codec", "retired-entry"])(
    "rejects incomplete or retired native resource inventory %s",
    async (kind) => {
      const path = await fixture();
      if (kind === "missing-codec")
        await rm(
          join(path, "machine-listening", "audio_listener_metric_protocol.js"),
        );
      else
        await manifestMutation(path, ({ devices }) => {
          const file = devices[0]!.files.find(
            ({ name }) => name === "audio_listener_native_v5_max.js",
          )!;
          file.name = "audio_listener_native_v4_max.js";
        });
      await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
        /inventory/,
      );
    },
  );
  it.each(["missing-provenance", "engineering-fixture"])(
    "denies invalid root production metadata %s before delivering install payloads",
    async (kind) => {
      const path = await fixture();
      await manifestMutation(path, ({ devices }) => {
        const entry = devices[0]! as Record<string, unknown>;
        if (kind === "missing-provenance") delete entry.metricProtocol;
        else
          entry.engineeringFixture = { id: "native5-unavailable-spectrum/v1" };
      });
      await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
        /metric protocol|native version/,
      );
    },
  );
  it("rejects a self-rehashed codec larger than the compiler output budget", async () => {
    const path = await fixture();
    const name = "audio-listener-manifest.json";
    const native = JSON.parse(
      await readFile(join(path, "machine-listening", name), "utf8"),
    ) as {
      metricProtocol: { sha256: string; bytes: number };
      resources: { name: string; sha256: string; bytes: number }[];
    };
    const raw = Buffer.alloc(4 * 1024 * 1024 + 1, 32);
    const identity = {
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
    };
    Object.assign(native.metricProtocol, identity);
    Object.assign(
      native.resources.find(
        ({ name }) => name === "audio_listener_metric_protocol.js",
      )!,
      identity,
    );
    await manifestMutation(path, ({ devices }) => {
      Object.assign(devices[0]!, { metricProtocol: native.metricProtocol });
    });
    await rehash(
      path,
      "machine-listening",
      "audio_listener_metric_protocol.js",
      raw,
    );
    await rehash(
      path,
      "machine-listening",
      name,
      Buffer.from(JSON.stringify(native)),
    );
    await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
      /metric protocol/,
    );
  });
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
      Buffer.from(raw.replace('"nativeVersion": 5', '"nativeVersion": 4')),
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
        "audio_listener_native_v5_max.js",
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
  it.each([
    { supportedModes: ["session"] },
    { supportedModes: ["arrangement"] },
    { modeNegotiation: "implicit" },
    { measurementDelivery: "latest-only" },
    { measurementDelivery: undefined },
    { measurementDelivery: "retention-v1" },
    { engineeringFixture: { id: "native5-unavailable-spectrum/v1" } },
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
      /native runtime metadata|native provider limits|canonical native manifest/,
    );
  });
  it.each([
    "missing",
    "foreign-schema",
    "wrong-codec-sha",
    "missing-inputs",
    "unbounded-input",
    "foreign-fields",
    "root-mismatch",
    "missing-lockfile",
    "missing-license",
    "wrong-byte-count",
    "foreign-compiler",
  ])(
    "rejects self-rehashed incomplete or mismatched metric protocol provenance %s",
    async (kind) => {
      const path = await fixture();
      const name = "audio-listener-manifest.json";
      const native = JSON.parse(
        await readFile(join(path, "machine-listening", name), "utf8"),
      ) as {
        metricProtocol?: {
          schema: string;
          sha256: string;
          inputs: { path: string; bytes: number; sha256: string }[];
        };
      };
      if (kind === "missing") delete native.metricProtocol;
      if (kind === "foreign-schema")
        native.metricProtocol!.schema = "unreviewed/v1";
      if (kind === "wrong-codec-sha")
        native.metricProtocol!.sha256 = "0".repeat(64);
      if (kind === "missing-inputs") native.metricProtocol!.inputs = [];
      if (kind === "unbounded-input")
        native.metricProtocol!.inputs[0]!.path = "../unreviewed";
      if (kind === "foreign-fields")
        Object.assign(native.metricProtocol!, {
          engineeringFixture: "native5-unavailable-spectrum/v1",
        });
      if (kind === "root-mismatch")
        await manifestMutation(path, (manifest) => {
          Object.assign(manifest.devices[0]!, {
            metricProtocol: {
              ...native.metricProtocol,
              sha256: "0".repeat(64),
            },
          });
        });
      if (kind === "missing-lockfile")
        Reflect.deleteProperty(native.metricProtocol!, "lockfileSha256");
      if (kind === "missing-license")
        Reflect.deleteProperty(native.metricProtocol!, "licenseSha256");
      if (kind === "wrong-byte-count")
        Object.assign(native.metricProtocol!, { bytes: 1 });
      if (kind === "foreign-compiler")
        Object.assign(native.metricProtocol!, {
          compiler: {
            name: "unreviewed",
            version: "1",
            format: "cjs",
            syntaxTarget: "es2020",
          },
        });
      await rehash(
        path,
        "machine-listening",
        name,
        Buffer.from(JSON.stringify(native)),
      );
      await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
        /metric protocol/,
      );
    },
  );
  it("rejects negative fixture code renamed to the production entry even after both manifests are rehashed", async () => {
    const path = await fixture();
    const entry = "audio_listener_native_v5_max.js";
    const raw = await readFile(
      resolve(
        "max-patches/audio-listener/audio_listener_native_v5_unavailable_spectrum_max.js",
      ),
    );
    const nativeFile = "audio-listener-manifest.json";
    const native = JSON.parse(
      await readFile(join(path, "machine-listening", nativeFile), "utf8"),
    ) as {
      resources: { name: string; sha256: string; bytes: number }[];
    };
    Object.assign(
      native.resources.find(({ name }) => name === entry)!,
      {
        sha256: createHash("sha256").update(raw).digest("hex"),
        bytes: raw.length,
      },
    );
    await rehash(path, "machine-listening", entry, raw);
    await rehash(
      path,
      "machine-listening",
      nativeFile,
      Buffer.from(JSON.stringify(native)),
    );
    await expect(readIntegrationDevicePayloads(path)).rejects.toThrow(
      /runtime version|runtime entry/,
    );
  });
  it.each([
    {
      engineeringOnly: true,
      engineeringFixture: "native5-unavailable-spectrum/v1",
    },
    { engineeringFixture: undefined },
    { spectrumEnabled: false },
    { nativeVersion: 4 },
    { nativeMode: false },
  ])(
    "production builder denies fixture/retired overrides before publication %#",
    async (options) => {
      const path = join(scratch, randomUUID());
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
      import { buildAbletonIntegrations } from "./scripts/build-ableton-integrations.mjs";
      const options = ${JSON.stringify(options)};
      if (${Object.hasOwn(options, "engineeringFixture") && options.engineeringFixture === undefined})
        options.engineeringFixture = undefined;
      try {
        await buildAbletonIntegrations(${JSON.stringify(path)}, {
          ...options,
        });
        console.log(JSON.stringify({ error: null }));
      } catch (error) { console.log(JSON.stringify({ error: error.message })); }
      `,
          ],
          { encoding: "utf8" },
        ),
      ) as { error: string | null };
      expect(result.error).toMatch(/fixture|native v5/);
      await expect(
        readFile(join(path, INTEGRATION_PAYLOAD_MANIFEST)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each(["mcp_bridge", "agent_signal_storage.js", "/Users/private/profile"])(
    "rejects self-rehashed nonportable device data %s",
    async (marker) => {
      const path = await fixture();
      const name = "Machine-Listening-Development.amxd";
      const container = decodeAmxd(
        await readFile(join(path, "machine-listening", name)),
      );
      const document = JSON.parse(
        JSON.stringify(container.document).replace(
          "Machine Listening - transparent stereo tap",
          marker,
        ),
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
    const canonical = resolve("max-patches/audio-listener/native-source.mjs");
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
  it.each(["success", "cancelled", "observer-failed"])(
    "owns bounded codec compilation %s lifecycle without an unowned compiler fallback",
    async (outcome) => {
      const path = await fixture();
      const before = await readFile(join(path, INTEGRATION_PAYLOAD_MANIFEST));
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { buildAbletonIntegrations } from "./scripts/build-ableton-integrations.mjs";
        const controller = new AbortController();
        const events = [];
        let failed = false;
        try {
          await buildAbletonIntegrations(${JSON.stringify(path)}, {
            signal: controller.signal,
            traceId: "private/profile/value", correlationId: "correlation", causationId: "cause",
            onEvent(event) {
              events.push(event);
              if (event.operation !== "m4l.integrations.stage") return;
              if (${JSON.stringify(outcome)} === "cancelled" && event.stage === "progress") controller.abort();
              if (${JSON.stringify(outcome)} === "observer-failed") throw new Error("private observer data");
            },
          });
        } catch { failed = true; }
        console.log(JSON.stringify({ events, failed }));
        `,
          ],
          { encoding: "utf8" },
        ),
      ) as {
        events: {
          operation: string;
          stage: string;
          name?: string;
          trace?: { traceId: string };
          attributes?: Record<string, unknown>;
        }[];
        failed: boolean;
      };
      const compiler = result.events.filter(
        ({ operation, name }) =>
          operation === "m4l.integrations.stage" &&
          name?.startsWith(
            "integration.native_listening.native-metric-protocol-compile.",
          ),
      );
      expect(compiler.map(({ stage }) => stage)).toEqual([
        "queued",
        "started",
        "progress",
        outcome === "cancelled" ? "cancelled" : "completed",
      ]);
      expect(result.failed).toBe(outcome === "cancelled");
      const dependency = result.events.filter(
        ({ operation, name }) =>
          operation === "m4l.integrations.stage" &&
          name?.startsWith(
            "integration.native_listening.flucoma-dependency-check.",
          ),
      );
      expect(dependency.map(({ stage }) => stage)).toEqual(
        outcome === "cancelled"
          ? []
          : ["queued", "started", "progress", "completed"],
      );
      for (const event of dependency) {
        expect(event.attributes).toEqual({
          dependency: "flucoma-spectralshape",
          version: "1.0.10",
        });
        expect(event.trace?.traceId).toMatch(/^[0-9a-f-]{36}$/);
      }
      for (const event of compiler) {
        expect(event.name).toMatch(
          /^integration\.native_listening\.native-metric-protocol-compile\./,
        );
        expect(event.attributes).toMatchObject({
          artifact: "audio_listener_metric_protocol.js",
          syntaxTarget: "es2020",
        });
        expect(event.trace?.traceId).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.stringify(event).length).toBeLessThan(2048);
      }
      expect(JSON.stringify(result.events)).not.toMatch(
        /private\/profile|private observer data/,
      );
      if (outcome === "cancelled")
        expect(
          await readFile(join(path, INTEGRATION_PAYLOAD_MANIFEST)),
        ).toEqual(before);
      await expect(readIntegrationDevicePayloads(path)).resolves.toHaveLength(
        2,
      );
      expect(
        (await readdir(scratch)).some((name) =>
          /\.staged-|\.previous-/.test(name),
        ),
      ).toBe(false);
    },
  );
});
