import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { waitForNativeBridge } from "./native-bridge-readiness.mjs";

function fixture() {
  let time = 0;
  return {
    port: 8765,
    timeoutMs: 250,
    now: () => time,
    delay: vi.fn(async (ms) => {
      time += ms;
    }),
    validateOwnership: vi.fn(async () => {}),
    probeConnection: vi.fn(async () => {}),
  };
}

describe("owned native bridge startup readiness", () => {
  it("waits through cold-start refusals and checks ownership before and after readiness", async () => {
    const f = fixture();
    f.probeConnection
      .mockRejectedValueOnce(
        Object.assign(new Error("cold"), { code: "ECONNREFUSED" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("cold"), { code: "ECONNREFUSED" }),
      );
    await expect(waitForNativeBridge(f)).resolves.toEqual({
      attempts: 3,
      elapsedMs: 200,
    });
    expect(f.validateOwnership).toHaveBeenCalledTimes(4);
    expect(f.probeConnection.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.validateOwnership.mock.invocationCallOrder[0],
    );
    expect(f.validateOwnership.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      f.probeConnection.mock.invocationCallOrder.at(-1),
    );
    expect(f.delay).toHaveBeenCalledTimes(2);
  });

  it("fails at the bounded deadline without claiming readiness", async () => {
    const f = fixture();
    f.probeConnection.mockRejectedValue(
      Object.assign(new Error("cold"), { code: "ECONNREFUSED" }),
    );
    await expect(waitForNativeBridge(f)).rejects.toThrow(
      "deadline exceeded after 3 probes (ECONNREFUSED)",
    );
    expect(f.delay.mock.calls.map(([ms]) => ms)).toEqual([100, 100, 50]);
  });

  it("does not retry authentication, permission or other errors", async () => {
    const f = fixture();
    f.probeConnection.mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    await expect(waitForNativeBridge(f)).rejects.toThrow("denied");
    expect(f.probeConnection).toHaveBeenCalledOnce();
    expect(f.delay).not.toHaveBeenCalled();
  });

  it("never probes a foreign process and detects ownership lost after a connection", async () => {
    for (const afterConnect of [false, true]) {
      const f = fixture();
      if (afterConnect) f.validateOwnership.mockResolvedValueOnce(undefined);
      f.validateOwnership.mockRejectedValue(new Error("foreign PID"));
      await expect(waitForNativeBridge(f)).rejects.toThrow("foreign PID");
      expect(f.probeConnection).toHaveBeenCalledTimes(afterConnect ? 1 : 0);
    }
  });

  it("cancels before probing or during the startup wait", async () => {
    for (const duringWait of [false, true]) {
      const f = fixture();
      const controller = new globalThis.AbortController();
      if (duringWait) {
        f.probeConnection.mockRejectedValue(
          Object.assign(new Error("cold"), { code: "ECONNREFUSED" }),
        );
        f.delay.mockImplementation(async () => {
          controller.abort();
        });
      } else controller.abort();
      await expect(
        waitForNativeBridge({ ...f, signal: controller.signal }),
      ).rejects.toThrow();
      expect(f.probeConnection).toHaveBeenCalledTimes(duringWait ? 1 : 0);
    }
  });

  it("probes an actual loopback listener and releases its socket", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await waitForNativeBridge({
        port: server.address().port,
        timeoutMs: 1000,
        validateOwnership: async () => {},
      });
      expect(result.attempts).toBe(1);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
