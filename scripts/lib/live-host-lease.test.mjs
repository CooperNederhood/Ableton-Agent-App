import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLiveHostAutomationStorage } from "../../packages/storage/dist/index.js";
import {
  acquireLiveHostLease,
  isLiveHostLease,
  reserveLiveHostLease,
  unreserveLiveHostLease,
} from "./live-host-lease.mjs";

const roots = [];
function options() {
  const homeDirectory = resolve(
    ".test-artifacts",
    `host-lease-${randomUUID()}`,
  );
  roots.push(homeDirectory);
  return { homeDirectory };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Live host lease", () => {
  it("narrows only authentic lease capabilities, never structural mocks", async () => {
    expect(isLiveHostLease(undefined)).toBe(false);
    expect(isLiveHostLease(null)).toBe(false);
    expect(isLiveHostLease("lease")).toBe(false);
    expect(isLiveHostLease({ release: async () => undefined })).toBe(false);
    const lease = await acquireLiveHostLease(options());
    expect(isLiveHostLease(lease)).toBe(true);
    expect(isLiveHostLease({ ...lease })).toBe(false);
    await lease.release();
    expect(isLiveHostLease(lease)).toBe(true);
    await expect(lease.assertOwned()).rejects.toThrow("released");
  });
  it("records private bounded process identity, unique token, causal lifecycle and safe release", async () => {
    const opts = options();
    const events = [];
    const lease = await acquireLiveHostLease({
      ...opts,
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
      onEvent: (event) => events.push(event),
    });
    const { leaseDirectory } = resolveLiveHostAutomationStorage(opts);
    const [owner] = await readdir(leaseDirectory);
    const record = JSON.parse(
      await readFile(join(leaseDirectory, owner), "utf8"),
    );
    expect(record).toMatchObject({
      version: 1,
      pid: process.pid,
      startedAt: expect.any(String),
      commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      ownerToken: expect.any(String),
    });
    expect(record.command).toBeUndefined();
    expect((await stat(join(leaseDirectory, owner))).mode & 0o777).toBe(0o600);
    await lease.assertOwned();
    await lease.release();
    await lease.release();
    expect(events.map(({ type }) => type)).toEqual([
      "live.host_lease.queued",
      "live.host_lease.started",
      "live.host_lease.completed",
      "live.host_lease.release_started",
      "live.host_lease.released",
    ]);
    expect(
      events.every(
        (event) =>
          event.traceId === "trace" &&
          event.correlationId === "correlation" &&
          event.causationId === "cause" &&
          event.durationMs >= 0,
      ),
    ).toBe(true);
    await expect(lease.assertOwned()).rejects.toThrow("released");
    const second = await acquireLiveHostLease(opts);
    const [secondOwner] = await readdir(leaseDirectory);
    expect(secondOwner).not.toBe(owner);
    await second.release();
  });

  it("admits exactly one concurrent runner regardless of per-run root/profile", async () => {
    const opts = options();
    vi.stubEnv("LIVE_AGENT_HOME", join(opts.homeDirectory, "worktree-a"));
    vi.stubEnv("LIVE_AGENT_PROFILE", "first");
    const first = acquireLiveHostLease(opts);
    vi.stubEnv("LIVE_AGENT_HOME", join(opts.homeDirectory, "worktree-b"));
    vi.stubEnv("LIVE_AGENT_PROFILE", "second");
    const results = await Promise.allSettled([
      first,
      acquireLiveHostLease(opts),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await results.find(({ status }) => status === "fulfilled").value.release();
  });

  it("excludes independent processes launched from different worktree roots", async () => {
    const opts = options();
    const moduleUrl = new URL("./live-host-lease.mjs", import.meta.url).href;
    const code = `
      import { acquireLiveHostLease } from ${JSON.stringify(moduleUrl)};
      try {
        const lease = await acquireLiveHostLease({ homeDirectory: ${JSON.stringify(opts.homeDirectory)} });
        process.on("message", async () => { await lease.release(); process.disconnect(); });
        process.send("acquired");
      } catch {
        process.send("denied");
        process.disconnect();
      }
    `;
    const children = [];
    try {
      const runs = await Promise.all(
        ["a", "b"].map(async (profile) => {
          const cwd = join(opts.homeDirectory, `worktree-${profile}`);
          await mkdir(cwd, { recursive: true });
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", code],
            {
              cwd,
              env: {
                ...process.env,
                LIVE_AGENT_HOME: join(cwd, "profile-root"),
                LIVE_AGENT_PROFILE: profile,
              },
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            },
          );
          children.push(child);
          const exit = once(child, "exit");
          const [message] = await once(child, "message");
          return { child, message, exit };
        }),
      );
      expect(runs.map(({ message }) => message).sort()).toEqual([
        "acquired",
        "denied",
      ]);
      runs.find(({ message }) => message === "acquired").child.send("release");
      await Promise.all(runs.map(({ exit }) => exit));
      const next = await acquireLiveHostLease(opts);
      await next.release();
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exit = once(child, "exit");
          child.kill("SIGTERM");
          await exit;
        }
      }
    }
  });

  it.each(["stale-pid", "empty", "malformed"])(
    "never reclaims %s ownership by age or PID alone",
    async (mode) => {
      const opts = options();
      const { leaseDirectory } = resolveLiveHostAutomationStorage(opts);
      await mkdir(leaseDirectory, { recursive: true });
      if (mode !== "empty") {
        await writeFile(
          join(leaseDirectory, "owner-foreign.json"),
          mode === "malformed"
            ? "invalid"
            : JSON.stringify({
                pid: 2147483647,
                startedAt: "1970-01-01",
                ownerToken: "foreign",
              }),
        );
      }
      await expect(acquireLiveHostLease(opts)).rejects.toThrow("already held");
      expect(await readdir(leaseDirectory)).toHaveLength(
        mode === "empty" ? 0 : 1,
      );
    },
  );

  it.each(["replaced-directory", "replaced-token"])(
    "refuses to release or reserve a %s",
    async (mode) => {
      const opts = options();
      const lease = await acquireLiveHostLease(opts);
      const { leaseDirectory } = resolveLiveHostAutomationStorage(opts);
      if (mode === "replaced-directory") {
        await rename(leaseDirectory, `${leaseDirectory}.old`);
        await mkdir(leaseDirectory);
        await writeFile(join(leaseDirectory, "foreign.json"), "foreign");
      } else {
        const [name] = await readdir(leaseDirectory);
        await writeFile(join(leaseDirectory, name), "{}");
      }
      const before = await readdir(leaseDirectory);
      await expect(lease.release()).rejects.toThrow();
      await expect(reserveLiveHostLease(lease, {})).rejects.toThrow();
      expect(await readdir(leaseDirectory)).toEqual(before);
    },
  );

  it("requires an authentic in-process handle and retains uncertain cleanup", async () => {
    const opts = options();
    await expect(
      reserveLiveHostLease({ assertOwned: async () => undefined }, {}),
    ).rejects.toThrow("Invalid");
    const lease = await acquireLiveHostLease(opts);
    const owner = {};
    await reserveLiveHostLease(lease, owner);
    await expect(reserveLiveHostLease(lease, {})).rejects.toThrow(
      "active controller",
    );
    expect(() => unreserveLiveHostLease(lease, {})).toThrow("not owned");
    await expect(lease.release()).rejects.toThrow("reserved");
    unreserveLiveHostLease(lease, owner);
    lease.retain();
    await expect(lease.release()).rejects.toThrow("uncertain");
    await expect(acquireLiveHostLease(opts)).rejects.toThrow("already held");
  });

  it("serializes release against a concurrently starting controller", async () => {
    const lease = await acquireLiveHostLease(options());
    const releasing = lease.release();
    await expect(reserveLiveHostLease(lease, {})).rejects.toThrow("releasing");
    await releasing;
  });

  it("retains an incomplete release rather than deleting foreign entries", async () => {
    const opts = options();
    const events = [];
    const lease = await acquireLiveHostLease({
      ...opts,
      onEvent: (event) => events.push(event.type),
    });
    const { leaseDirectory } = resolveLiveHostAutomationStorage(opts);
    await writeFile(join(leaseDirectory, "foreign.json"), "foreign");
    await expect(lease.release()).rejects.toThrow();
    expect(await readFile(join(leaseDirectory, "foreign.json"), "utf8")).toBe(
      "foreign",
    );
    expect(events.at(-1)).toBe("live.host_lease.release_failed");
    await expect(acquireLiveHostLease(opts)).rejects.toThrow("already held");
  });

  it("cancels before acquisition without leaving a lock and reports cancellation", async () => {
    const opts = options();
    const abort = new globalThis.AbortController();
    const events = [];
    abort.abort();
    await expect(
      acquireLiveHostLease({
        ...opts,
        signal: abort.signal,
        onEvent: (event) => events.push(event.type),
      }),
    ).rejects.toThrow();
    expect(events).toEqual([
      "live.host_lease.queued",
      "live.host_lease.cancelled",
    ]);
    const lease = await acquireLiveHostLease(opts);
    await lease.release();
  });

  it("cancels after identity inspection without taking the lock", async () => {
    const opts = options();
    const abort = new globalThis.AbortController();
    await expect(
      acquireLiveHostLease({
        ...opts,
        signal: abort.signal,
        inspectOwner: async () => {
          abort.abort();
          return {
            pid: 1,
            startedAt: "Mon Jan 1 00:00:00 2026",
            commandSha256: "a".repeat(64),
          };
        },
      }),
    ).rejects.toThrow();
    const lease = await acquireLiveHostLease(opts);
    await lease.release();
  });

  it("cleans up a completed acquisition cancelled before returning its handle", async () => {
    const opts = options();
    const abort = new globalThis.AbortController();
    const events = [];
    await expect(
      acquireLiveHostLease({
        ...opts,
        signal: abort.signal,
        onEvent(event) {
          events.push(event.type);
          if (event.type === "live.host_lease.completed") abort.abort();
        },
      }),
    ).rejects.toThrow();
    expect(events.slice(-3)).toEqual([
      "live.host_lease.release_started",
      "live.host_lease.released",
      "live.host_lease.cancelled",
    ]);
    const lease = await acquireLiveHostLease(opts);
    await lease.release();
  });

  it("does not persist extra identity fields and ignores failing observers", async () => {
    const opts = options();
    const lease = await acquireLiveHostLease({
      ...opts,
      inspectOwner: async () => ({
        pid: 1,
        startedAt: "Mon Jan 1 00:00:00 2026",
        commandSha256: "a".repeat(64),
        command: "token=secret",
      }),
      onEvent: () => {
        throw new Error("observer failed");
      },
    });
    const { leaseDirectory } = resolveLiveHostAutomationStorage(opts);
    const [name] = await readdir(leaseDirectory);
    expect(await readFile(join(leaseDirectory, name), "utf8")).not.toContain(
      "secret",
    );
    await lease.release();
  });

  it("rejects invalid identity without persisting unbounded or credential-bearing metadata", async () => {
    const opts = options();
    const onEvent = vi.fn();
    await expect(
      acquireLiveHostLease({
        ...opts,
        onEvent,
        inspectOwner: async () => ({
          pid: 1,
          startedAt: "x".repeat(129),
          commandSha256: "token=secret",
        }),
      }),
    ).rejects.toThrow("Invalid");
    expect(onEvent.mock.calls.at(-1)[0].type).toBe("live.host_lease.failed");
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("secret");
    const lease = await acquireLiveHostLease(opts);
    await lease.release();
  });
});
