import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intakeProject } from "../../.github/skills/author-integration-test/scripts/intake-project.js";

const reference = (path: string, type = "3") =>
  `<FileRef><Path Value="/original/${path}"/><RelativePath Value="${path}"/><RelativePathType Value="${type}"/></FileRef>`;
const document = (refs = reference("Samples/Imported/resource-001.wav")) =>
  gzipSync(`<Ableton Creator="Ableton Live 11.3.43">${refs}</Ableton>`);

describe("skill-local project intake (no Live or model)", () => {
  let root: string;
  let project: string;
  let output: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "draft-intake-")));
    project = join(root, "user-project");
    output = join(root, "authoring");
    await mkdir(join(project, "Samples/Imported"), { recursive: true });
    await mkdir(output);
    await writeFile(join(project, "project.als"), document());
    await writeFile(
      join(project, "Samples/Imported/resource-001.wav"),
      "controlled fixture bytes",
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copies required files, ignores Backup, preserves source and records bounded lifecycle", async () => {
    await mkdir(join(project, "Backup"));
    await writeFile(join(project, "Backup/old.als"), "not the selected Set");
    const original = await readFile(join(project, "project.als"));
    const result = await intakeProject({ project, output });
    expect(result.setName).toBe("project.als");
    expect(result.inventory.map((file) => file.path)).toEqual([
      "project.als",
      "Samples/Imported/resource-001.wav",
    ]);
    expect(result.status).toBe("copied-for-review");
    expect(await readdir(result.copy)).not.toContain("Backup");
    expect(await readFile(join(project, "project.als"))).toEqual(original);
    expect(await readFile(join(result.copy, "project.als"))).toEqual(original);
    expect(result.events.map((event) => event.stage)).toEqual([
      "started",
      "progress",
      "completed",
    ]);
    expect(
      result.events.every(
        (event) => event.durationMs >= 0 && event.traceId === result.traceId,
      ),
    ).toBe(true);
    expect(await readFile(`${result.copy}-intake.json`, "utf8")).toContain(
      '"completed"',
    );
  });

  it("reports external references without copying or requiring their targets", async () => {
    await writeFile(
      join(project, "project.als"),
      document(
        reference("Samples/Imported/resource-001.wav") +
          reference("not-present.amxd", "6"),
      ),
    );
    const result = await intakeProject({ project, output });
    expect(result.externalReferences).toHaveLength(1);
    expect(result.inventory).toHaveLength(2);
  });

  it.each(["../escape.wav", "/absolute.wav", "Samples\\escape.wav"])(
    "rejects unsafe reference %s",
    async (path) => {
      await writeFile(join(project, "project.als"), document(reference(path)));
      await expect(intakeProject({ project, output })).rejects.toThrow(
        "Unsafe",
      );
      expect(await readdir(output)).toEqual([]);
    },
  );

  it("rejects missing media without using the absolute-reference fallback", async () => {
    await rm(join(project, "Samples/Imported/resource-001.wav"));
    await expect(intakeProject({ project, output })).rejects.toThrow();
    expect(await readdir(output)).toEqual([]);
  });

  it("rejects ambiguity rather than choosing a Set", async () => {
    await writeFile(join(project, "other.als"), document());
    await expect(intakeProject({ project, output })).rejects.toThrow(
      "exactly one",
    );
  });

  it("rejects symlinked resources and overlapping output ownership", async () => {
    const media = join(project, "Samples/Imported/resource-001.wav");
    await rm(media);
    await symlink(join(project, "project.als"), media);
    await expect(intakeProject({ project, output })).rejects.toThrow("Symlink");
    await expect(intakeProject({ project, output: project })).rejects.toThrow(
      "overlap",
    );
  });

  it("retains a failed snapshot when the source changes during copying", async () => {
    await expect(
      intakeProject({
        project,
        output,
        event: (event) => {
          if (event.stage === "progress")
            writeFileSync(
              join(project, "Samples/Imported/resource-001.wav"),
              "changed bytes",
            );
        },
      }),
    ).rejects.toThrow("changed during intake");
    const report = (await readdir(output)).find((name) =>
      name.endsWith("-intake-failed.json"),
    );
    expect(report).toBeDefined();
    expect(await readFile(join(output, report!), "utf8")).toContain('"failed"');
  });

  it("honors cancellation, preserving an interrupted copy and reporting cancellation", async () => {
    const controller = new AbortController();
    await expect(
      intakeProject({
        project,
        output,
        signal: controller.signal,
        event: (event) => {
          if (event.stage === "progress") controller.abort();
        },
      }),
    ).rejects.toThrow();
    const report = (await readdir(output)).find((name) =>
      name.endsWith("-intake-failed.json"),
    );
    expect(await readFile(join(output, report!), "utf8")).toContain(
      '"cancelled"',
    );
    expect(await readFile(join(project, "project.als"))).toEqual(document());
  });

  it("redacts report strings and omits binary bodies", async () => {
    await writeFile(
      join(project, "project.als"),
      document(
        reference(
          "outside?token=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
          "6",
        ),
      ),
    );
    const result = await intakeProject({ project, output });
    const receipt = await readFile(`${result.copy}-intake.json`, "utf8");
    expect(receipt).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(receipt).not.toContain("controlled fixture bytes");
  });

  it("runs through the documented Node entry point and rejects unknown arguments", async () => {
    const entry = resolve(
      ".github/skills/author-integration-test/scripts/intake-project.mjs",
    );
    const run = promisify(execFile);
    const result = await run(process.execPath, [
      entry,
      "--project",
      project,
      "--output",
      output,
    ]);
    expect(result.stdout).toContain("copied-for-review");
    await expect(
      run(process.execPath, [entry, "--invented-option"]),
    ).rejects.toMatchObject({ code: 1 });
  });
});
