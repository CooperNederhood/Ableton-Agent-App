import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { telemetryEventEnvelopeSchema } from "@ableton-agent/observability";

import {
  publishSignalSecrets,
  writeSignalSecret,
} from "./signal-credentials.js";

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
  it("publishes one secret to canonical and explicitly requested compatibility files with redacted lifecycle", async () => {
    directory = await mkdtemp(join(tmpdir(), "ableton-signal-secret-"));
    const canonical = {
      directory: join(directory, "credentials"),
      secretPath: join(directory, "credentials", "signal-ingress-secret.json"),
    };
    const legacy = {
      directory: join(directory, "legacy"),
      secretPath: join(directory, "legacy", "signal-ingress.secret"),
    };
    const enqueue = vi.fn();
    cleanup = await publishSignalSecrets(secret, {
      canonical,
      legacy,
      telemetry: { enqueue },
    });
    expect(await readFile(canonical.secretPath, "utf8")).toBe(`${secret}\n`);
    expect(await readFile(legacy.secretPath, "utf8")).toBe(`${secret}\n`);
    expect((await stat(canonical.secretPath)).mode & 0o777).toBe(0o600);
    const events = enqueue.mock.calls.map(([event]) =>
      telemetryEventEnvelopeSchema.parse(event),
    );
    expect(events.map(({ name }) => name)).toEqual([
      "signal.credentials.publish.queued",
      "signal.credentials.publish.started",
      "signal.credentials.publish.progress",
      "signal.credentials.publish.progress",
      "signal.credentials.publish.completed",
    ]);
    expect(new Set(events.map(({ trace }) => trace?.traceId)).size).toBe(1);
    expect(events.every(({ durationMs }) => (durationMs ?? -1) >= 0)).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain(secret);
    await writeFile(
      legacy.secretPath,
      "replacement owned by another publisher\n",
    );
    await cleanup();
    cleanup = undefined;
    await expect(readFile(canonical.secretPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(legacy.secretPath, "utf8")).toBe(
      "replacement owned by another publisher\n",
    );
  });

  it("rolls back canonical publication if compatibility publication fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "ableton-signal-secret-"));
    const canonical = {
      directory,
      secretPath: join(directory, "canonical.secret"),
    };
    const invalidDirectory = join(directory, "not-a-directory");
    await writeFile(invalidDirectory, "owned failure fixture");
    const enqueue = vi.fn();
    await expect(
      publishSignalSecrets(secret, {
        canonical,
        legacy: {
          directory: invalidDirectory,
          secretPath: join(invalidDirectory, "secret"),
        },
        telemetry: { enqueue },
      }),
    ).rejects.toThrow();
    await expect(readFile(canonical.secretPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
    expect(
      telemetryEventEnvelopeSchema.parse(enqueue.mock.lastCall?.[0]).name,
    ).toBe("signal.credentials.publish.failed");
  });

  it("cancels before compatibility publication and cleans the owned canonical value", async () => {
    directory = await mkdtemp(join(tmpdir(), "ableton-signal-secret-"));
    const controller = new AbortController();
    const events: unknown[] = [];
    const canonical = {
      directory,
      secretPath: join(directory, "canonical.secret"),
    };
    await expect(
      publishSignalSecrets(secret, {
        canonical,
        legacy: { directory, secretPath: join(directory, "legacy.secret") },
        signal: controller.signal,
        telemetry: {
          enqueue: (event) => {
            events.push(event);
            if (event.name === "signal.credentials.publish.progress")
              controller.abort(new Error("Publication cancelled"));
            return true;
          },
        },
      }),
    ).rejects.toThrow("Publication cancelled");
    expect(await readdir(directory)).toEqual([]);
    expect(telemetryEventEnvelopeSchema.parse(events.at(-1)).name).toBe(
      "signal.credentials.publish.cancelled",
    );
  });

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
