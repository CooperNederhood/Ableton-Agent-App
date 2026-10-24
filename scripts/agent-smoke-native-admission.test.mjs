import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

import { admitNativeScenarios } from "./lib/native-listening-runner.mjs";

it("admits Session native selections before setup, credentials or process inspection", async () => {
  const manifest = JSON.parse(
    await readFile(
      "integration/live-scenarios/native-session-midi.json",
      "utf8",
    ),
  );
  const expectedError = await admitNativeScenarios({
    manifests: [manifest],
    skipInstall: true,
    computerUse: false,
    approveAll: true,
  }).then(
    () => {
      throw new Error("Unsafe native selection unexpectedly admitted");
    },
    (error) => {
      expect(error).toBeInstanceOf(Error);
      return error.message;
    },
  );
  const directory = await mkdtemp(join(tmpdir(), "session-native-admission-"));
  try {
    const output = join(directory, "evidence.json");
    const child = spawnSync(
      process.execPath,
      [
        resolve("scripts/agent-smoke.mjs"),
        "--group",
        "native-listening-session",
        "--skip-build",
        "--skip-install",
        "--approve-all",
        "--remote-script-target",
        join(directory, "uninstalled-remote-script"),
        "--output",
        output,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const evidence = JSON.parse(await readFile(output, "utf8"));
    expect(evidence.error).toBe(expectedError);
    expect(evidence.groups).toEqual([]);
    expect(evidence.scenarios).toEqual([]);
    expect(evidence.liveProcess).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
