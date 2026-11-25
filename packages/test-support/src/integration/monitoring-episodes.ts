import type { AssertionInput, Facts } from "./contracts.js";
import { rejectUnknownFields, requireCondition } from "./validation.js";

interface Episode {
  readonly kind: string;
  readonly bar?: number;
  readonly patternVersion?: number;
}

export interface MonitoringTrackSummary {
  readonly trackReference: string;
  readonly established: readonly number[];
  readonly changed: readonly number[];
  readonly reestablished: readonly number[];
  readonly uncertain: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function monitoringViews(value: unknown, views: Record<string, unknown>[]) {
  if (typeof value === "string") {
    try {
      monitoringViews(JSON.parse(value), views);
    } catch {
      // Ordinary text content.
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) monitoringViews(item, views);
    return;
  }
  const object = record(value);
  if (!object) return;
  if (typeof object.monitoringId === "string" && Array.isArray(object.episodes))
    views.push(object);
  else for (const item of Object.values(object)) monitoringViews(item, views);
}

/** Collects every monitoring episode the agent received, de-duplicated by sequence. */
export function summarizeMonitoring(
  input: AssertionInput,
): readonly MonitoringTrackSummary[] {
  const records = (input.turn ? [input.turn] : input.turns).flatMap(
    (turn) => turn.agentListening?.records ?? [],
  );
  const views: Record<string, unknown>[] = [];
  for (const item of records) {
    const entry = record(item);
    if (
      entry?.kind === "tool_result" &&
      record(entry.metadata)?.toolName === "ableton_listening"
    )
      monitoringViews(entry.result, views);
  }
  requireCondition(views.length > 0, "No monitoring result was returned");
  const episodes = new Map<number, { track: string; episode: Episode }>();
  const tracks = new Set<string>();
  for (const view of views) {
    for (const track of (view.tracks as unknown[] | undefined) ?? []) {
      const reference = record(track)?.trackReference;
      if (typeof reference === "string") tracks.add(reference);
    }
    for (const item of view.episodes as unknown[]) {
      const entry = record(item);
      const episode = record(entry?.episode);
      if (
        typeof entry?.sequence === "number" &&
        typeof entry.trackReference === "string" &&
        typeof episode?.kind === "string"
      )
        episodes.set(entry.sequence, {
          track: entry.trackReference,
          episode: episode as unknown as Episode,
        });
    }
  }
  const ordered = [...episodes.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);
  return [...tracks].map((trackReference) => {
    const own = ordered
      .filter(({ track }) => track === trackReference)
      .map(({ episode }) => episode);
    const bars = (predicate: (episode: Episode) => boolean) =>
      own.filter(predicate).map(({ bar }) => bar ?? Number.NaN);
    return {
      trackReference,
      established: bars(
        ({ kind, patternVersion }) =>
          kind === "pattern-established" && patternVersion === 1,
      ),
      changed: bars(({ kind }) => kind === "pattern-changed"),
      reestablished: bars(
        ({ kind, patternVersion }) =>
          kind === "pattern-established" && (patternVersion ?? 0) > 1,
      ),
      uncertain: own.filter(({ kind }) => kind === "uncertain").length,
    };
  });
}

function changeBars(parameters: Facts): number[] {
  return String(parameters.changeBars)
    .split(",")
    .map((value) => Number(value.trim()));
}

export function validateMonitoringEpisodes(parameters: Facts): void {
  rejectUnknownFields(parameters, ["changeBars", "slackBars", "establishBars"]);
  const bars = changeBars(parameters);
  requireCondition(
    bars.length >= 1 &&
      bars.length <= 8 &&
      bars.every((bar) => Number.isInteger(bar) && bar > 1),
    "changeBars must list one song bar per monitored track",
  );
  for (const key of ["slackBars", "establishBars"])
    requireCondition(
      Number.isInteger(parameters[key]) && Number(parameters[key]) >= 0,
      `${key} must be a non-negative integer`,
    );
}

/**
 * Each monitored track must establish its first pattern early, report exactly
 * one change within slack of an expected change bar, and settle again after it.
 * Tracks are paired with expected bars by order of their reported change.
 */
export function verifyMonitoringEpisodes(
  input: AssertionInput,
  parameters: Facts,
): string {
  const slack = Number(parameters.slackBars);
  const establish = Number(parameters.establishBars);
  const expected = changeBars(parameters).sort((left, right) => left - right);
  const tracks = summarizeMonitoring(input);
  const detail = JSON.stringify(tracks);
  requireCondition(
    tracks.length === expected.length,
    `Expected ${expected.length} monitored tracks: ${detail}`,
  );
  for (const track of tracks)
    requireCondition(
      track.uncertain === 0 &&
        track.changed.length === 1 &&
        track.established.length >= 1 &&
        track.established[0]! <= 1 + establish,
      `Track did not settle early and change exactly once: ${detail}`,
    );
  const byChange = [...tracks].sort(
    (left, right) => left.changed[0]! - right.changed[0]!,
  );
  byChange.forEach((track, index) => {
    const change = track.changed[0]!;
    const want = expected[index]!;
    requireCondition(
      change >= want && change <= want + slack,
      `Change at bar ${change}, expected ${want}..${want + slack}: ${detail}`,
    );
    requireCondition(
      track.reestablished.some(
        (bar) => bar > change && bar <= want + slack + establish,
      ),
      `New pattern did not settle by bar ${want + slack + establish}: ${detail}`,
    );
  });
  return detail;
}
