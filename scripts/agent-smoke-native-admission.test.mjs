import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

import { admitNativeScenarios } from "./lib/native-listening-runner.mjs";

it.each([
  {
    id: "native-metric-session-midi-spectrum",
    group: "native-listening-metric",
    approveAll: false,
  },
  {
    id: "native-metric-session-midi-eight-bars",
    group: "native-listening-metric-long",
    approveAll: false,
  },
  {
    id: "native-session-midi",
    group: "native-listening-session",
    approveAll: true,
  },
  {
    id: "native-dual-session-repeat-1-2-1",
    group: "native-listening-repeated",
    approveAll: false,
  },
  {
    id: "native-dual-session-warped-audio",
    group: "native-listening-dual",
    approveAll: false,
  },
])(
  "admits $group selections before setup, credentials or process inspection",
  async ({ id, group, approveAll }) => {
    const manifest = JSON.parse(
      await readFile(`integration/live-scenarios/${id}.json`, "utf8"),
    );
    const expectedError = await admitNativeScenarios({
      manifests: [manifest],
      skipInstall: true,
      computerUse: false,
      approveAll,
    }).then(
      () => {
        throw new Error("Unsafe native selection unexpectedly admitted");
      },
      (error) => {
        expect(error).toBeInstanceOf(Error);
        return error.message;
      },
    );
    const directory = resolve(
      ".test-artifacts",
      `session-native-admission-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: true });
    try {
      const output = join(directory, "evidence.json");
      const child = spawnSync(
        process.execPath,
        [
          resolve("scripts/agent-smoke.mjs"),
          "--group",
          group,
          "--skip-build",
          "--skip-install",
          ...(approveAll ? ["--approve-all"] : []),
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
      expect(evidence).toMatchObject({
        formatVersion: 2,
        finalization: "final",
        passed: false,
        outcome: "blocked",
        sourceRevision: expect.stringMatching(/^[a-f0-9]{40}$/),
        sourceDirty: expect.any(Boolean),
        executedScenarioIds: [],
        observedTools: { count: 0, names: [] },
        coverage: { passed: 0, executed: 0 },
      });
      expect(evidence.selectedScenarioIds).toContain(id);
      expect(evidence.unrunScenarioIds).toEqual(evidence.selectedScenarioIds);
      expect(evidence.coverage.unrun).toBe(evidence.coverage.selected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
