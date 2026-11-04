import { randomUUID } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
} from "../../packages/protocol/src/constants.js";
import { FrameDecoder } from "../../packages/protocol/src/framing.js";
import type { MessageEnvelope } from "../../packages/protocol/src/schemas.js";
import {
  AcceptanceBridgeTimingProxy,
  ACCEPTANCE_BRIDGE_TIMING_LIMITS,
  type AcceptanceBridgeTimingEvent,
} from "../../tests/electron/acceptance-bridge-timing.js";

const proxies: AcceptanceBridgeTimingProxy[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function rawFrame(message: object): Buffer {
  // Deliberate whitespace and unknown fields detect accidental reserialization.
  const payload = Buffer.from(JSON.stringify(message, null, 2));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function request(command = "listening.inspect_context", params = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "request" as const,
    requestId: randomUUID(),
    command,
    params,
    traceId: randomUUID(),
  };
}

function response(requestId: string, ok = true) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok,
    ...(ok
      ? { result: { preserved: "  original bytes  " } }
      : {
          error: {
            code: "internal_error",
            message: "test failure",
            retryable: false,
          },
        }),
    traceId: randomUUID(),
  };
}

function event(sequence: number, payload: unknown = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "event",
    event: "test.changed",
    sequence,
    payload,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test port");
  return address.port;
}

async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function harness(
  minimumReadMs = 100,
  onEvent?: (event: AcceptanceBridgeTimingEvent) => void,
) {
  let upstream: Socket | undefined;
  const upstreamBytes: Buffer[] = [];
  const messages: MessageEnvelope[] = [];
  const server = createServer((socket) => {
    upstream = socket;
    sockets.push(socket);
    socket.on("error", () => {});
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      upstreamBytes.push(chunk);
      messages.push(...decoder.push(chunk));
    });
  });
  servers.push(server);
  const upstreamPort = await listen(server);
  const proxy = new AcceptanceBridgeTimingProxy({
    minimumReadMs,
    testOnlyUpstreamPort: upstreamPort,
    ...(onEvent ? { onEvent } : {}),
  });
  proxies.push(proxy);
  const port = await proxy.start();
  const client = await connect(port);
  const received: Buffer[] = [];
  client.on("data", (chunk: Buffer) => received.push(chunk));
  await vi.waitFor(() => expect(upstream).toBeDefined(), { interval: 2 });
  return {
    proxy,
    client,
    upstream: upstream!,
    port,
    messages,
    sent: () => Buffer.concat(upstreamBytes),
    received: () => Buffer.concat(received),
  };
}

async function waitFor(check: () => void): Promise<void> {
  await vi.waitFor(check, { interval: 2, timeout: 3000 });
}

describe("AcceptanceBridgeTimingProxy", () => {
  it.each([0, -1, 1001, NaN, Infinity])(
    "rejects invalid minimum %s",
    (minimumReadMs) => {
      expect(() => new AcceptanceBridgeTimingProxy({ minimumReadMs })).toThrow(
        RangeError,
      );
    },
  );

  it.each([
    ["listening.inspect_session_source", true],
    ["live_set.get_identity", false],
    ["listening.inspect_context", true],
    ["listening.inspect_session_pass", false],
  ])(
    "enforces the request-relative lower bound for %s (ok=%s)",
    async (command, ok) => {
      const h = await harness(100);
      const req = request(command);
      const start = performance.now();
      h.client.write(rawFrame(req));
      await waitFor(() => expect(h.messages).toHaveLength(1));
      const raw = rawFrame(response(req.requestId, ok));
      h.upstream.write(raw);
      await waitFor(() => expect(h.received()).toEqual(raw));
      expect(performance.now() - start).toBeGreaterThanOrEqual(100);
      const receipt = h.proxy
        .snapshot()
        .records.find((record) => record.requestId === req.requestId)!;
      expect(receipt.state).toBe("completed");
      expect(receipt.responseOk).toBe(ok);
      expect(receipt.observedResponseMs).toBeLessThan(100);
      expect(receipt.deliveredRoundTripMs).toBeGreaterThanOrEqual(100);
      expect(h.proxy.snapshot().failure).toBeUndefined();
    },
  );

  it("does not add the configured minimum after an already slow response", async () => {
    const h = await harness(300);
    const req = request();
    h.client.write(rawFrame(req));
    await waitFor(() => expect(h.messages).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 320));
    const start = performance.now();
    const raw = rawFrame(response(req.requestId));
    h.upstream.write(raw);
    await waitFor(() => expect(h.received()).toEqual(raw));
    expect(performance.now() - start).toBeLessThan(250);
    expect(
      h.proxy.snapshot().records.find((r) => r.requestId === req.requestId)
        ?.observedResponseMs,
    ).toBeGreaterThanOrEqual(300);
  });

  it.each(["system.authenticate", "system.ping", "live_set.set_tempo"])(
    "does not delay %s",
    async (command) => {
      const h = await harness(1000);
      const req = request(command);
      const start = performance.now();
      h.client.write(rawFrame(req));
      await waitFor(() => expect(h.messages).toHaveLength(1));
      const raw = rawFrame(response(req.requestId));
      h.upstream.write(raw);
      await waitFor(() => expect(h.received()).toEqual(raw));
      expect(performance.now() - start).toBeLessThan(800);
      expect(
        h.proxy.snapshot().records.find((r) => r.requestId === req.requestId)
          ?.minimumReadMs,
      ).toBe(0);
    },
  );

  it("preserves fragmented/coalesced raw bytes and global downstream ordering, including auth and events", async () => {
    const h = await harness(180);
    const first = request();
    const auth = request("system.authenticate", { token: "secret" });
    const requests = Buffer.concat([rawFrame(first), rawFrame(auth)]);
    for (const [start, end] of [
      [0, 1],
      [1, 3],
      [3, 21],
      [21, requests.length],
    ]) {
      h.client.write(requests.subarray(start, end));
    }
    await waitFor(() => expect(h.messages).toHaveLength(2));
    expect(h.sent()).toEqual(requests);
    const frames = [
      rawFrame(event(1)),
      rawFrame(response(first.requestId)),
      rawFrame(event(2)),
      rawFrame(response(auth.requestId)),
    ];
    const all = Buffer.concat(frames);
    h.upstream.write(all.subarray(0, frames[0]!.length));
    await waitFor(() => expect(h.received()).toEqual(frames[0]));
    const offset = frames[0]!.length;
    for (const [start, end] of [
      [offset, offset + 1],
      [offset + 1, offset + 3],
      [offset + 3, offset + 35],
      [offset + 35, all.length],
    ]) {
      h.upstream.write(all.subarray(start, end));
    }
    await waitFor(() => expect(h.proxy.snapshot().pendingFrames).toBe(3));
    expect(h.received()).toEqual(frames[0]);
    await waitFor(() => expect(h.received()).toEqual(all));
    expect(new FrameDecoder().push(h.received()).map((m) => m.kind)).toEqual([
      "event",
      "response",
      "event",
      "response",
    ]);
  });

  it("exposes lifecycle timing without tokens, request arguments, bodies or uncontrolled command names", async () => {
    const events: AcceptanceBridgeTimingEvent[] = [];
    const h = await harness(20, (event) => events.push(event));
    const secret = "Bearer private-token-value";
    const req = request(secret, {
      token: secret,
      path: "/private/project",
      audio: secret,
    });
    h.client.write(rawFrame(req));
    await waitFor(() => expect(h.messages).toHaveLength(1));
    const raw = rawFrame({
      ...response(req.requestId),
      result: { token: secret },
    });
    h.upstream.write(raw);
    await waitFor(() => expect(h.received()).toEqual(raw));
    await h.proxy.close();
    const snapshot = h.proxy.snapshot();
    expect(JSON.stringify({ snapshot, events })).not.toContain(secret);
    expect(JSON.stringify({ snapshot, events })).not.toContain(
      "/private/project",
    );
    expect(
      snapshot.records.find((r) => r.requestId === req.requestId)?.command,
    ).toBe("[other]");
    expect(
      events
        .filter((e) => e.record.requestId === req.requestId)
        .map((e) => e.phase),
    ).toEqual(["queued", "started", "progress", "completed"]);
    expect(
      snapshot.records.every(
        (r) => r.endedMs !== undefined && r.endedMs >= r.queuedMs,
      ),
    ).toBe(true);
    snapshot.records[0]!.failure = secret;
    expect(JSON.stringify(h.proxy.snapshot())).not.toContain(secret);
  });

  it("cancels delayed work, clears buffers/timers, closes owned sockets and is idempotent", async () => {
    const h = await harness(1000);
    const req = request();
    h.client.write(rawFrame(req));
    await waitFor(() => expect(h.messages).toHaveLength(1));
    h.upstream.write(rawFrame(response(req.requestId)));
    await waitFor(() => expect(h.proxy.snapshot().pendingFrames).toBe(1));
    await h.proxy.close();
    await h.proxy.close();
    const snapshot = h.proxy.snapshot();
    expect(snapshot).toMatchObject({
      state: "closed",
      activeTunnels: 0,
      pendingBytes: 0,
      pendingFrames: 0,
    });
    expect(snapshot.failure).toBeUndefined();
    expect(
      snapshot.records.find((r) => r.requestId === req.requestId)?.state,
    ).toBe("cancelled");
    expect(h.received()).toHaveLength(0);
    await expect(connect(h.port)).rejects.toThrow();
    await waitFor(() => expect(h.upstream.destroyed).toBe(true));
  });

  it("records connection refusal and tears down instead of silently bypassing", async () => {
    const server = createServer();
    const unavailable = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const proxy = new AcceptanceBridgeTimingProxy({
      minimumReadMs: 10,
      testOnlyUpstreamPort: unavailable,
    });
    proxies.push(proxy);
    const port = await proxy.start();
    await connect(port);
    await waitFor(() =>
      expect(proxy.snapshot().failure).toBe("upstream_socket_error"),
    );
    await proxy.close();
    expect(proxy.snapshot()).toMatchObject({
      state: "failed",
      activeTunnels: 0,
    });
  });

  it.each(["count", "bytes"])(
    "fails explicitly on downstream queue %s overflow",
    async (bound) => {
      const h = await harness(1000);
      const req = request();
      h.client.write(rawFrame(req));
      await waitFor(() => expect(h.messages).toHaveLength(1));
      h.upstream.write(rawFrame(response(req.requestId)));
      const count =
        bound === "count" ? ACCEPTANCE_BRIDGE_TIMING_LIMITS.pendingFrames : 3;
      const payload = bound === "bytes" ? "x".repeat(3 * 1024 * 1024) : {};
      for (let index = 0; index < count; index++)
        h.upstream.write(rawFrame(event(index, payload)));
      await waitFor(() =>
        expect(h.proxy.snapshot().failure).toBe(
          "downstream_queue_limit_exceeded",
        ),
      );
      await h.proxy.close();
      expect(h.received()).toHaveLength(0);
      expect(h.proxy.snapshot()).toMatchObject({
        activeTunnels: 0,
        pendingBytes: 0,
        pendingFrames: 0,
      });
    },
  );

  it("rejects a fifth concurrent tunnel", async () => {
    const h = await harness();
    for (let index = 0; index < 4; index++) await connect(h.port);
    await waitFor(() =>
      expect(h.proxy.snapshot().failure).toBe("tunnel_limit_exceeded"),
    );
    await h.proxy.close();
    expect(h.proxy.snapshot().activeTunnels).toBe(0);
  });

  it("bounds retained receipts and fails closed rather than dropping evidence", async () => {
    const h = await harness();
    h.client.write(
      Buffer.concat(
        Array.from({ length: 512 }, () => rawFrame(request("system.ping"))),
      ),
    );
    await waitFor(() =>
      expect(h.proxy.snapshot().failure).toBe("evidence_limit_exceeded"),
    );
    await h.proxy.close();
    expect(h.proxy.snapshot().records.length).toBeLessThanOrEqual(512);
    expect(h.proxy.snapshot().records.at(-1)?.stage).toBe("close");
  });

  it.each(["zero", "oversized", "invalid-json", "truncated"])(
    "fails closed for %s upstream frames without leaking payloads",
    async (kind) => {
      const h = await harness();
      const header = Buffer.alloc(4);
      if (kind === "oversized")
        header.writeUInt32BE(DEFAULT_MAX_FRAME_BYTES + 1);
      if (kind === "invalid-json") header.writeUInt32BE(6);
      if (kind === "truncated") header.writeUInt32BE(200);
      h.upstream.write(
        kind === "invalid-json"
          ? Buffer.concat([header, Buffer.from("secret")])
          : header,
      );
      if (kind === "truncated") h.upstream.end();
      await waitFor(() =>
        expect(h.proxy.snapshot().failure).toBe(
          kind === "truncated"
            ? "truncated_upstream_frame"
            : "invalid_upstream_frame",
        ),
      );
      expect(JSON.stringify(h.proxy.snapshot())).not.toContain("secret");
      expect(h.received()).toHaveLength(0);
    },
  );

  it("fails on an upstream disconnect with delayed work", async () => {
    const h = await harness(1000);
    const req = request();
    h.client.write(rawFrame(req));
    await waitFor(() => expect(h.messages).toHaveLength(1));
    h.upstream.end(rawFrame(response(req.requestId)));
    await waitFor(() =>
      expect(h.proxy.snapshot().failure).toBe(
        "upstream_closed_with_pending_work",
      ),
    );
    expect(h.received()).toHaveLength(0);
  });

  it("fails safely when the observer throws", async () => {
    const proxy = new AcceptanceBridgeTimingProxy({
      minimumReadMs: 1,
      onEvent: () => {
        throw new Error("secret observer details");
      },
    });
    proxies.push(proxy);
    await expect(proxy.start()).rejects.toThrow("event_callback_failed");
    await proxy.close();
    expect(proxy.snapshot().failure).toBe("event_callback_failed");
    expect(JSON.stringify(proxy.snapshot())).not.toContain("secret");
  });

  it("cancels startup without leaving a listening server", async () => {
    const proxy = new AcceptanceBridgeTimingProxy({ minimumReadMs: 1 });
    proxies.push(proxy);
    const started = proxy.start();
    const rejected = expect(started).rejects.toThrow("start_cancelled");
    await proxy.close();
    await rejected;
    expect(proxy.snapshot()).toMatchObject({
      state: "closed",
      activeTunnels: 0,
    });
    await expect(proxy.start()).rejects.toThrow("timing_proxy_not_idle");
  });

  it("records a clean idle disconnect as completed", async () => {
    const h = await harness();
    h.client.end();
    await waitFor(() => expect(h.proxy.snapshot().activeTunnels).toBe(0));
    expect(h.proxy.snapshot().failure).toBeUndefined();
    expect(
      h.proxy.snapshot().records.find((r) => r.stage === "tunnel")?.state,
    ).toBe("completed");
  });

  it.each(["duplicate-request", "unmatched-response", "bad-client-frame"])(
    "fails closed for %s",
    async (kind) => {
      const h = await harness();
      const req = request();
      if (kind === "duplicate-request")
        h.client.write(Buffer.concat([rawFrame(req), rawFrame(req)]));
      if (kind === "unmatched-response")
        h.upstream.write(rawFrame(response(req.requestId)));
      if (kind === "bad-client-frame") h.client.write(Buffer.alloc(4));
      const failure = {
        "duplicate-request": "duplicate_request_id",
        "unmatched-response": "unmatched_response",
        "bad-client-frame": "invalid_client_frame",
      }[kind];
      await waitFor(() => expect(h.proxy.snapshot().failure).toBe(failure));
      await h.proxy.close();
      expect(h.proxy.snapshot().activeTunnels).toBe(0);
    },
  );
});
