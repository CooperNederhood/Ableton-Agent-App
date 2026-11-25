/**
 * Per-track monitoring observer. Pure bar-level state machine: it receives one
 * complete bar at a time and decides whether the bar repeats the established
 * pattern, is a short fill, or starts a new pattern. No Live, no I/O.
 */

export type MonitoringObserverState =
  "armed" | "acquiring" | "tracking" | "deviating" | "uncertain" | "closed";

export type MonitoringUncertainReason =
  | "transport-stopped"
  | "transport-jump"
  | "tempo-changed"
  | "gap"
  | "pass-limit";

export type MonitoringEpisode =
  | {
      readonly kind: "pattern-established";
      readonly bar: number;
      readonly songBeat: number;
      readonly periodBars: number;
      readonly patternVersion: number;
      readonly maxDistance: number;
    }
  | {
      readonly kind: "fill";
      readonly startBar: number;
      readonly endBar: number;
      readonly patternVersion: number;
      readonly maxDistance: number;
    }
  | {
      readonly kind: "pattern-changed";
      readonly bar: number;
      readonly songBeat: number;
      readonly previousPatternVersion: number;
      readonly distances: readonly number[];
    }
  | {
      readonly kind: "uncertain";
      readonly bar: number | null;
      readonly reason: MonitoringUncertainReason;
    }
  | {
      readonly kind: "closed";
      readonly bar: number | null;
      readonly reason: string;
    };

export interface MonitoringBar<T> {
  /** 1-based song bar. */
  readonly bar: number;
  readonly songBeat: number;
  readonly features: T;
}

export interface MonitoringObserverOptions<T> {
  /** Non-negative distance; lower is closer. Infinity means "clearly different". */
  readonly distance: (left: T, right: T) => number;
  /** Longest period considered, in bars. */
  readonly maxWindowBars: number;
  /** Distance at or below which two bars count as the same. */
  readonly matchThreshold: number;
  /** Consecutive missed bars that make a change rather than a fill. */
  readonly changeBars?: number;
}

export interface MonitoringObserverSnapshot {
  readonly state: MonitoringObserverState;
  readonly periodBars: number | null;
  readonly patternVersion: number;
  readonly barsObserved: number;
  readonly lastBar: number | null;
  readonly lastDistance: number | null;
  readonly threshold: number;
}

const CANDIDATE_PERIODS = [1, 2, 4, 8] as const;

export class MonitoringObserver<T> {
  readonly #distance: (left: T, right: T) => number;
  readonly #periods: readonly number[];
  readonly #floor: number;
  readonly #changeBars: number;
  #state: MonitoringObserverState = "armed";
  #history: MonitoringBar<T>[] = [];
  #template: MonitoringBar<T>[] = [];
  #anchorBar = 0;
  #pending: { bar: MonitoringBar<T>; distance: number }[] = [];
  #patternVersion = 0;
  #barsObserved = 0;
  #lastBar: number | null = null;
  #lastDistance: number | null = null;

  constructor(options: MonitoringObserverOptions<T>) {
    if (!Number.isInteger(options.maxWindowBars) || options.maxWindowBars < 1)
      throw new RangeError("maxWindowBars must be a positive integer");
    if (!(options.matchThreshold >= 0))
      throw new RangeError("matchThreshold must be non-negative");
    this.#distance = options.distance;
    this.#periods = CANDIDATE_PERIODS.filter(
      (period) => period <= options.maxWindowBars,
    );
    this.#floor = options.matchThreshold;
    this.#changeBars = Math.max(1, options.changeBars ?? 2);
  }

  get state(): MonitoringObserverState {
    return this.#state;
  }

  snapshot(): MonitoringObserverSnapshot {
    return {
      state: this.#state,
      periodBars:
        this.#state === "tracking" || this.#state === "deviating"
          ? this.#template.length
          : null,
      patternVersion: this.#patternVersion,
      barsObserved: this.#barsObserved,
      lastBar: this.#lastBar,
      lastDistance: this.#lastDistance,
      threshold: this.#floor,
    };
  }

  observeBar(input: MonitoringBar<T>): MonitoringEpisode[] {
    if (this.#state === "closed") return [];
    this.#barsObserved++;
    this.#lastBar = input.bar;
    if (this.#state === "armed" || this.#state === "uncertain")
      this.#state = "acquiring";
    if (this.#state === "acquiring") return this.#acquire(input);
    const distance = this.#measure(input);
    this.#lastDistance = distance;
    const matched = distance <= this.#floor;
    // A matching bar becomes the template for its phase, so slow drift (bar
    // slicing against the analysis frame grid) is followed while an abrupt
    // change still stands out.
    if (matched) this.#template[this.#phase(input.bar)] = input;
    if (this.#state === "tracking") {
      if (matched) return [];
      this.#pending = [{ bar: input, distance }];
      this.#state = "deviating";
      return this.#changeBars === 1 ? this.#change() : [];
    }
    // deviating
    if (matched) {
      const fill = this.#pending;
      this.#pending = [];
      this.#state = "tracking";
      return [
        {
          kind: "fill",
          startBar: fill[0]!.bar.bar,
          endBar: fill[fill.length - 1]!.bar.bar,
          patternVersion: this.#patternVersion,
          maxDistance: Math.max(...fill.map((item) => item.distance)),
        },
      ];
    }
    this.#pending.push({ bar: input, distance });
    return this.#pending.length >= this.#changeBars ? this.#change() : [];
  }

  /** Playback stopped, jumped, changed tempo or lost data: forget the window. */
  interrupt(
    reason: MonitoringUncertainReason,
    bar: number | null = this.#lastBar,
  ): MonitoringEpisode[] {
    if (this.#state === "closed") return [];
    this.#history = [];
    this.#pending = [];
    this.#template = [];
    if (this.#state === "uncertain" || this.#state === "armed") {
      this.#state = "uncertain";
      return [];
    }
    this.#state = "uncertain";
    return [{ kind: "uncertain", bar, reason }];
  }

  close(reason: string): MonitoringEpisode[] {
    if (this.#state === "closed") return [];
    this.#state = "closed";
    this.#history = [];
    this.#pending = [];
    this.#template = [];
    return [{ kind: "closed", bar: this.#lastBar, reason }];
  }

  #phase(bar: number): number {
    const period = this.#template.length;
    return (((bar - this.#anchorBar) % period) + period) % period;
  }

  #measure(input: MonitoringBar<T>): number {
    return this.#distance(
      input.features,
      this.#template[this.#phase(input.bar)]!.features,
    );
  }

  #acquire(input: MonitoringBar<T>): MonitoringEpisode[] {
    this.#history.push(input);
    const limit = 2 * Math.max(...this.#periods);
    if (this.#history.length > limit) this.#history.shift();
    for (const period of this.#periods) {
      if (this.#history.length < 2 * period) continue;
      const recent = this.#history.slice(-2 * period);
      const distances = recent
        .slice(period)
        .map((bar, index) =>
          this.#distance(bar.features, recent[index]!.features),
        );
      const maxDistance = Math.max(...distances);
      this.#lastDistance = maxDistance;
      if (maxDistance > this.#floor) continue;
      this.#template = recent.slice(period);
      this.#anchorBar = this.#template[0]!.bar;
      this.#history = [];
      this.#patternVersion++;
      this.#state = "tracking";
      return [
        {
          kind: "pattern-established",
          bar: input.bar,
          songBeat: input.songBeat,
          periodBars: period,
          patternVersion: this.#patternVersion,
          maxDistance,
        },
      ];
    }
    return [];
  }

  #change(): MonitoringEpisode[] {
    const pending = this.#pending;
    const first = pending[0]!.bar;
    this.#pending = [];
    this.#template = [];
    this.#history = pending.slice(0, -1).map((item) => item.bar);
    this.#state = "acquiring";
    const changed: MonitoringEpisode = {
      kind: "pattern-changed",
      bar: first.bar,
      songBeat: first.songBeat,
      previousPatternVersion: this.#patternVersion,
      distances: pending.map((item) => item.distance),
    };
    // The deviating bars may already establish a short new pattern.
    return [changed, ...this.#acquire(pending[pending.length - 1]!.bar)];
  }
}
