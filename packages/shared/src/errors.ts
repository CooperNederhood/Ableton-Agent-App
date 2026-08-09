export type ErrorCategory =
  | "configuration"
  | "connection"
  | "validation"
  | "conflict"
  | "permission"
  | "capability"
  | "timeout"
  | "internal";

const categories: Readonly<Record<ErrorCategory, ReadonlySet<string>>> = {
  configuration: new Set(["configuration_missing", "authentication_failed"]),
  connection: new Set([
    "not_connected",
    "connection_closed",
    "protocol_incompatible",
  ]),
  validation: new Set([
    "invalid_params",
    "malformed_message",
    "frame_too_large",
  ]),
  conflict: new Set([
    "stale_reference",
    "ambiguous_reference",
    "project_mismatch",
    "queue_full",
  ]),
  permission: new Set([
    "approval_denied",
    "permission_denied",
    "managed_policy_denied",
  ]),
  capability: new Set(["unsupported_capability", "unsupported_operation"]),
  timeout: new Set(["operation_timeout", "cancelled"]),
  internal: new Set(["lom_error", "sdk_error", "internal_error"]),
};

export function classifyErrorCode(code: string): ErrorCategory {
  for (const [category, codes] of Object.entries(categories) as Array<
    [ErrorCategory, ReadonlySet<string>]
  >) {
    if (codes.has(code)) return category;
  }
  return "internal";
}
