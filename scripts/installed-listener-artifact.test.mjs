import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";
import { PRODUCT_VERSIONS } from "../packages/shared/src/index.ts";
import { resolveLiveAgentStorage } from "../packages/storage/src/index.ts";
import { installAbletonIntegrations } from "../apps/desktop/src/main/ableton-integrations-install.ts";
import { checkArtifact } from "./audio-listener-device.mjs";

it("retains the native artifact contract after installed profile configuration is added", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "installed-listener-artifact-")),
  );
  try {
    const payload = join(root, "payload");
    execFileSync(
      process.execPath,
      ["scripts/build-ableton-integrations.mjs", "--out", payload],
      { cwd: resolve("."), stdio: "pipe" },
    );
    const library = join(root, "Library");
    await mkdir(library);
    const storage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: join(root, "state") },
      profile: "automation",
    });
    const options = {
      payloadDirectory: payload,
      remoteScriptSourcePath: resolve("remote-script/AbletonAgent"),
      userLibraryPath: library,
      storage,
      remoteScriptVersion: PRODUCT_VERSIONS.remoteScript,
      confirmed: true,
      components: ["machine-listening"],
      assertHostStopped: async () => undefined,
    };
    const portableManifest = join(
      payload,
      "machine-listening",
      "audio-listener-manifest.json",
    );
    const originalManifest = await readFile(portableManifest, "utf8");
    const result = await installAbletonIntegrations(options);
    expect(
      result.components.find(
        ({ component }) => component === "machine-listening",
      )?.status,
    ).toBe("installed");
    const installedDirectory = join(
      library,
      "Presets",
      "Audio Effects",
      "Max Audio Effect",
      "Machine-Listening-Development",
    );
    await checkArtifact(installedDirectory);
    const installed = JSON.parse(
      await readFile(
        join(installedDirectory, "audio-listener-manifest.json"),
        "utf8",
      ),
    );
    expect(installed).toMatchObject({
      nativeVersion: 4,
      nativeAbiVersion: 2,
      supportedModes: ["arrangement", "session"],
      modeNegotiation: "explicit-per-pass",
    });
    for (const graph of [
      "audio_listener_native_clock.maxpat",
      "audio_listener_native_analysis.maxpat",
    ]) {
      const document = JSON.parse(
        await readFile(join(installedDirectory, graph), "utf8"),
      );
      expect(
        document.patcher.boxes.find(({ box }) => box.id === "poll").box.text,
      ).toBe("qmetro 10 @active 0");
    }
    const repeated = await installAbletonIntegrations(options);
    expect(
      repeated.components.find(
        ({ component }) => component === "machine-listening",
      )?.status,
    ).toBe("current");
    const changedProfile = await installAbletonIntegrations({
      ...options,
      storage: resolveLiveAgentStorage({
        environment: { LIVE_AGENT_HOME: join(root, "state") },
        profile: "another-profile",
      }),
    });
    expect(
      changedProfile.components.find(
        ({ component }) => component === "machine-listening",
      )?.status,
    ).toBe("installed");
    await checkArtifact(installedDirectory);
    expect(await readFile(portableManifest, "utf8")).toBe(originalManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
