import { describe, expect, it, vi } from "vitest";

import type {
  AgentEventListener,
  LiveEventDefinition,
  LiveEventOccurrence,
} from "@ableton-agent/agent-config";
import type {
  AbletonLiveEvent,
  LiveEventReconciliationSignal,
  LiveEventSubscriptionStatus,
} from "@ableton-agent/bridge";
import type {
  InspectDeviceParametersParams,
  InspectDevicesParams,
  SubscribeEventParams,
  SubscribeEventResult,
} from "@ableton-agent/protocol";
import {
  telemetryEventEnvelopeSchema,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";

import {
  DefaultLiveEventRuntime,
  type AgentLiveEventListener,
  type LiveEventBridge,
} from "./live-event-runtime.js";

const trackReference = "00000000-0000-4000-8000-000000000010";
const deviceReference = "00000000-0000-4000-8000-000000000011";
const parameterReference = "00000000-0000-4000-8000-000000000012";
const eventOne = "live-event.00000000-0000-4000-8000-000000000001";
const eventTwo = "live-event.00000000-0000-4000-8000-000000000002";
const listenerOne = "event-listener.00000000-0000-4000-8000-000000000001";
const listenerTwo = "event-listener.00000000-0000-4000-8000-000000000002";

function definition(
  id = eventOne,
  kind:
    | "track.playing_clip_changed"
    | "parameter.value_changed" = "track.playing_clip_changed",
): LiveEventDefinition {
  const base = {
    id,
    name: id,
    projectId: "project",
    enabled: true,
    createdAt: "2026-08-29T18:00:00.000Z",
    updatedAt: "2026-08-29T18:00:00.000Z",
  };
  return kind === "parameter.value_changed"
    ? {
        ...base,
        kind,
        classification: "continuous",
        target: {
          track: { name: "Keys", occurrence: 0 },
          device: { name: "Rack", occurrence: 0 },
          parameter: { name: "Macro 1", occurrence: 0 },
        },
        observationPolicy: { minimumNormalizedDelta: 0.01, throttleMs: 25 },
      }
    : {
        ...base,
        kind,
        classification: "discrete",
        target: { track: { name: "Keys", occurrence: 0 } },
      };
}

function listener(
  id: string,
  eventId: string,
  responseMode: "next-prompt" | "automatic",
  messagePrefix?: string,
): AgentEventListener {
  return {
    id,
    eventId,
    enabled: true,
    responseMode,
    ...(messagePrefix === undefined ? {} : { messagePrefix }),
  };
}

function occurrence(
  id: string,
  eventId: string,
  sequence: number,
  kind:
    | "track.playing_clip_changed"
    | "parameter.value_changed" = "track.playing_clip_changed",
): LiveEventOccurrence {
  const base = {
    occurrenceId: id,
    eventId,
    sequence,
    observedAt: new Date(
      Date.parse("2026-08-29T18:00:00.000Z") + sequence * 1_000,
    ).toISOString(),
    target: {
      trackReference,
      track: { name: "Keys" },
    },
    summary: `summary ${sequence}`,
  };
  return kind === "parameter.value_changed"
    ? {
        ...base,
        kind,
        current: {
          normalizedValue: sequence / 10,
          value: sequence,
          displayValue: String(sequence),
        },
      }
    : {
        ...base,
        kind,
        current: { state: "session-clip", slotIndex: sequence },
      };
}

class FakeBridge implements LiveEventBridge {
  readonly subscribed: SubscribeEventParams[] = [];
  readonly unsubscribed: string[] = [];
  eventListener: ((event: AbletonLiveEvent) => void) | undefined;
  reconciliationListener:
    ((signal: LiveEventReconciliationSignal) => void) | undefined;
  statuses: LiveEventSubscriptionStatus[] = [];
  unsubscribeFailures = 0;

  async inspectSession() {
    return {
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 1,
      tracks: [
        {
          index: 0,
          reference: trackReference,
          name: "Keys",
          kind: "midi" as const,
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.8,
          pan: 0,
        },
      ],
    };
  }

  async inspectEventSelection() {
    return {
      track: {
        index: 0,
        expectedReference: trackReference,
        expectedName: "Keys",
      },
      parameter: null,
    };
  }

  async inspectDevices(_params: InspectDevicesParams) {
    void _params;
    return {
      devices: [
        {
          reference: deviceReference,
          trackReference,
          trackIndex: 0,
          index: 0,
          name: "Rack",
          className: "InstrumentGroupDevice",
          classDisplayName: "Instrument Rack",
          enabled: true,
          parameterCount: 1,
          canHaveChains: true,
          canHaveDrumPads: false,
        },
      ],
      total: 1,
      offset: 0,
      limit: 128,
    };
  }

  async inspectDeviceParameters(_params: InspectDeviceParametersParams) {
    void _params;
    return {
      device: (await this.inspectDevices({} as InspectDevicesParams))
        .devices[0]!,
      parameters: [
        {
          reference: parameterReference,
          deviceReference,
          index: 0,
          name: "Macro 1",
          value: 0,
          normalizedValue: 0,
          min: 0,
          max: 127,
          isQuantized: false,
          isEnabled: true,
          valueItemCount: 0,
        },
      ],
      total: 1,
      offset: 0,
      limit: 256,
    };
  }

  async subscribeLiveEvent(
    params: SubscribeEventParams,
  ): Promise<SubscribeEventResult> {
    this.subscribed.push(params);
    const target = {
      trackReference,
      track: { name: "Keys" },
    };
    const resolution = {
      status: "resolved" as const,
      projectId: "project",
      trackReference,
      track: { name: "Keys" },
    };
    if (params.kind === "parameter.value_changed") {
      const parameterTarget = {
        ...target,
        deviceReference,
        parameterReference,
      };
      return {
        eventId: params.eventId,
        kind: params.kind,
        target: parameterTarget,
        resolution: {
          ...resolution,
          deviceReference,
          parameterReference,
        },
        state: { normalizedValue: 0, value: 0, displayValue: "0" },
        initialState: {
          kind: params.kind,
          state: { normalizedValue: 0, value: 0, displayValue: "0" },
        },
      };
    }
    if (params.kind === "track.playing_clip_changed") {
      return {
        eventId: params.eventId,
        kind: params.kind,
        target,
        resolution,
        state: { state: "stopped" },
        initialState: {
          kind: params.kind,
          state: { state: "stopped" },
        },
      };
    }
    if (params.kind === "track.triggered_clip_changed") {
      return {
        eventId: params.eventId,
        kind: params.kind,
        target,
        resolution,
        state: { state: "none" },
        initialState: {
          kind: params.kind,
          state: { state: "none" },
        },
      };
    }
    return {
      eventId: params.eventId,
      kind: params.kind,
      target,
      resolution,
      state: { recording: false, source: "track" },
      initialState: {
        kind: params.kind,
        state: { recording: false, source: "track" },
      },
    };
  }

  async unsubscribeLiveEvent(eventId: string) {
    this.unsubscribed.push(eventId);
    if (this.unsubscribeFailures > 0) {
      this.unsubscribeFailures -= 1;
      throw new Error("unsubscribe failed");
    }
    return { eventId, unsubscribed: true };
  }

  async reconcileLiveEventSubscriptions() {
    return this.statuses;
  }

  subscribeLiveEvents(listener: (event: AbletonLiveEvent) => void) {
    this.eventListener = listener;
    return () => {
      this.eventListener = undefined;
    };
  }

  subscribeLiveEventReconciliation(
    listener: (signal: LiveEventReconciliationSignal) => void,
  ) {
    this.reconciliationListener = listener;
    return () => {
      this.reconciliationListener = undefined;
    };
  }

  emit(value: LiveEventOccurrence): void {
    this.eventListener?.({
      event: "live_event.occurred",
      sequence: value.sequence,
      payload: value,
      receivedAt: value.observedAt,
    });
  }
}

function binding(
  agentInstanceId: string,
  value: AgentEventListener,
): AgentLiveEventListener {
  return { agentInstanceId, listener: value };
}

describe("DefaultLiveEventRuntime", () => {
  it("exposes the current Ableton event selection", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({ bridge });

    await expect(runtime.inspectSelection()).resolves.toEqual({
      track: {
        index: 0,
        expectedReference: trackReference,
        expectedName: "Keys",
      },
      parameter: null,
    });
  });
  it("subscribes once, keeps bounded state, fans out, and isolates agents", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({
      bridge,
      historyLimit: 2,
    });

    runtime.setConfiguration(
      [definition()],
      [
        binding("agent-one", listener(listenerOne, eventOne, "next-prompt")),
        binding("agent-two", listener(listenerTwo, eventOne, "next-prompt")),
      ],
    );
    runtime.setActiveAgentInstances(["agent-one", "agent-two"]);
    await runtime.start();
    runtime.setConfiguration(
      [definition()],
      [
        binding("agent-one", listener(listenerOne, eventOne, "next-prompt")),
        binding("agent-two", listener(listenerTwo, eventOne, "next-prompt")),
      ],
    );
    await vi.waitFor(() => expect(bridge.subscribed).toHaveLength(1));

    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000101", eventOne, 1),
    );
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000102", eventOne, 2),
    );
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000103", eventOne, 3),
    );

    expect(
      runtime.getState(eventOne)?.history.map(({ sequence }) => sequence),
    ).toEqual([2, 3]);
    expect(
      (await runtime.getPendingLiveEventContexts("agent-one")).map(
        ({ occurrence: item }) => item.sequence,
      ),
    ).toEqual([1, 2, 3]);
    expect(await runtime.getPendingLiveEventContexts("other")).toEqual([]);
    await runtime.markLiveEventContextsDelivered(
      "agent-one",
      (await runtime.getPendingLiveEventContexts("agent-one")).map(
        ({ deliveryId }) => deliveryId,
      ),
    );
    expect(await runtime.getPendingLiveEventContexts("agent-one")).toEqual([]);
    expect(await runtime.getPendingLiveEventContexts("agent-two")).toHaveLength(
      3,
    );
  });

  it("traces an occurrence through history, fan-out, dispatch, and ack", async () => {
    const bridge = new FakeBridge();
    const telemetry: TelemetryEventEnvelope[] = [];
    const runtime = new DefaultLiveEventRuntime({
      bridge,
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });
    runtime.setConfiguration(
      [definition()],
      [binding("agent", listener(listenerOne, eventOne, "next-prompt"))],
    );
    runtime.setActiveAgentInstances(["agent"]);
    await runtime.start();
    const item = occurrence(
      "00000000-0000-4000-8000-000000000121",
      eventOne,
      1,
    );
    bridge.emit(item);

    const [pending] = await runtime.getPendingLiveEventContexts("agent");
    expect(pending).toBeDefined();
    await runtime.markLiveEventContextsDelivered("agent", [
      pending!.deliveryId,
    ]);

    const history = telemetry.find(
      ({ name }) => name === "live-event.history.recorded",
    );
    const dispatch = telemetry.find(
      ({ name }) => name === "live-event.dispatch.requested",
    );
    const acknowledged = telemetry.find(
      ({ name }) => name === "live-event.delivery.acknowledged",
    );
    expect(history).toMatchObject({
      occurredAt: item.observedAt,
      correlationId: item.occurrenceId,
      projectId: "project",
      liveEventId: item.eventId,
      trace: { traceId: item.occurrenceId, spanId: item.occurrenceId },
      attributes: { occurrenceId: item.occurrenceId, historySize: 1 },
    });
    expect(history?.durationMs).toBeGreaterThanOrEqual(0);
    expect(dispatch?.trace).toMatchObject({
      traceId: item.occurrenceId,
      parentSpanId: item.occurrenceId,
    });
    expect(dispatch).toMatchObject({
      correlationId: item.occurrenceId,
      causationId: item.occurrenceId,
      projectId: "project",
      activeAgentId: "agent",
      liveEventId: item.eventId,
    });
    expect(acknowledged?.trace?.spanId).toBe(dispatch?.trace?.spanId);
    expect(
      telemetry.some(
        ({ name }) => name === "live-event.listener-fanout.completed",
      ),
    ).toBe(true);
  });

  it("keeps only latest continuous next-prompt context", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({ bridge });
    runtime.setConfiguration(
      [definition(eventOne, "parameter.value_changed")],
      [binding("agent", listener(listenerOne, eventOne, "next-prompt"))],
    );
    runtime.setActiveAgentInstances(["agent"]);
    await runtime.start();
    bridge.emit(
      occurrence(
        "00000000-0000-4000-8000-000000000101",
        eventOne,
        1,
        "parameter.value_changed",
      ),
    );
    bridge.emit(
      occurrence(
        "00000000-0000-4000-8000-000000000102",
        eventOne,
        2,
        "parameter.value_changed",
      ),
    );
    expect(
      (await runtime.getPendingLiveEventContexts("agent")).map(
        ({ occurrence: item }) => item.sequence,
      ),
    ).toEqual([2]);
  });

  it("settles continuous automatic turns and preserves discrete order while busy", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const runtime = new DefaultLiveEventRuntime({
        bridge,
        continuousSettleMs: 50,
      });
      runtime.setConfiguration(
        [definition(eventOne, "parameter.value_changed"), definition(eventTwo)],
        [
          binding("agent", listener(listenerOne, eventOne, "automatic")),
          binding("agent", listener(listenerTwo, eventTwo, "automatic")),
        ],
      );
      runtime.setActiveAgentInstances(["agent"]);
      await runtime.start();
      const delivered: number[] = [];
      let release: (() => void) | undefined;
      runtime.setDeliveryService({
        enqueueLiveEventTurn: async ({ occurrence: item }) => {
          delivered.push(item.sequence);
          if (item.sequence === 10) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return "ok";
        },
      });
      bridge.emit(
        occurrence("00000000-0000-4000-8000-000000000110", eventTwo, 10),
      );
      bridge.emit(
        occurrence("00000000-0000-4000-8000-000000000111", eventTwo, 11),
      );
      bridge.emit(
        occurrence("00000000-0000-4000-8000-000000000112", eventTwo, 12),
      );
      bridge.emit(
        occurrence(
          "00000000-0000-4000-8000-000000000101",
          eventOne,
          1,
          "parameter.value_changed",
        ),
      );
      bridge.emit(
        occurrence(
          "00000000-0000-4000-8000-000000000102",
          eventOne,
          2,
          "parameter.value_changed",
        ),
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(delivered).toEqual([10]);
      release!();
      await vi.waitFor(() => expect(delivered).toEqual([10, 11, 12, 2]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("cascades deletion and reconciles current truth without triggering", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({ bridge });
    runtime.setConfiguration(
      [definition()],
      [binding("agent", listener(listenerOne, eventOne, "next-prompt"))],
    );
    runtime.setActiveAgentInstances(["agent"]);
    await runtime.start();
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000101", eventOne, 1),
    );
    bridge.statuses = [
      {
        eventId: eventOne,
        status: "resolved",
        subscription: {
          eventId: eventOne,
          kind: "track.playing_clip_changed",
          target: { trackReference, track: { name: "Keys" } },
          resolution: {
            status: "resolved",
            projectId: "project",
            trackReference,
            track: { name: "Keys" },
          },
          state: { state: "arrangement" },
        },
      },
    ];
    bridge.reconciliationListener?.({
      reason: "sequence-gap",
      expectedSequence: 2,
      receivedSequence: 3,
    });
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000103", eventOne, 3),
    );
    await vi.waitFor(() =>
      expect(runtime.getState(eventOne)?.latestState).toEqual({
        kind: "track.playing_clip_changed",
        state: { state: "arrangement" },
      }),
    );
    expect(await runtime.getPendingLiveEventContexts("agent")).toHaveLength(1);

    runtime.setConfiguration([], []);
    await vi.waitFor(() => expect(bridge.unsubscribed).toContain(eventOne));
    expect(runtime.getState(eventOne)).toBeUndefined();
    expect(await runtime.getPendingLiveEventContexts("agent")).toEqual([]);
  });

  it("continues automatic delivery after one listener fails", async () => {
    const bridge = new FakeBridge();
    const telemetry: TelemetryEventEnvelope[] = [];
    const runtime = new DefaultLiveEventRuntime({
      bridge,
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });
    runtime.setConfiguration(
      [definition()],
      [binding("agent", listener(listenerOne, eventOne, "automatic"))],
    );
    runtime.setActiveAgentInstances(["agent"]);
    await runtime.start();
    const delivered: number[] = [];
    runtime.setDeliveryService({
      enqueueLiveEventTurn: async ({ occurrence: item }) => {
        delivered.push(item.sequence);
        if (item.sequence === 1) throw new Error("failed");
        return "ok";
      },
    });
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000101", eventOne, 1),
    );
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000102", eventOne, 2),
    );
    await vi.waitFor(() => expect(delivered).toEqual([1, 2]));
    expect(
      telemetry.find(({ name }) => name === "live-event.delivery.failed"),
    ).toMatchObject({ outcome: "failure", level: "error" });
    const completed = telemetry.find(
      ({ name }) => name === "live-event.delivery.completed",
    );
    const acknowledged = telemetry.find(
      ({ name }) => name === "live-event.delivery.acknowledged",
    );
    expect(completed).toMatchObject({ outcome: "success" });
    expect(acknowledged?.trace?.spanId).toBe(completed?.trace?.spanId);
  });

  it("deactivates the old subscription when an edited target is unresolved", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({ bridge });
    runtime.setConfiguration([definition()], []);
    await runtime.start();
    expect(bridge.subscribed).toHaveLength(1);

    const edited = definition();
    if (edited.kind !== "track.playing_clip_changed") {
      throw new Error("Expected a track event definition");
    }
    runtime.setConfiguration(
      [
        {
          ...edited,
          target: { track: { name: "Missing", occurrence: 0 } },
          updatedAt: "2026-08-29T18:01:00.000Z",
        },
      ],
      [],
    );

    await vi.waitFor(() => expect(bridge.unsubscribed).toContain(eventOne));
    expect(runtime.getState(eventOne)?.resolution.status).toBe("unresolved");
  });

  it("retries deactivation when unsubscribing an unresolved edit fails", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({ bridge });
    const edited = definition();
    if (edited.kind !== "track.playing_clip_changed") {
      throw new Error("Expected a track event definition");
    }
    const unresolvedEdit = {
      ...edited,
      target: { track: { name: "Missing", occurrence: 0 } },
      updatedAt: "2026-08-29T18:01:00.000Z",
    };
    runtime.setConfiguration([definition()], []);
    await runtime.start();
    bridge.unsubscribeFailures = 1;

    runtime.setConfiguration([unresolvedEdit], []);
    await vi.waitFor(() => expect(bridge.unsubscribed).toHaveLength(1));
    runtime.setConfiguration([unresolvedEdit], []);

    await vi.waitFor(() => expect(bridge.unsubscribed).toHaveLength(2));
  });

  it("discards queued deliveries when listener settings change", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({ bridge });
    runtime.setConfiguration(
      [definition()],
      [binding("agent", listener(listenerOne, eventOne, "automatic", "Old"))],
    );
    runtime.setActiveAgentInstances(["agent"]);
    await runtime.start();
    const delivered: number[] = [];
    let release: (() => void) | undefined;
    runtime.setDeliveryService({
      enqueueLiveEventTurn: async ({ occurrence: item }) => {
        delivered.push(item.sequence);
        if (item.sequence === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return "ok";
      },
    });
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000101", eventOne, 1),
    );
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000102", eventOne, 2),
    );

    runtime.setConfiguration(
      [definition()],
      [binding("agent", listener(listenerOne, eventOne, "next-prompt", "New"))],
    );
    bridge.emit(
      occurrence("00000000-0000-4000-8000-000000000103", eventOne, 3),
    );
    release!();

    await vi.waitFor(() => expect(delivered).toEqual([1]));
    expect(
      (await runtime.getPendingLiveEventContexts("agent")).map(
        ({ occurrence: item }) => item.sequence,
      ),
    ).toEqual([3]);
  });

  it("bounds queued automatic discrete occurrences", async () => {
    const bridge = new FakeBridge();
    const runtime = new DefaultLiveEventRuntime({
      bridge,
      automaticDiscreteLimit: 2,
    });
    runtime.setConfiguration(
      [definition()],
      [binding("agent", listener(listenerOne, eventOne, "automatic"))],
    );
    runtime.setActiveAgentInstances(["agent"]);
    await runtime.start();
    const delivered: number[] = [];
    let release: (() => void) | undefined;
    runtime.setDeliveryService({
      enqueueLiveEventTurn: async ({ occurrence: item }) => {
        delivered.push(item.sequence);
        if (item.sequence === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return "ok";
      },
    });
    for (const sequence of [1, 2, 3, 4]) {
      bridge.emit(
        occurrence(
          `00000000-0000-4000-8000-${String(100 + sequence).padStart(12, "0")}`,
          eventOne,
          sequence,
        ),
      );
    }
    release!();

    await vi.waitFor(() => expect(delivered).toEqual([1, 3, 4]));
  });
});
