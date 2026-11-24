import { describe, expect, it } from "vitest";
import {
  MonitoringObserver,
  type MonitoringEpisode,
} from "./monitoring-observer.js";

function observer(maxWindowBars = 8) {
  return new MonitoringObserver<number>({
    distance: (left, right) => Math.abs(left - right),
    maxWindowBars,
    matchThreshold: 0.1,
  });
}

function feed(
  target: MonitoringObserver<number>,
  values: readonly number[],
  firstBar = 1,
): (MonitoringEpisode & { at: number })[] {
  return values.flatMap((features, index) => {
    const bar = firstBar + index;
    return target
      .observeBar({ bar, songBeat: (bar - 1) * 4, features })
      .map((episode) => ({ ...episode, at: bar }));
  });
}

const repeat = (pattern: readonly number[], bars: number) =>
  Array.from({ length: bars }, (_, index) => pattern[index % pattern.length]!);

describe("MonitoringObserver", () => {
  it("establishes a steady pattern, detects the change at its first bar and re-establishes", () => {
    const target = observer();
    const episodes = feed(target, [...repeat([1], 24), ...repeat([5], 8)]);
    expect(episodes.map((e) => [e.kind, e.at])).toEqual([
      ["pattern-established", 2],
      ["pattern-changed", 26],
      ["pattern-established", 26],
    ]);
    expect(episodes[1]).toMatchObject({ bar: 25, songBeat: 96 });
    expect(target.snapshot()).toMatchObject({
      state: "tracking",
      periodBars: 1,
      patternVersion: 2,
      barsObserved: 32,
    });
  });

  it("prefers the shortest repeating period and tracks multi-bar patterns by phase", () => {
    const target = observer();
    const episodes = feed(target, [
      ...repeat([1, 2, 3, 4], 16),
      ...repeat([7, 8], 8),
    ]);
    expect(episodes.map((e) => e.kind)).toEqual([
      "pattern-established",
      "pattern-changed",
      "pattern-established",
    ]);
    expect(episodes[0]).toMatchObject({ periodBars: 4, at: 8 });
    expect(episodes[1]).toMatchObject({ bar: 17 });
    expect(episodes[2]).toMatchObject({ periodBars: 2, at: 20 });
  });

  it("treats a one-bar deviation that returns to the pattern as a fill", () => {
    const target = observer();
    const episodes = feed(target, [...repeat([1, 2], 8), 9, 2, 1, 2]);
    expect(episodes.map((e) => e.kind)).toEqual([
      "pattern-established",
      "fill",
    ]);
    expect(episodes[1]).toMatchObject({ startBar: 9, endBar: 9 });
    expect(target.state).toBe("tracking");
  });

  it("establishes silence as a pattern and detects sound entering", () => {
    const target = observer();
    const episodes = feed(target, [0, 0, 0, 3, 3]);
    expect(episodes.map((e) => [e.kind, e.at])).toEqual([
      ["pattern-established", 2],
      ["pattern-changed", 5],
      ["pattern-established", 5],
    ]);
  });

  it("forgets the window on interruption and reacquires on resume", () => {
    const target = observer();
    feed(target, repeat([1], 4));
    expect(target.interrupt("transport-stopped")).toEqual([
      { kind: "uncertain", bar: 4, reason: "transport-stopped" },
    ]);
    expect(target.interrupt("transport-jump")).toEqual([]);
    expect(target.snapshot()).toMatchObject({
      state: "uncertain",
      periodBars: null,
    });
    const resumed = feed(target, [5, 5], 20);
    expect(resumed).toMatchObject([
      { kind: "pattern-established", bar: 21, patternVersion: 2 },
    ]);
  });

  it("does not consider periods beyond the window", () => {
    const target = observer(2);
    const episodes = feed(target, repeat([1, 2, 3, 4], 16));
    expect(episodes).toEqual([]);
    expect(target.state).toBe("acquiring");
  });

  it("keeps independent observers independent and ignores bars after close", () => {
    const left = observer();
    const right = observer();
    feed(left, repeat([1], 4));
    feed(right, repeat([2], 4));
    expect(feed(left, [9, 9], 5).map((e) => e.kind)).toContain(
      "pattern-changed",
    );
    expect(right.snapshot()).toMatchObject({
      state: "tracking",
      patternVersion: 1,
    });
    expect(right.close("max-bars")).toEqual([
      { kind: "closed", bar: 4, reason: "max-bars" },
    ]);
    expect(feed(right, [7, 7], 5)).toEqual([]);
    expect(right.interrupt("gap")).toEqual([]);
  });
});
