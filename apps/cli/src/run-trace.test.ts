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

import { describe, expect, it } from "vitest";

import { RunTraceWriter } from "./run-trace.js";

describe("run trace writer", () => {
  it("coalesces queued checkpoints, redacts strings and omits binary/audio bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-trace-"));
    const path = join(directory, "trace.json");
    try {
      const writer = new RunTraceWriter(path);
      for (let sequence = 0; sequence < 200; sequence += 1) {
        writer.checkpoint({ sequence });
      }
      await writer.write({
        sequence: 200,
        message: "Bearer private-token",
        audioData: [1, 2, 3],
        binaryData: Buffer.from("private bytes"),
        operations: Array.from({ length: 70 }, (_, sequence) => ({
          sequence,
        })),
      });
      const trace: unknown = JSON.parse(await readFile(path, "utf8"));
      expect(trace).toMatchObject({
        sequence: 200,
        audioData: "[Audio data omitted]",
        binaryData: "[Binary data omitted]",
        operations: Array.from({ length: 64 }, (_, sequence) => ({
          sequence,
        })),
      });
      expect(JSON.stringify(trace)).not.toContain("private-token");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(["trace.json"]);
      await writer.write({ sequence: 201 });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        sequence: 201,
      });
      await writer.finish({ traceState: "completed" });
      writer.checkpoint({ traceState: "running" });
      await writer.flush();
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        traceState: "completed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces checkpoint failures on flush and subsequent final writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-trace-error-"));
    const parent = join(directory, "not-a-directory");
    try {
      await writeFile(parent, "fixture");
      const writer = new RunTraceWriter(join(parent, "trace.json"));
      writer.checkpoint({ traceState: "running" });
      await expect(writer.flush()).rejects.toThrow();
      await expect(writer.write({ traceState: "completed" })).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["not-a-directory"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized snapshot while retaining the last valid checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-trace-bound-"));
    const path = join(directory, "trace.json");
    try {
      const writer = new RunTraceWriter(path);
      await writer.write({ traceState: "running", sequence: 0 });
      const large = Array.from({ length: 64 }, () =>
        Array.from({ length: 64 }, () => "x".repeat(2048)),
      );
      writer.checkpoint({ traceState: "running", large });
      await expect(writer.flush()).rejects.toThrow("2 MiB");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        traceState: "running",
        sequence: 0,
      });
      expect(await readdir(directory)).toEqual(["trace.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
