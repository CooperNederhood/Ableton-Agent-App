import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

function probe({ port, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port, signal });
    const finish = (error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", finish);
    socket.setTimeout(timeoutMs, () => {
      const error = new Error("Native bridge startup probe timed out");
      error.code = "ETIMEDOUT";
      finish(error);
    });
  });
}

export async function waitForNativeBridge({
  port,
  validateOwnership,
  timeoutMs = 60000,
  signal,
  probeConnection = probe,
  delay = sleep,
  now = () => performance.now(),
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid native bridge startup port");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error("Invalid native bridge startup timeout");
  const started = now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let lastCode = "not_attempted";
  while (now() < deadline) {
    signal?.throwIfAborted();
    await validateOwnership();
    attempts++;
    try {
      await probeConnection({
        port,
        timeoutMs: Math.max(1, Math.min(1000, deadline - now())),
        signal,
      });
      signal?.throwIfAborted();
      await validateOwnership();
      if (now() >= deadline) break;
      return { attempts, elapsedMs: now() - started };
    } catch (error) {
      if (!["ECONNREFUSED", "ETIMEDOUT"].includes(error?.code)) throw error;
      lastCode = error.code;
    }
    const remaining = deadline - now();
    if (remaining > 0)
      await delay(Math.min(100, remaining), undefined, { signal });
  }
  signal?.throwIfAborted();
  throw new Error(
    `Native bridge startup deadline exceeded after ${attempts} probes (${lastCode})`,
  );
}
