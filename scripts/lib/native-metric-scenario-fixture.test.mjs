import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("runs offline copied-fixture success, bounds, denial, failure, cancellation and cleanup regressions", () => {
  expect(() =>
    execFileSync(
      "python3",
      ["-B", "scripts/lib/native-metric-scenario-fixture.test.py"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 64 * 1024,
      },
    ),
  ).not.toThrow();
});
