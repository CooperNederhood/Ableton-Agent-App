import { describe, expect, it } from "vitest";

import type { PendingLiveEventContext } from "./live-event-delivery.js";
import {
  constructNextPromptLiveEventContext,
  formatAutomaticLiveEventPrompt,
} from "./live-event-delivery.js";

const entry: PendingLiveEventContext = {
  deliveryId: "delivery",
  agentInstanceId: "agent",
  listener: {
    id: "event-listener.00000000-0000-4000-8000-000000000001",
    eventId: "live-event.00000000-0000-4000-8000-000000000001",
    enabled: true,
    responseMode: "next-prompt",
    messagePrefix: "Please inspect this.",
  },
  occurrence: {
    occurrenceId: "00000000-0000-4000-8000-000000000001",
    eventId: "live-event.00000000-0000-4000-8000-000000000001",
    kind: "track.playing_clip_changed",
    sequence: 1,
    observedAt: "2026-08-29T18:00:00.000Z",
    target: {
      trackReference: "00000000-0000-4000-8000-000000000010",
      track: { name: "Keys" },
    },
    summary: "Keys started Session clip 1.",
    current: { state: "session-clip", slotIndex: 0 },
  },
};

describe("Live event delivery formatting", () => {
  it("places the message prefix immediately before the event summary", () => {
    const nextPrompt = constructNextPromptLiveEventContext([entry]);
    const automatic = formatAutomaticLiveEventPrompt({
      ...entry,
      listener: { ...entry.listener, responseMode: "automatic" },
    });
    const adjacent = "Please inspect this.\nKeys started Session clip 1.";
    expect(nextPrompt.additionalContext).toContain(adjacent);
    expect(automatic).toContain(adjacent);
  });

  it("keeps bounded ordered discrete occurrences", () => {
    const second = {
      ...entry,
      deliveryId: "delivery-2",
      occurrence: {
        ...entry.occurrence,
        occurrenceId: "00000000-0000-4000-8000-000000000002",
        sequence: 2,
        observedAt: "2026-08-29T18:00:01.000Z",
        summary: "second",
      },
    };
    const result = constructNextPromptLiveEventContext([second, entry], {
      maximumContexts: 2,
    });
    expect(result.deliveryIds).toEqual(["delivery", "delivery-2"]);
    expect(result.additionalContext!.indexOf("sequence 1")).toBeLessThan(
      result.additionalContext!.indexOf("sequence 2"),
    );
  });
});
