import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishResources } from "./max-device.js";
import type { ResourcePublicationEvent } from "./max-device.js";

const scratch = resolve(".test-artifacts/max-device", randomUUID());
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

it("exposes runtime helpers only through the Node subpath, not the renderer-safe root", () => {
  expect(() =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { readFile } from "node:fs/promises";
          import * as shared from "@ableton-agent/shared";
          import * as devices from "@ableton-agent/shared/m4l-devices";
          for (const name of ["readIntegrationDevicePayloads", "decodeAmxd", "encodeAmxd", "renderInstalledDevice"]) {
            assert.equal(name in shared, false, name + " must not contaminate the browser entry");
            assert.equal(typeof devices[name], "function");
          }
          const root = await readFile(new URL(import.meta.resolve("@ableton-agent/shared")), "utf8");
          assert.doesNotMatch(root, /node:|\\.\\/max-device|\\.\\/integration-device/);
        `,
      ],
      { cwd: resolve("apps/desktop"), stdio: "pipe" },
    ),
  ).not.toThrow();
});

it("publishes regular copies of tracked canonical companion symlinks", async () => {
  await mkdir(scratch, { recursive: true });
  const source = join(scratch, "source.js");
  const link = join(scratch, "linked.js");
  await writeFile(source, "module.exports = {};");
  await symlink(source, link);
  const events: ResourcePublicationEvent[] = [];
  await publishResources({
    destinationDirectory: join(scratch, "destination"),
    resources: [{ fileName: "companion.js", source: link }],
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(events.map(({ stage }) => stage)).toEqual([
    "queued",
    "started",
    "progress",
    "completed",
  ]);
  expect(await readdir(scratch)).toContain("destination");
});

it("reports attributable cancellation and cleans partial staging without observer interference", async () => {
  await mkdir(scratch, { recursive: true });
  const source = join(scratch, "source.js");
  await writeFile(source, "module.exports = {};");
  const events: ResourcePublicationEvent[] = [];
  const controller = new AbortController();
  await expect(
    publishResources({
      destinationDirectory: join(scratch, "destination"),
      resources: [
        { fileName: "first.js", source },
        { fileName: "second.js", source },
      ],
      signal: controller.signal,
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
      onEvent: (event) => {
        events.push(event);
        if (event.stage === "progress") controller.abort();
        throw new Error("observer failure");
      },
    }),
  ).rejects.toThrow();
  expect(events.map(({ stage }) => stage)).toEqual([
    "queued",
    "started",
    "progress",
    "cancelled",
  ]);
  expect(await readdir(join(scratch, "destination"))).toEqual(["first.js"]);
  for (const event of events) {
    expect(event).toMatchObject({
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  }
});
