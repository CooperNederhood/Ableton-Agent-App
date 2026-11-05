import type { TelemetryEventPage } from "@ableton-agent/observability";
import { flatnessOwner } from "./flatness-smoke-test-support.js";
import { spreadHistory } from "./spread-smoke-test-support.js";

/** Controlled transport values, not an acoustic or numerical oracle. */
export function rolloffHistory(
  owner = flatnessOwner,
): TelemetryEventPage["items"] {
  return spreadHistory(owner).map((event, index) => {
    if (index === 0) return event;
    const lifecycle = event.attributes.lifecycle as {
      metric: string;
      eventId: string;
      causationId: string;
      reason: string;
      facts: {
        field: string;
        actual: { state: string; value?: string | number };
      }[];
    };
    event.id = event.id.replace("a100", "a200");
    event.causationId =
      index === 1
        ? event.causationId
        : event.causationId!.replace("a100", "a200");
    event.trace = { traceId: owner.traceId, spanId: event.id };
    event.name = event.name.replace("spread", "rolloff");
    Object.assign(lifecycle, {
      metric: "spectral-rolloff",
      eventId: event.id,
      causationId: event.causationId,
      reason: lifecycle.reason.replace("spread", "rolloff"),
    });
    for (const fact of lifecycle.facts) {
      fact.field = fact.field.replace("spread.", "rolloff.");
      if (fact.field === "rolloff.schema")
        fact.actual.value = "flucoma-rolloff-smoke/v1";
      if (fact.actual.state === "observed" && fact.field.endsWith("Hz"))
        fact.actual.value = fact.field === "rolloff.leftHz" ? 6000 : 8000;
    }
    lifecycle.facts.push({
      field: "rolloff.rolloffpercent",
      actual: { state: "observed", value: 95 },
    });
    return event;
  });
}
