import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    stat: vi.fn((path) =>
      String(path).endsWith("dist/main/ableton-integrations-cli.js")
        ? Promise.resolve({ isFile: () => true })
        : original.stat(path),
    ),
    copyFile: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    writeFile: vi.fn(),
  };
});

import {
  DEVICE_DIRECTORY_PARTS,
  DEVICE_FILE_NAME,
  main,
} from "./midi-capture-device.mjs";

afterEach(() => vi.clearAllMocks());

describe("standalone MIDI installation adapter", () => {
  it("uses the shared guarded installer and does not publish loose files itself", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 });
    await main([
      "install",
      "--user-library",
      "/custom/Library",
      "--profile",
      "studio",
    ]);
    expect(DEVICE_FILE_NAME).toBe("Midi-Capture.amxd");
    expect(DEVICE_DIRECTORY_PARTS.at(-1)).toBe("Midi-Capture");
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringContaining("dist/main/ableton-integrations-cli.js"),
        "install",
        "--components",
        "midi-capture",
        "--confirm",
        "--user-library",
        "/custom/Library",
        "--profile",
        "studio",
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
    for (const mutation of [copyFile, mkdir, rename, writeFile])
      expect(mutation).not.toHaveBeenCalled();
  });

  it("forwards dry-run and surfaces child failures", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1 });
    await expect(main(["install", "--dry-run"])).rejects.toThrow(
      "failed with exit code 1",
    );
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toContain("--dry-run");
    for (const mutation of [copyFile, mkdir, rename, writeFile])
      expect(mutation).not.toHaveBeenCalled();
  });
});
