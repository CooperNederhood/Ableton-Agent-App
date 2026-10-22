import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function validationStep() {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const body = workflow.match(
    / {6}- name: Format, lint, typecheck, and test\n((?: {8}[^\n]*\n)+)/u,
  )?.[1];
  const command = body?.match(/^ {8}run: (.+)$/mu)?.[1];
  const shell = body?.match(/^ {8}shell: (\S+)$/mu)?.[1];
  if (!command || (shell !== undefined && shell !== "bash")) {
    throw new Error("Unsupported CI validation command or shell");
  }
  return {
    command,
    // GitHub's implicit bash uses -e without pipefail; explicit bash enables it.
    shellArguments:
      shell === "bash"
        ? ["--noprofile", "--norc", "-e", "-o", "pipefail"]
        : ["-e"],
  };
}

describe("hosted validation pipeline", () => {
  it.each([0, 7])(
    "preserves validator exit %i and its diagnostic log through tee",
    (exitCode) => {
      const root = mkdtempSync(join(tmpdir(), "ableton-ci-validation-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "pnpm"),
          [
            "#!/bin/sh",
            "printf 'controlled validator stdout\\n'",
            "printf 'controlled validator stderr\\n' >&2",
            'exit "$AA_TEST_VALIDATION_EXIT_CODE"',
            "",
          ].join("\n"),
          { mode: 0o700 },
        );
        const step = validationStep();
        const result = spawnSync(
          "bash",
          [...step.shellArguments, "-c", step.command],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
              AA_TEST_VALIDATION_EXIT_CODE: String(exitCode),
            },
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(exitCode);
        expect(readFileSync(join(root, "ci-validation.log"), "utf8")).toBe(
          "controlled validator stdout\ncontrolled validator stderr\n",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
