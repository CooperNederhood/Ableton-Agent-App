import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("compares the committed protocol contract instead of silently skipping a large baseline", () => {
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./check-protocol-compatibility.mjs", import.meta.url),
      ),
      "HEAD",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    },
  );
  expect(output).not.toContain("compatibility check skipped");
  expect(output).toMatch(/^Protocol /);
});

it("surfaces an invalid baseline ref instead of reporting a successful skip", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./check-protocol-compatibility.mjs", import.meta.url),
      ),
      `refs/heads/missing-protocol-test-${randomUUID()}`,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain("compatibility check skipped");
});
