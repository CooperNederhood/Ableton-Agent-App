import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type RequestEnvelope,
  type SessionListeningPassParams,
  type SessionListeningPassResult,
} from "@ableton-agent/protocol";
import { withCorrelation } from "@ableton-agent/correlation";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { InMemoryEventPublisher, type AppEvent } from "@ableton-agent/shared";
import { AbletonBridgeService } from "./index.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = {
  schemaVersion: 1 as const,
  ownerId: uuid(1),
  passId: uuid(2),
};
const actions = ["prepare", "launch", "inspect", "release"] as const;
const commands = Object.fromEntries(
  actions.map((action) => [action, `listening.${action}_session_pass`]),
);
function params(action: (typeof actions)[number]): SessionListeningPassParams {
  if (action === "prepare") {
    const track = {
      kind: "regular" as const,
      index: 0,
      expectedReference: uuid(3),
      expectedName: "Track",
    };
    return {
      ...identity,
      action,
      expectedLiveSetId: "set",
      expectedProjectRevision: 1,
      target: {
        view: "session",
        track,
        sceneIndex: 0,
        expectedClipReference: uuid(4),
        expectedClipName: "Clip",
      },
      listener: {
        track,
        deviceIndex: 1,
        expectedDeviceReference: uuid(5),
        expectedDeviceName: "Listener",
        expectedClassName: "MxDeviceAudioEffect",
      },
      durationBeats: 4,
      timingAnchor: { globalBeat: 0 },
    };
  }
  return action === "release"
    ? { ...identity, action, reason: "completed" }
    : { ...identity, action };
}
function receipt(request: RequestEnvelope): SessionListeningPassResult {
  return {
    ...identity,
    status: request.command === commands.release ? "released" : "prepared",
    mutationState: "not-attempted",
    reason: null,
    cleanupPolicy: "leave-running",
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    lastObservedSource: {
      transportPlaying: false,
      globalBeat: 0,
      startTimeBeats: null,
      playingPosition: 0,
      targetPlaying: false,
      targetTriggered: false,
      targetRecording: false,
      playingSlotIndex: -1,
      firedSlotIndex: -1,
      selectedClipReference: null,
    },
    sourceEpoch: null,
    followActionState: "unknown",
    limitations: ["Message-rate only", "Unknown follow actions"],
    durationBeats: 4,
    expiresInMs: 30_000,
  };
}
const resources: { server: Server; service: AbletonBridgeService }[] = [];
afterEach(async () => {
  for (const { server, service } of resources.splice(0)) {
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture(
  options: {
    supported?: boolean;
    transform?: (
      result: SessionListeningPassResult,
    ) => SessionListeningPassResult;
    onRequest?: (request: Pick<RequestEnvelope, "command">) => void;
  } = {},
) {
  const requests: RequestEnvelope[] = [];
  const events: AppEvent[] = [];
  const telemetry: TelemetryEventEnvelope[] = [];
  const publisher = new InMemoryEventPublisher();
  publisher.subscribe((event) => events.push(event));
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk)) {
        if (request.kind !== "request") continue;
        requests.push(request);
        const result =
          request.command === "system.hello"
            ? {
                selectedProtocolVersion: PROTOCOL_VERSION,
                liveVersion: "11.3.43",
                remoteScriptVersion: "test",
                liveSetId: "set",
                liveSetName: "Set",
                saved: true,
                diagnostics: [],
                capabilities: Object.fromEntries(
                  Object.values(commands).map((name) => [
                    name,
                    options.supported !== false,
                  ]),
                ),
                limits: { maxFrameBytes: 1_048_576, maxBatchItems: 128 },
              }
            : (options.transform?.(receipt(request)) ?? receipt(request));
        socket.write(
          encodeFrame({
            protocolVersion: PROTOCOL_VERSION,
            kind: "response",
            requestId: request.requestId,
            ok: true,
            result,
            warnings: [],
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const service = new AbletonBridgeService({
    authenticationToken: "test-token-that-is-at-least-thirty-two-characters",
    port: address.port,
    events: publisher,
    telemetry: { enqueue: (event) => telemetry.push(event) },
    ...(options.onRequest ? { onRequest: options.onRequest } : {}),
  });
  resources.push({ server, service });
  await service.start();
  return { service, requests, events, telemetry };
}

describe("typed Session source pass bridge", () => {
  it("dispatches granular commands with owner/trace attribution and only one mutation", async () => {
    const f = await fixture();
    await withCorrelation(
      {
        correlationId: "session-pass",
        traceId: uuid(10),
        causationId: "cause",
        sessionId: "session",
        activeAgentId: "agent",
      },
      async () => {
        for (const action of actions)
          await f.service.sessionListeningPass(params(action));
      },
    );
    const sent = f.requests.filter(
      (request) => request.command !== "system.hello",
    );
    expect(sent.map((request) => request.command)).toEqual(
      Object.values(commands),
    );
    const dispatched = f.telemetry.filter(
      (event) =>
        event.name === "bridge.request.dispatched" &&
        sent.some(
          (request) => request.requestId === event.attributes.requestId,
        ),
    );
    expect(dispatched).toHaveLength(4);
    expect(
      dispatched.every(
        (event) =>
          event.correlationId === "session-pass" &&
          event.causationId === "cause" &&
          event.trace?.traceId === uuid(10),
      ),
    ).toBe(true);
    expect(
      f.events.filter((event) => event.type === "ableton.project_mutated"),
    ).toHaveLength(1);
  });

  it.each(actions)("fails closed when %s is not advertised", async (action) => {
    const f = await fixture({ supported: false });
    await expect(
      f.service.sessionListeningPass(params(action)),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(f.requests).toHaveLength(1);
  });

  it.each(["ownerId", "passId", "durationBeats"] as const)(
    "rejects mismatched %s receipts",
    async (field) => {
      const f = await fixture({
        transform: (value) => ({
          ...value,
          [field]: field === "durationBeats" ? 3 : uuid(100),
        }),
      });
      await expect(
        f.service.sessionListeningPass(params("prepare")),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  it("fences cancellation immediately before launch dispatch, without a mutation event", async () => {
    const controller = new AbortController();
    const f = await fixture({
      onRequest: (request) => {
        if (request.command === commands.launch) controller.abort();
      },
    });
    await expect(
      f.service.sessionListeningPass(params("launch"), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { mutated: false, dispatchState: "cancelled-before-dispatch" },
    });
    expect(f.requests).toHaveLength(1);
    expect(
      f.events.filter((event) => event.type === "ableton.project_mutated"),
    ).toHaveLength(0);
  });
});
