import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";
import {
  contextOperationResultSchema,
  listeningOperationResultSchema,
} from "@ableton-agent/tools";

export const MAX_LISTENING_HISTORY_RESULT_BYTES = 1024 * 1024;

function unavailable(reason: string) {
  return {
    result: {
      content: {
        error: "history_projection_unavailable",
        reason,
      },
    },
  };
}

/** Project actual SDK content before any generic string sanitizer can clip JSON. */
export function listeningHistoryResult(toolName: string, sdkResult: unknown) {
  if (toolName !== "ableton_listening" && toolName !== "ableton_context")
    return sanitizeTelemetryAttributes({ result: sdkResult });
  if (!sdkResult || typeof sdkResult !== "object" || !("content" in sdkResult))
    return unavailable("missing_sdk_content");
  let content: unknown = sdkResult.content;
  if (typeof content === "string") {
    if (Buffer.byteLength(content) > MAX_LISTENING_HISTORY_RESULT_BYTES)
      return unavailable("result_byte_limit");
    try {
      content = JSON.parse(content);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return unavailable("malformed_json");
    }
  }
  const parsed = (
    toolName === "ableton_listening"
      ? listeningOperationResultSchema
      : contextOperationResultSchema
  ).safeParse(content);
  if (!parsed.success) return unavailable("invalid_typed_result");
  if (
    Buffer.byteLength(JSON.stringify(parsed.data)) >
    MAX_LISTENING_HISTORY_RESULT_BYTES
  )
    return unavailable("result_byte_limit");
  return sanitizeTelemetryAttributes({ result: { content: parsed.data } });
}
