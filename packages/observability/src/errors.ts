import type { JournalFailureCode } from "./contracts.js";

export class ObservabilityJournalError extends Error {
  public readonly code: JournalFailureCode;

  public constructor(
    code: JournalFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ObservabilityJournalError";
    this.code = code;
  }
}

export class JournalClosedError extends ObservabilityJournalError {
  public constructor() {
    super("closed", "The observability journal is closed");
    this.name = "JournalClosedError";
  }
}

export class JournalConflictError extends ObservabilityJournalError {
  public constructor(message: string, options?: ErrorOptions) {
    super("conflict", message, options);
    this.name = "JournalConflictError";
  }
}

export class JournalDuplicateError extends ObservabilityJournalError {
  public constructor(
    kind: "event" | "configuration snapshot" | "agent history" | "set history",
    id: string,
  ) {
    super("duplicate", `A ${kind} with id '${id}' is already journaled`);
    this.name = "JournalDuplicateError";
  }
}

export class JournalQueueFullError extends ObservabilityJournalError {
  public constructor(maxPendingWrites: number) {
    super(
      "queue_full",
      `The observability journal queue reached its ${maxPendingWrites} write limit`,
    );
    this.name = "JournalQueueFullError";
  }
}

export class JournalCursorError extends ObservabilityJournalError {
  public constructor(message = "The observability query cursor is invalid") {
    super("invalid_cursor", message);
    this.name = "JournalCursorError";
  }
}

export class JournalQueryError extends ObservabilityJournalError {
  public constructor(message: string) {
    super("invalid_query", message);
    this.name = "JournalQueryError";
  }
}

export class JournalSchemaVersionError extends ObservabilityJournalError {
  public constructor(message: string) {
    super("schema_version", message);
    this.name = "JournalSchemaVersionError";
  }
}
