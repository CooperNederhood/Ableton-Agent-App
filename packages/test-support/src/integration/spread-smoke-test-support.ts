import type { TelemetryEventPage } from "@ableton-agent/observability";
import {
  flatnessHistory,
  flatnessOwner,
} from "./flatness-smoke-test-support.js";

/** Controlled transport values, not an acoustic or numerical oracle. */
export function spreadHistory(
  owner = flatnessOwner,
): TelemetryEventPage["items"] {
  return flatnessHistory(owner).map((event, index) => {
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
    event.id = event.id.replace("b000", "a100");
    event.causationId =
      index === 1
        ? event.causationId
        : event.causationId!.replace("b000", "a100");
    event.trace = { traceId: owner.traceId, spanId: event.id };
    event.name = event.name.replace("flatness", "spread");
    Object.assign(lifecycle, {
      metric: "spectral-spread",
      eventId: event.id,
      causationId: event.causationId,
      reason: lifecycle.reason.replace("flatness", "spread"),
    });
    for (const fact of lifecycle.facts) {
      fact.field = fact.field
        .replace("flatness.", "spread.")
        .replace(/Db$/, "Hz");
      if (fact.field === "spread.schema")
        fact.actual.value = "flucoma-spread-smoke/v1";
      if (fact.field === "spread.units") fact.actual.value = "Hz";
      if (fact.actual.state === "observed" && fact.field.endsWith("Hz"))
        fact.actual.value = fact.field === "spread.leftHz" ? 1200 : 1700;
    }
    lifecycle.facts.push(
      { field: "spread.unit", actual: { state: "observed", value: 0 } },
      { field: "spread.minfreq", actual: { state: "observed", value: 0 } },
      { field: "spread.maxfreq", actual: { state: "observed", value: -1 } },
    );
    return event;
  });
}
