import type { TelemetryEventPage } from "@ableton-agent/observability";
import type { SpectralShapeSmokeEvidence } from "./contracts.js";

type HistoryEvent = TelemetryEventPage["items"][number];
export type SpectralShapeSmokeOwner = Pick<
  SpectralShapeSmokeEvidence,
  "traceId" | "correlationId" | "passId" | "listenerId" | "native"
>;
interface SmokeEvidenceContract {
  project(
    this: void,
    history: readonly HistoryEvent[],
    owner: SpectralShapeSmokeOwner,
    afterOwnedRestart?: boolean,
  ): SpectralShapeSmokeEvidence;
  validate(
    this: void,
    value: unknown,
  ): asserts value is SpectralShapeSmokeEvidence;
}
export function spectralShapeSmokeEvidence(
  kind: "flatness" | "spread",
): SmokeEvidenceContract {
  const prefix = `output.listener.native.metric.spectral-${kind}.`;
  const unit = kind === "flatness" ? "Db" : "Hz";
  const constants = {
    [`${kind}.schema`]: `flucoma-${kind}-smoke/v1`,
    [`${kind}.support`]: "unqualified",
    [`${kind}.valueValidity`]: "unqualified",
    [`${kind}.units`]: kind === "flatness" ? "dB" : "Hz",
    [`${kind}.channelPolicy`]: "independent-stereo",
    [`${kind}.windowSamples`]: 2048,
    [`${kind}.hopSamples`]: 2048,
    [`${kind}.power`]: 0,
    ...(kind === "spread"
      ? { "spread.unit": 0, "spread.minfreq": 0, "spread.maxfreq": -1 }
      : {}),
  };
  const fields = [
    ...Object.keys(constants),
    `${kind}.leftDeliveries`,
    `${kind}.rightDeliveries`,
    `${kind}.left${unit}`,
    `${kind}.right${unit}`,
    `${kind}.leftClass`,
    `${kind}.rightClass`,
    `${kind}.cleanup`,
  ];
  function check(value: unknown): asserts value {
    if (!value) throw new Error(`Invalid or incomplete ${kind} smoke evidence`);
  }
  function record(value: unknown): Record<string, unknown> {
    check(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  }
  function keys(
    value: Record<string, unknown>,
    expected: readonly string[],
  ): void {
    check(
      Object.keys(value).length === expected.length &&
        expected.every((key) => Object.hasOwn(value, key)),
    );
  }
  function bounded(value: unknown, min: number, max: number): value is number {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max
    );
  }
  function identity(value: unknown): value is string {
    return (
      typeof value === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(value)
    );
  }
  function owned(event: HistoryEvent, owner: SpectralShapeSmokeOwner): boolean {
    return (
      event.trace?.traceId === owner.traceId &&
      event.correlationId === owner.correlationId &&
      event.attributes.passId === owner.passId
    );
  }
  function exactOwner(
    event: HistoryEvent,
    owner: SpectralShapeSmokeOwner,
  ): void {
    check(
      owned(event, owner) &&
        event.source === "output-ingress" &&
        event.attributes.listenerId === owner.listenerId &&
        Object.entries(owner.native).every(
          ([key, value]) => event.attributes[key] === value,
        ),
    );
  }

  /** Consume only typed, redacted History pages; never a merged pre-restart cache. */
  function project(
    history: readonly HistoryEvent[],
    owner: SpectralShapeSmokeOwner,
    afterOwnedRestart = false,
  ): SpectralShapeSmokeEvidence {
    const candidates = history.filter(
      (event) => event.name.startsWith(prefix) && owned(event, owner),
    );
    check(candidates.length >= 7 && candidates.length <= 1024);
    const events = candidates.map((event) => {
      exactOwner(event, owner);
      const lifecycle = record(event.attributes.lifecycle);
      check(
        lifecycle.scope === "independent-metric-timelines/v1" &&
          lifecycle.metric === `spectral-${kind}` &&
          lifecycle.frames === 0 &&
          lifecycle.generation === owner.native.generation &&
          lifecycle.nativeEpoch === owner.native.nativeEpoch &&
          lifecycle.eventId === event.id &&
          lifecycle.causationId === event.causationId &&
          event.trace?.spanId === event.id &&
          event.name === `${prefix}${String(lifecycle.stage)}` &&
          event.durationMs === lifecycle.durationMs &&
          event.outcome ===
            (lifecycle.stage === "completed"
              ? "success"
              : lifecycle.stage === "failed"
                ? "failure"
                : lifecycle.stage === "cancelled"
                  ? "cancelled"
                  : "unknown"),
      );
      check(!["failed", "cancelled"].includes(String(lifecycle.stage)));
      // Failure-only rejected-value diagnostics remain in History, never a passing projection.
      check(
        Array.isArray(lifecycle.facts) &&
          lifecycle.facts.length === fields.length,
      );
      const facts: Record<
        string,
        SpectralShapeSmokeEvidence["events"][number]["facts"][string]
      > = {};
      for (const raw of lifecycle.facts) {
        const fact = record(raw);
        check(
          typeof fact.field === "string" &&
            fields.includes(fact.field) &&
            !Object.hasOwn(facts, fact.field),
        );
        const actual = record(fact.actual);
        check(
          Object.keys(actual).length === 2 &&
            (actual.state === "observed"
              ? typeof actual.value === "number" ||
                typeof actual.value === "string"
              : actual.state === "unavailable" &&
                actual.reason === "not-reported"),
        );
        facts[fact.field] =
          actual as SpectralShapeSmokeEvidence["events"][number]["facts"][string];
      }
      return {
        eventId: event.id,
        causationId: event.causationId,
        sequence: event.sequence,
        stage: lifecycle.stage,
        phase: lifecycle.phase,
        elapsedMs: lifecycle.elapsedMs,
        durationMs: lifecycle.durationMs,
        reason: lifecycle.reason,
        facts,
      } as SpectralShapeSmokeEvidence["events"][number];
    });
    const launch = history.find((event) => event.id === events[0]!.causationId);
    check(
      launch &&
        launch.name === "output.listener.native.completed" &&
        launch.outcome === "success",
    );
    exactOwner(launch, owner);
    const lifecycle = record(launch.attributes.lifecycle);
    check(
      lifecycle.phase === "launch" &&
        lifecycle.stage === "completed" &&
        lifecycle.eventId === launch.id &&
        lifecycle.scope === "independent-metric-timelines/v1" &&
        lifecycle.generation === owner.native.generation &&
        lifecycle.nativeEpoch === owner.native.nativeEpoch,
    );
    const evidence = {
      ...owner,
      native: { ...owner.native },
      afterOwnedRestart,
      launchEventId: launch.id,
      launchSequence: launch.sequence,
      events,
    };
    validate(evidence);
    return evidence;
  }

  function validate(
    value: unknown,
  ): asserts value is SpectralShapeSmokeEvidence {
    const evidence = record(value);
    keys(evidence, [
      "traceId",
      "correlationId",
      "passId",
      "listenerId",
      "native",
      "launchEventId",
      "launchSequence",
      "afterOwnedRestart",
      "events",
    ]);
    for (const key of [
      "traceId",
      "correlationId",
      "passId",
      "listenerId",
      "launchEventId",
    ])
      check(identity(evidence[key]));
    check(typeof evidence.afterOwnedRestart === "boolean");
    const native = record(evidence.native);
    check(Object.keys(native).length === 4);
    for (const key of ["generation", "connectionId", "connectionEpoch"])
      check(
        typeof native[key] === "string" &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(
            String(native[key]),
          ),
      );
    check(
      bounded(native.nativeEpoch, 1, 1_000_000) &&
        Number.isInteger(native.nativeEpoch),
    );
    check(
      Array.isArray(evidence.events) &&
        evidence.events.length >= 7 &&
        evidence.events.length <= 1024,
    );
    check(
      bounded(evidence.launchSequence, 0, Number.MAX_SAFE_INTEGER) &&
        Number.isInteger(evidence.launchSequence),
    );
    // The launch callback can emit queued diagnostics before its own receipt is
    // journaled. Causation binds launch; only the smoke stream orders by sequence.
    let sequence = 0;
    let cause = evidence.launchEventId;
    let elapsed = 0;
    let phase = 0;
    let progress = false;
    let counts = [0, 0];
    const previousValue: unknown[] = [undefined, undefined];
    const ids = new Set([cause]);
    for (const raw of evidence.events) {
      const event = record(raw);
      keys(event, [
        "eventId",
        "causationId",
        "sequence",
        "stage",
        "phase",
        "elapsedMs",
        "durationMs",
        "reason",
        "facts",
      ]);
      check(
        identity(event.eventId) &&
          !ids.has(event.eventId) &&
          event.causationId === cause,
      );
      check(
        bounded(event.sequence, sequence + 1, Number.MAX_SAFE_INTEGER) &&
          Number.isInteger(event.sequence),
      );
      check(
        bounded(event.elapsedMs, elapsed, 120_000) &&
          bounded(event.durationMs, 0, 120_000),
      );
      const facts = record(event.facts);
      check(
        Object.keys(facts).length === fields.length &&
          fields.every((key) => Object.hasOwn(facts, key)),
      );
      for (const [key, expected] of Object.entries(constants)) {
        const actual = record(facts[key]);
        check(
          Object.keys(actual).length === 2 &&
            actual.state === "observed" &&
            actual.value === expected,
        );
      }
      const nextCounts = ["left", "right"].map((channel, index) => {
        const actualClass = record(facts[`${kind}.${channel}Class`]);
        check(
          Object.keys(actualClass).length === 2 &&
            (phase === 0
              ? actualClass.state === "unavailable" &&
                actualClass.reason === "not-reported"
              : actualClass.state === "observed" &&
                actualClass.value === "fluid.spectralshape~"),
        );
        const count = record(facts[`${kind}.${channel}Deliveries`]);
        check(
          Object.keys(count).length === 2 &&
            count.state === "observed" &&
            bounded(count.value, counts[index]!, 400) &&
            Number.isInteger(count.value),
        );
        const measurement = record(facts[`${kind}.${channel}${unit}`]);
        check(
          Object.keys(measurement).length === 2 &&
            (count.value === 0
              ? measurement.state === "unavailable" &&
                measurement.reason === "not-reported"
              : measurement.state === "observed" &&
                bounded(
                  measurement.value,
                  kind === "flatness" ? -320 : 0,
                  kind === "flatness" ? 0 : Number.MAX_VALUE,
                )),
        );
        if (count.value > 0 && count.value === counts[index])
          check(measurement.value === previousValue[index]);
        previousValue[index] = measurement.value;
        return count.value;
      });
      const cleanup = record(facts[`${kind}.cleanup`]);
      check(Object.keys(cleanup).length === 2 && cleanup.state === "observed");
      check(event.stage !== "failed" && event.stage !== "cancelled");
      if (phase === 0 || phase === 1) {
        check(
          event.stage === (phase === 0 ? "queued" : "started") &&
            event.reason === `${kind}_smoke_capture` &&
            nextCounts.every((n) => n === 0),
        );
        phase++;
      } else if (phase === 2 && event.stage === "progress") {
        check(
          event.reason === `${kind}_smoke_output` &&
            nextCounts.every((n) => n > 0),
        );
        progress = true;
      } else if (phase === 2) {
        check(
          progress &&
            event.stage === "completed" &&
            event.reason === `${kind}_smoke_capture` &&
            nextCounts.every((n) => n > 0),
        );
        phase++;
      } else {
        check(
          phase <= 5 &&
            event.stage === ["queued", "started", "completed"][phase - 3] &&
            event.reason === `${kind}_smoke_cleanup` &&
            nextCounts.every((n, i) => n === counts[i]),
        );
        phase++;
      }
      const draining = event.reason === `${kind}_smoke_cleanup`;
      check(
        event.phase === (draining ? "drain" : "capture") &&
          cleanup.value ===
            (draining
              ? event.stage === "completed"
                ? "completed"
                : "pending"
              : "not-started"),
      );
      ids.add(event.eventId);
      cause = event.eventId;
      sequence = event.sequence;
      elapsed = event.elapsedMs;
      counts = nextCounts;
    }
    check(phase === 6);
  }
  return { project, validate };
}
