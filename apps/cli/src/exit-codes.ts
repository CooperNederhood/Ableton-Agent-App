/**
 * Stable, documented CLI exit codes.
 *
 * These values are part of the CLI's contract with scripts and CI (see
 * docs/cli/terminal-client.md#output-formats-and-exit-codes) and must not be
 * renumbered without updating that document and its tests.
 */
export const EXIT_CODES = {
  /** Completed successfully. */
  SUCCESS: 0,
  /** Invalid CLI input (bad arguments, out-of-range values, usage errors). */
  USAGE_ERROR: 2,
  /** Ableton connection or compatibility failure. */
  CONNECTION_ERROR: 3,
  /** Approval denied, or required but unavailable in non-interactive mode. */
  APPROVAL_ERROR: 4,
  /** An agent/tool operation failed for a reason other than approval. */
  OPERATION_ERROR: 5,
  /** The process was interrupted by the user (e.g. Ctrl+C / SIGINT). */
  INTERRUPTED: 130,
} as const satisfies Record<string, number>;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const connectionErrorCodes = new Set([
  "authentication_failed",
  "configuration_missing",
  "connection_closed",
  "connection_error",
  "connection_failed",
  "not_connected",
  "operation_timeout",
  "protocol_version_unsupported",
]);

const approvalErrorCodes = new Set([
  "approval_denied",
  "approval_required",
  "permission_denied",
]);

export function exitCodeForError(error: unknown): ExitCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (connectionErrorCodes.has(error.code))
      return EXIT_CODES.CONNECTION_ERROR;
    if (approvalErrorCodes.has(error.code)) return EXIT_CODES.APPROVAL_ERROR;
  }
  return EXIT_CODES.OPERATION_ERROR;
}

export function exitCodeForOperationFailures(
  failures: readonly { code: string }[],
): ExitCode {
  if (failures.length === 0) return EXIT_CODES.SUCCESS;
  if (failures.some(({ code }) => connectionErrorCodes.has(code))) {
    return EXIT_CODES.CONNECTION_ERROR;
  }
  return failures.every(({ code }) => approvalErrorCodes.has(code))
    ? EXIT_CODES.APPROVAL_ERROR
    : EXIT_CODES.OPERATION_ERROR;
}
