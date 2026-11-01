import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const imports = (source) =>
  ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) => fileName);
const executableTest = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

describe("native listening test support ownership", () => {
  it("recognizes static imports, re-exports and dynamic executable-test imports", () => {
    expect(
      imports(`
        import { fixture } from "./fixture.test.mjs";
        export { evidence } from "./evidence.test.ts";
        const dynamic = import("./runner.spec.mjs");
        import "./safe-test-support.mjs";
      `).filter((path) => executableTest.test(path)),
    ).toEqual([
      "./fixture.test.mjs",
      "./evidence.test.ts",
      "./runner.spec.mjs",
    ]);
  });

  it("never imports executable tests from native listening modules", async () => {
    const directory = new URL("./", import.meta.url);
    const names = (await readdir(directory)).filter(
      (name) => name.startsWith("native-listening") && name.endsWith(".mjs"),
    );
    expect(names).toContain("native-listening-runner-v2.test.mjs");
    expect(names).toContain("native-listening-runner-v3.test.mjs");
    for (const name of names) {
      const dependencies = imports(
        await readFile(new URL(name, directory), "utf8"),
      );
      expect(
        dependencies.filter((path) => executableTest.test(path)),
        name,
      ).toEqual([]);
      if (name.endsWith("-test-support.mjs")) {
        expect(
          dependencies.filter((path) => path.startsWith("vitest")),
          name,
        ).toEqual([]);
      }
    }
  });

  it("imports builders during a running test without registering tests or hooks", async () => {
    // Vitest rejects nested test/hook registration during these dynamic imports.
    const fixture = await import("./native-listening-fixture-test-support.mjs");
    const evidence =
      await import("./native-listening-evidence-test-support.mjs");
    expect(Object.keys(fixture).sort()).toEqual([
      "disposeNativeFixtureRoots",
      "nativeFixtureInput",
    ]);
    expect(Object.keys(evidence).sort()).toEqual([
      "descriptiveEvidence",
      "evidence",
      "sessionEvidence",
    ]);
  });

  it.each([1, 2, 3, 4])(
    "retains v%i pinned bytes and isolated resolver roots until each caller explicitly disposes them",
    async (nativeVersion) => {
      const { nativeFixtureInput, disposeNativeFixtureRoots } =
        await import("./native-listening-fixture-test-support.mjs");
      const firstRoots = [];
      const secondRoots = [];
      try {
        const first = await nativeFixtureInput(firstRoots, { nativeVersion });
        const second = await nativeFixtureInput(secondRoots, { nativeVersion });
        expect(firstRoots).toEqual([first.root]);
        expect(secondRoots).toEqual([second.root]);
        expect(first.root).not.toBe(second.root);
        for (const fixture of [first, second]) {
          expect(fixture.storage.root).toBe(join(fixture.root, "live-agent"));
          expect(fixture.storage.profileRoot).toBe(
            join(fixture.root, "live-agent", "profiles", "automation"),
          );
          expect(fixture.destination).toBe(join(fixture.root, "copied-set"));
          expect(await readFile(fixture.input.sourceSet)).toEqual(
            fixture.source,
          );
          expect(
            createHash("sha256").update(fixture.source).digest("hex"),
          ).toBe(fixture.input.sourceSetSha256);
        }
        await disposeNativeFixtureRoots(firstRoots);
        expect(firstRoots).toEqual([]);
        await expect(access(first.root)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(access(second.input.sourceSet)).resolves.toBeUndefined();
        expect(secondRoots).toEqual([second.root]);
        await disposeNativeFixtureRoots(firstRoots);
        await disposeNativeFixtureRoots(secondRoots);
        expect(secondRoots).toEqual([]);
        await expect(access(second.root)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await disposeNativeFixtureRoots(firstRoots);
        await disposeNativeFixtureRoots(secondRoots);
      }
    },
  );

  it("allows caller-owned failure cleanup only after awaited shutdown", async () => {
    const { nativeFixtureInput, disposeNativeFixtureRoots } =
      await import("./native-listening-fixture-test-support.mjs");
    const roots = [];
    let fixture;
    const order = [];
    const run = async () => {
      fixture = await nativeFixtureInput(roots);
      try {
        throw new Error("synthetic caller failure");
      } finally {
        await Promise.resolve().then(async () => {
          await access(fixture.input.sourceSet);
          order.push("shutdown");
        });
        await disposeNativeFixtureRoots(roots);
        order.push("removed");
      }
    };
    try {
      await expect(run()).rejects.toThrow("synthetic caller failure");
      expect(order).toEqual(["shutdown", "removed"]);
      expect(roots).toEqual([]);
      await expect(access(fixture.root)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await disposeNativeFixtureRoots(roots);
    }
  });
});
