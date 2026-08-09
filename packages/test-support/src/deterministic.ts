import type { Clock, IdGenerator, Logger } from "@ableton-agent/shared";

export class FakeClock implements Clock {
  #nowMs: number;

  public constructor(initial: Date | number = 0) {
    this.#nowMs = initial instanceof Date ? initial.getTime() : initial;
  }

  public now(): Date {
    return new Date(this.#nowMs);
  }

  public nowMs(): number {
    return this.#nowMs;
  }

  public advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("Fake clock advance must be non-negative");
    }
    this.#nowMs += milliseconds;
  }
}

export class FakeIdGenerator implements IdGenerator {
  #index = 0;

  public constructor(private readonly ids: readonly string[]) {}

  public create(): string {
    const id = this.ids[this.#index];
    if (id === undefined) {
      throw new Error("Fake ID generator is exhausted");
    }
    this.#index += 1;
    return id;
  }
}

export interface CapturedLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export class LogCapture implements Logger {
  readonly entries: CapturedLog[] = [];

  public debug(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    this.capture("debug", message, context);
  }

  public info(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    this.capture("info", message, context);
  }

  public warn(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    this.capture("warn", message, context);
  }

  public error(
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    this.capture("error", message, context);
  }

  public byLevel(level: CapturedLog["level"]): readonly CapturedLog[] {
    return this.entries.filter((entry) => entry.level === level);
  }

  private capture(
    level: CapturedLog["level"],
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    this.entries.push({
      level,
      message,
      ...(context === undefined ? {} : { context: structuredClone(context) }),
    });
  }
}
