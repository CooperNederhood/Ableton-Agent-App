import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acceptanceSuiteCli } from "./acceptance-suite-cli.js";
import type { SuiteInputs } from "./acceptance-suite.js";

async function fixture(test: (root: string) => Promise<void>) {
  const parent = resolve(".test-artifacts/acceptance-suite-cli-unit");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  try {
    await mkdir(join(root, "integration/acceptance-scenarios"), {
      recursive: true,
    });
    await writeFile(
      join(root, "integration/acceptance-scenarios/suite.json"),
      JSON.stringify({ schemaVersion: 1, scenarios: ["first", "second"] }),
    );
    await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const inputs: SuiteInputs = {
  candidateSha256: "a".repeat(64),
  appAsarSha256: "b".repeat(64),
  sourceSha256: "c".repeat(64),
  sourceRevision: "d".repeat(40),
  dirty: false,
  definitionsSha256: "e".repeat(64),
  selected: ["first", "second"],
};
describe("acceptance suite CLI", () => {
  it.each([
    ["suite", "--scenario", "first"],
    ["suite", "--repeat", "2"],
    ["suite", "--approve-all"],
    ["verify"],
    ["suite", "--live-app"],
    ["suite", "--executable", "one", "--executable", "two"],
  ])(
    "rejects unsupported or ambiguous options %j before host acquisition",
    async (...args) => {
      const acquire = vi.fn();
      const error = vi.fn();
      expect(
        await acceptanceSuiteCli(args, { error, dependencies: { acquire } }),
      ).toBe(1);
      expect(acquire).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
    },
  );
  it("discovers a suite once per invocation and emits aggregate evidence without retry options", async () => {
    await fixture(async (root) => {
      const execute = vi.fn(
        async ({
          scenarioId,
          runId,
        }: {
          scenarioId: string;
          runId: string;
        }) => ({
          scenarioId,
          runId,
          status: "passed" as const,
          executed: true,
          cleanupComplete: true,
          persisted: true,
          receiptPath: "receipt.json",
          receiptSha256: "f".repeat(64),
          assertions: [],
          liveVersion: "11.3.43",
        }),
      );
      const output = vi.fn<(text: string) => void>();
      expect(
        await acceptanceSuiteCli(["suite"], {
          root,
          output,
          dependencies: {
            inspect: async () => inputs,
            execute,
            acquire: async () => ({ release: async () => {} }),
          },
        }),
      ).toBe(0);
      expect(execute.mock.calls.map(([call]) => call.scenarioId)).toEqual(
        inputs.selected,
      );
      const [directory] = await readdir(
        join(root, ".test-artifacts/acceptance"),
      );
      expect(directory).toMatch(/^suite-/);
      expect(output.mock.calls.at(-1)?.[0]).toContain('"status":"passed"');
    });
  });
  it("retains initial registered selection when packaged admission fails", async () => {
    await fixture(async (root) => {
      const output = vi.fn<(text: string) => void>(),
        execute = vi.fn();
      expect(
        await acceptanceSuiteCli(["suite"], {
          root,
          output,
          dependencies: {
            inspect: async () => {
              throw new Error("missing packaged candidate");
            },
            execute,
            acquire: async () => ({ release: async () => {} }),
          },
        }),
      ).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      const value = JSON.parse(output.mock.calls.at(-1)![0]) as {
        selected: string[];
        unrun: string[];
        status: string;
      };
      expect(value.status).toBe("blocked");
      expect(value.selected).toEqual(inputs.selected);
      expect(value.unrun).toEqual(inputs.selected);
    });
  });
});
