const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Maximum length accepted for either canonical assignment ID component. */
export const MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH = 256;

/**
 * Maximum encoded length for two maximum-length components, including the
 * `agent-instance.` prefix and worst-case JSON escaping.
 */
export const MAX_AGENT_INSTANCE_ASSIGNMENT_ID_LENGTH = 4_121;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const bits =
      (first << 16) | ((second ?? 0) << 8) | (third === undefined ? 0 : third);
    result += BASE64URL_ALPHABET[(bits >>> 18) & 63];
    result += BASE64URL_ALPHABET[(bits >>> 12) & 63];
    if (second !== undefined) result += BASE64URL_ALPHABET[(bits >>> 6) & 63];
    if (third !== undefined) result += BASE64URL_ALPHABET[bits & 63];
  }
  return result;
}

function validateComponent(name: string, value: string): void {
  if (
    value.length < 1 ||
    value.length > MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH
  ) {
    throw new RangeError(
      `${name} must contain between 1 and ${MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH} characters`,
    );
  }
}

export function createAgentInstanceAssignmentId(
  activeAgentInstanceId: string,
  producerId: string,
): string {
  validateComponent("activeAgentInstanceId", activeAgentInstanceId);
  validateComponent("producerId", producerId);
  return `agent-instance.${base64UrlEncode(
    JSON.stringify([activeAgentInstanceId, producerId]),
  )}`;
}
