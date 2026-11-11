import { z } from "zod";

export type JsonByteSchema = z.core.JSONSchema.JSONSchema;
type Override = (path: string) => number | undefined;
const encoder = new TextEncoder();
export const encodedJsonBytes = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).byteLength;
export const jsonArrayByteBound = (count: number, itemBytes: number): number =>
  2 + count * itemBytes + Math.max(0, count - 1);
export const jsonObjectByteBound = (fields: Record<string, number>): number =>
  2 +
  Object.entries(fields).reduce(
    (sum, [key, size]) => sum + encodedJsonBytes(key) + 1 + size,
    0,
  ) +
  Math.max(0, Object.keys(fields).length - 1);
export const toBoundJsonSchema = (schema: z.ZodType): JsonByteSchema =>
  z.toJSONSchema(schema, { target: "draft-7", reused: "inline" });

export function jsonSchemaProperty(
  schema: JsonByteSchema,
  name: string,
): JsonByteSchema {
  const result = schema.properties?.[name];
  if (!result || typeof result === "boolean")
    throw new Error(`metric_budget_missing_schema_property:${name}`);
  return result;
}

export function jsonSchemaItem(schema: JsonByteSchema): JsonByteSchema {
  if (
    !schema.items ||
    typeof schema.items === "boolean" ||
    Array.isArray(schema.items)
  )
    throw new Error("metric_budget_missing_array_item_schema");
  return schema.items;
}

/**
 * Bounding, not validation. Canonical Zod schemas validate inputs; their JSON
 * schemas supply finite field/array/string bounds. Unknown constructs fail
 * explicitly rather than quietly underestimating a future protocol revision.
 * Error codes retain the original metric budget contract.
 */
export function boundJsonSchemaBytes(
  schema: JsonByteSchema | boolean,
  path = "",
  override: Override = () => undefined,
): number {
  const replacement = override(path);
  if (replacement !== undefined) return replacement;
  if (typeof schema === "boolean")
    throw new Error(`metric_budget_unbounded_schema:${path}`);
  if (Object.prototype.hasOwnProperty.call(schema, "const"))
    return encodedJsonBytes(schema.const);
  if (schema.enum) return Math.max(...schema.enum.map(encodedJsonBytes));
  if (schema.anyOf)
    return Math.max(
      ...schema.anyOf.map((item) => boundJsonSchemaBytes(item, path, override)),
    );
  switch (schema.type) {
    case "null":
      return 4;
    case "boolean":
      return 5;
    case "integer":
      if (
        typeof schema.minimum === "number" &&
        typeof schema.maximum === "number" &&
        Number.isSafeInteger(schema.minimum) &&
        Number.isSafeInteger(schema.maximum)
      )
        return Math.max(
          encodedJsonBytes(schema.minimum),
          encodedJsonBytes(schema.maximum),
        );
      break;
    case "number":
      // Binary64 shortest-roundtrip has at most 17 significant digits. Fixed
      // notation at 1e-6 needs 2+5+17=24 chars; scientific notation is shorter.
      // Include a possible minus sign unless the canonical schema forbids it.
      return typeof schema.minimum === "number" && schema.minimum >= 0
        ? 24
        : 25;
    case "string":
      if (schema.format === "uuid") return 38;
      // JSON escapes each UTF-16 code unit using at most six ASCII bytes.
      if (typeof schema.maxLength === "number") return 2 + 6 * schema.maxLength;
      break;
    case "array":
      if (Array.isArray(schema.items))
        return (
          2 +
          schema.items.reduce(
            (sum, item, index) =>
              sum + boundJsonSchemaBytes(item, `${path}.${index}`, override),
            0,
          ) +
          Math.max(0, schema.items.length - 1)
        );
      if (schema.items && typeof schema.maxItems === "number")
        return jsonArrayByteBound(
          schema.maxItems,
          boundJsonSchemaBytes(schema.items, `${path}[]`, override),
        );
      break;
    case "object":
      if (schema.additionalProperties === false && schema.properties)
        return jsonObjectByteBound(
          Object.fromEntries(
            Object.entries(schema.properties).map(([key, child]) => [
              key,
              boundJsonSchemaBytes(
                child,
                path ? `${path}.${key}` : key,
                override,
              ),
            ]),
          ),
        );
      break;
  }
  throw new Error(`metric_budget_unbounded_schema:${path}`);
}
