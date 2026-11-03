import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  describeScenarioError,
  serializeScenarioReceipt,
  writeScenarioReceipt,
} from "./scenario-receipts.mjs";

it("redacts credentials and omits bodies without truncating evidence arrays", () => {
  const result = JSON.parse(
    serializeScenarioReceipt({
      prompt: "Inspect token=private-value",
      arguments: { token: "private-value" },
      nested: [{ message: "Bearer private-value", password: "private-value" }],
      audio: { mimeType: "audio/wav", body: [1, 2, 3] },
      audioData: [1, 2, 3],
      bytes: new Uint8Array([1, 2, 3]),
      rows: Array.from({ length: 300 }, (_, index) => ({ index, rms: 0.25 })),
    }),
  );
  expect(JSON.stringify(result)).not.toContain("private-value");
  expect(result.arguments.token).toBe("[REDACTED]");
  expect(result.audio.body).toBe("[Audio data omitted]");
  expect(result.audioData).toBe("[Audio data omitted]");
  expect(result.bytes).toBe("[Binary data omitted]");
  expect(result.rows).toHaveLength(300);
  expect(result.rows.at(-1)).toEqual({ index: 299, rms: 0.25 });
});

it("bounds diagnostic strings and rejects oversized receipts or invalid limits", () => {
  expect(
    JSON.parse(serializeScenarioReceipt({ text: "x".repeat(20_000) })).text,
  ).toBe(`${"x".repeat(16_384)}[truncated]`);
  expect(
    describeScenarioError(new Error(`token=private-value ${"x".repeat(3000)}`)),
  ).toHaveLength(2048);
  expect(describeScenarioError(new Error("token=private-value"))).not.toContain(
    "private-value",
  );
  expect(() => serializeScenarioReceipt({ text: "x".repeat(100) }, 30)).toThrow(
    "bounded evidence",
  );
  expect(() => serializeScenarioReceipt({}, 0)).toThrow("Invalid");
  expect(() => serializeScenarioReceipt({}, Infinity)).toThrow("Invalid");
});

it("redacts dynamic field names without silently merging identities", () => {
  expect(
    serializeScenarioReceipt({ "Bearer private-value": { checked: true } }),
  ).not.toContain("private-value");
  expect(() =>
    serializeScenarioReceipt({
      "token=first-value": 1,
      "token=second-value": 2,
    }),
  ).toThrow("field collision");
  const shared = { checked: true };
  expect(
    JSON.parse(serializeScenarioReceipt({ first: shared, second: shared })),
  ).toEqual({ first: shared, second: shared });
});

it("atomically replaces owner-only evidence and cleans temporary files on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenario-receipt-"));
  try {
    const output = join(directory, "receipt.json");
    await writeScenarioReceipt(output, { passed: false });
    await writeScenarioReceipt(output, { passed: true });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      passed: true,
    });
    if (process.platform !== "win32")
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    const circular = {};
    circular.self = circular;
    await expect(writeScenarioReceipt(output, circular)).rejects.toThrow();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      passed: true,
    });
    const invalidTarget = join(directory, "not-a-file");
    await mkdir(invalidTarget);
    await expect(writeScenarioReceipt(invalidTarget, {})).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual([
      "not-a-file",
      "receipt.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
