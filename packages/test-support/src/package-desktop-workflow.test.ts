import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const workflow = read(".github/workflows/package-desktop.yml");
const paths = [...workflow.matchAll(/^ {6}- "([^"]+)"$/gmu)].map(
  (match) => match[1]!,
);

function selected(path: string) {
  return paths.some((pattern) => {
    const expression = pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*");
    return new RegExp(`^${expression}$`, "u").test(path);
  });
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function workspaceInputs() {
  const directories = ["apps", "packages"].flatMap((parent) =>
    readdirSync(new URL(`${parent}/`, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`),
  );
  const manifests = new Map(
    directories.map((directory) => {
      const manifest = JSON.parse(
        read(`${directory}/package.json`),
      ) as Manifest;
      return [manifest.name, { directory, manifest }] as const;
    }),
  );
  const visited = new Set<string>();
  function visit(name: string) {
    const entry = manifests.get(name);
    if (!entry) throw new Error(`Missing workspace ${name}`);
    if (visited.has(entry.directory)) return;
    visited.add(entry.directory);
    for (const [dependency, version] of Object.entries({
      ...entry.manifest.dependencies,
      ...entry.manifest.devDependencies,
    })) {
      if (version.startsWith("workspace:")) visit(dependency);
    }
  }
  visit("@ableton-agent/desktop");
  return [...visited].flatMap((directory) => [
    `${directory}/package.json`,
    `${directory}/src/ownership-probe.ts`,
  ]);
}

describe("desktop packaging workflow ownership", () => {
  it("selects Desktop's transitive workspace and test dependencies", () => {
    expect(paths.length).toBeGreaterThan(0);
    expect(workspaceInputs().filter((path) => !selected(path))).toEqual([]);
  });

  it("selects Electron configuration, bundled definitions and payload build inputs", () => {
    const inputs = [
      "tests/electron/desktop.spec.ts",
      "tests/electron/packaged-desktop.spec.ts",
      "tests/electron/desktop-test-environment.ts",
      "playwright.config.ts",
      "tsconfig.base.json",
      "pnpm-workspace.yaml",
      "agents/default.yaml",
      "skills/listening/SKILL.md",
      "remote-script/AbletonAgent/__init__.py",
      "max-patches/audio-listener/native-source.mjs",
      "scripts/build-ableton-integrations.mjs",
      "scripts/generate-product-versions.mjs",
      "scripts/audio-listener-device.mjs",
      "scripts/max-device-publisher.mjs",
      "scripts/m4l-producer-companions.mjs",
      "scripts/lib/native-listening-lifecycle.mjs",
      "scripts/lib/native-metric-protocol-bundle.mjs",
      "config/product-versions.json",
      "package.json",
      "pnpm-lock.yaml",
      ".github/workflows/package-desktop.yml",
    ];
    expect(inputs.filter((path) => !selected(path))).toEqual([]);
    expect(selected("docs/testing/test-strategy.md")).toBe(false);
  });

  it("builds integration payloads before the existing Electron and distribution steps", () => {
    const commands = [...workflow.matchAll(/^ {6}- run: (.+)$/gmu)].map(
      (match) => match[1],
    );
    const required = [
      "pnpm build",
      "node scripts/build-ableton-integrations.mjs",
      "pnpm exec playwright test --project=electron",
      "pnpm --filter @ableton-agent/desktop dist --mac",
    ];
    const indexes = required.map((command) => commands.indexOf(command));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});
