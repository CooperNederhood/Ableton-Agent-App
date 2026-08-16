import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeSignalSecret } from "./signal-credentials.js";

const secret = "desktop-signal-secret-that-is-at-least-32-characters";
let cleanup: (() => Promise<void>) | undefined;
let directory: string | undefined;

afterEach(async () => {
  await cleanup?.();
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
  cleanup = undefined;
  directory = undefined;
});

describe("signal ingress credentials", () => {
  it("writes a user-only secret and removes only the value it created", async () => {
    directory = await mkdtemp(join(tmpdir(), "ableton-signal-secret-"));
    const secretPath = join(directory, "signal-ingress.secret");
    cleanup = await writeSignalSecret(secret, { directory, secretPath });

    expect(await readFile(secretPath, "utf8")).toBe(`${secret}\n`);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);

    await cleanup();
    cleanup = undefined;
    await expect(readFile(secretPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
