import type { Tool } from "@github/copilot-sdk";

type JsonSchema = Record<string, unknown>;

interface RuntimeParameterSchema {
  readonly safeParse: (value: unknown) =>
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly Record<string, unknown>[];
        };
      };
  readonly toJSONSchema: () => JsonSchema;
}

interface RequiredAlternative {
  readonly fields: readonly string[];
  readonly properties?: JsonSchema;
}

interface RequiredAnyRule {
  readonly toolName: string;
  readonly action?: string;
  readonly alternatives: readonly RequiredAlternative[];
}

interface SemanticPreconditionRule {
  readonly toolName: string;
  readonly action?: string;
  readonly description: string;
}

export const abletonAgentSchemaRequirements = [
  {
    toolName: "ableton_recording",
    action: "set-punch",
    alternatives: [{ fields: ["punchIn"] }, { fields: ["punchOut"] }],
  },
  {
    toolName: "ableton_grooves",
    action: "set-properties",
    alternatives: [
      { fields: ["quantizationAmount"] },
      { fields: ["timingAmount"] },
      { fields: ["randomAmount"] },
      { fields: ["velocityAmount"] },
    ],
  },
  {
    toolName: "ableton_transport",
    action: "set-arrangement-loop",
    alternatives: [
      { fields: ["enabled"] },
      { fields: ["start"] },
      { fields: ["length"] },
    ],
  },
  {
    toolName: "ableton_mixer_routing",
    action: "set-track-mixer",
    alternatives: [
      { fields: ["isMuted"] },
      { fields: ["isSoloed"] },
      { fields: ["isArmed"] },
      { fields: ["volume"] },
      { fields: ["pan"] },
    ],
  },
  {
    toolName: "ableton_session_clips",
    action: "set-properties",
    alternatives: [
      { fields: ["name"] },
      { fields: ["muted"] },
      { fields: ["looping"] },
    ],
  },
  {
    toolName: "ableton_arrangement",
    action: "set-clip-properties",
    alternatives: [
      { fields: ["name"] },
      { fields: ["muted"] },
      { fields: ["looping"] },
    ],
  },
  {
    toolName: "ableton_devices",
    action: "set-chain-properties",
    alternatives: [{ fields: ["name"] }, { fields: ["colorIndex"] }],
  },
  {
    toolName: "ableton_devices",
    action: "set-chain-mixer",
    alternatives: [
      { fields: ["mute"] },
      { fields: ["solo"] },
      { fields: ["volume"] },
      { fields: ["pan"] },
      {
        fields: ["sends"],
        properties: { sends: { type: "array", minItems: 1 } },
      },
    ],
  },
] as const satisfies readonly RequiredAnyRule[];

export const abletonAgentSemanticPreconditions = [
  {
    toolName: "ableton_audio_clips",
    action: "set-warp-mode",
    description:
      "expectedAvailableWarpModes must be unique and include warpMode.",
  },
  {
    toolName: "ableton_audio_clips",
    action: "set-markers",
    description:
      "Marker end values must be greater than their corresponding start values.",
  },
  {
    toolName: "ableton_clip_automation",
    action: "sample",
    description: "endTime must be greater than or equal to startTime.",
  },
  {
    toolName: "ableton_special_devices",
    action: "set-simpler-markers",
    description:
      "end must be greater than start; when both loop markers are supplied, loopEnd must be greater than loopStart.",
  },
  {
    toolName: "ableton_special_devices",
    action: "set-simpler-slices",
    description: "Slice positions must be strictly increasing.",
  },
  {
    toolName: "ableton_transport",
    action: "set-arrangement-loop",
    description: "start plus length must not exceed 1576800 beats.",
  },
  {
    toolName: "ableton_arrangement",
    action: "create-midi-clip",
    description: "startTime plus length must not exceed 1576800 beats.",
  },
  {
    toolName: "ableton_arrangement",
    action: "fill-region",
    description: "regionEnd must be greater than regionStart.",
  },
  {
    toolName: "ableton_browser",
    action: "children",
    description: "offset plus limit minus one must not exceed 4096.",
  },
  {
    toolName: "ableton_browser",
    action: "search",
    description: "Browser roots must be unique.",
  },
  {
    toolName: "ableton_devices",
    action: "set-chain-mixer",
    description: "Send indexes must be unique.",
  },
] as const satisfies readonly SemanticPreconditionRule[];

const agentParametersMarker = Symbol("abletonAgentParameters");

function jsonSchema(value: unknown): JsonSchema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function isRuntimeParameterSchema(
  parameters: Tool["parameters"],
): parameters is Tool["parameters"] & RuntimeParameterSchema {
  return (
    parameters !== undefined &&
    typeof parameters === "object" &&
    "safeParse" in parameters &&
    typeof parameters.safeParse === "function" &&
    "toJSONSchema" in parameters &&
    typeof parameters.toJSONSchema === "function"
  );
}

function actionValue(schema: JsonSchema): string | undefined {
  const properties = jsonSchema(schema.properties);
  if (properties === undefined) return undefined;
  const action = jsonSchema(properties.action);
  if (action === undefined) return undefined;
  const value = action.const;
  return typeof value === "string" ? value : undefined;
}

function visitSchemas(
  value: unknown,
  visitor: (schema: JsonSchema) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visitSchemas(item, visitor);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const schema = value as JsonSchema;
  visitor(schema);
  for (const child of Object.values(schema)) visitSchemas(child, visitor);
}

function schemaProperties(schema: JsonSchema): JsonSchema | undefined {
  return jsonSchema(schema.properties);
}

function isWorkflowTrackSchema(schema: JsonSchema): boolean {
  const properties = schemaProperties(schema);
  if (properties === undefined) return false;
  const kind = jsonSchema(properties.kind);
  if (kind === undefined) return false;
  const values = kind.enum;
  return (
    Array.isArray(values) &&
    values.length === 3 &&
    ["master", "regular", "return"].every((value) => values.includes(value)) &&
    "expectedReference" in properties &&
    "expectedName" in properties
  );
}

function enforceWorkflowTrackIdentity(schema: JsonSchema): void {
  visitSchemas(schema, (candidate) => {
    if (!isWorkflowTrackSchema(candidate)) return;
    candidate.oneOf = [
      {
        properties: { kind: { const: "regular" } },
        required: ["index"],
      },
      {
        properties: { kind: { const: "return" } },
        required: ["index"],
      },
      {
        properties: { kind: { const: "master" } },
        not: { required: ["index"] },
      },
    ];
  });
}

function requireRegularTrack(schema: unknown): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  const trackSchema = schema as JsonSchema;
  const properties = schemaProperties(trackSchema);
  if (properties === undefined || !isWorkflowTrackSchema(trackSchema)) return;
  properties.kind = { type: "string", const: "regular" };
  trackSchema.required = [
    ...new Set([
      ...(Array.isArray(trackSchema.required)
        ? trackSchema.required.filter(
            (field): field is string => typeof field === "string",
          )
        : []),
      "kind",
      "index",
    ]),
  ];
  delete trackSchema.oneOf;
}

function enforceRegularWorkflowTargets(schema: JsonSchema): void {
  visitSchemas(schema, (candidate) => {
    const properties = schemaProperties(candidate);
    if (properties === undefined) return;
    const requiresRegularTrack =
      ("track" in properties &&
        "sceneIndex" in properties &&
        ("expectedClipReference" in properties ||
          "expectedSceneReference" in properties)) ||
      ("track" in properties &&
        "rackIndex" in properties &&
        "chainIndex" in properties);
    if (requiresRegularTrack) requireRegularTrack(properties.track);
  });
}

function enforceEmptySlot(schema: unknown): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  const slotSchema = schema as JsonSchema;
  const properties = schemaProperties(slotSchema);
  if (
    properties === undefined ||
    !("expectedHasClip" in properties) ||
    !("track" in properties)
  ) {
    return;
  }
  requireRegularTrack(properties.track);
  properties.expectedHasClip = { type: "boolean", const: false };
  slotSchema.not = {
    anyOf: [
      { required: ["expectedClipReference"] },
      { required: ["expectedClipName"] },
    ],
  };
}

function enforceEmptySlotActions(schema: JsonSchema): void {
  visitSchemas(schema, (candidate) => {
    const action = actionValue(candidate);
    const properties = schemaProperties(candidate);
    if (properties === undefined) return;
    if (action === "record-session-slot") {
      enforceEmptySlot(properties.target);
    } else if (action === "export-looper") {
      enforceEmptySlot(properties.destination);
    }
  });
}

function enrichWorkflowIdentityContracts(schema: JsonSchema): void {
  enforceWorkflowTrackIdentity(schema);
  enforceRegularWorkflowTargets(schema);
  enforceEmptySlotActions(schema);
}

function enrichRequiredAlternatives(
  schema: JsonSchema,
  rule: RequiredAnyRule,
): void {
  visitSchemas(schema, (candidate) => {
    if (
      rule.action === undefined
        ? candidate === schema
        : actionValue(candidate) === rule.action
    ) {
      const alternatives = rule.alternatives.map((alternative) => ({
        required: [...alternative.fields],
        ...(alternative.properties === undefined
          ? {}
          : { properties: alternative.properties }),
      }));
      const existing: unknown[] = Array.isArray(candidate.anyOf)
        ? candidate.anyOf
        : [];
      candidate.anyOf = [...existing, ...alternatives];
    }
  });
}

function enrichSemanticPrecondition(
  schema: JsonSchema,
  rule: SemanticPreconditionRule,
): void {
  visitSchemas(schema, (candidate) => {
    if (
      rule.action === undefined
        ? candidate === schema
        : actionValue(candidate) === rule.action
    ) {
      const existing =
        typeof candidate.description === "string"
          ? `${candidate.description.trim()} `
          : "";
      candidate.description = `${existing}${rule.description}`.trim();
    }
  });
}

function enrichAgentJsonSchema(
  toolName: string,
  schema: JsonSchema,
): JsonSchema {
  if (
    schema.type === undefined &&
    (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf))
  ) {
    schema.type = "object";
    const actions = collectActionValues(schema);
    if (actions.length > 0) {
      const properties = jsonSchema(schema.properties) ?? {};
      properties.action = { type: "string", enum: actions };
      schema.properties = properties;
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (field): field is string => typeof field === "string",
          )
        : [];
      schema.required = [...new Set([...required, "action"])];
    }
  }
  enrichWorkflowIdentityContracts(schema);
  for (const rule of abletonAgentSchemaRequirements) {
    if (rule.toolName === toolName) enrichRequiredAlternatives(schema, rule);
  }
  for (const rule of abletonAgentSemanticPreconditions) {
    if (rule.toolName === toolName) enrichSemanticPrecondition(schema, rule);
  }
  if (toolName === "set_sql_search") {
    const properties = jsonSchema(schema.properties);
    const parameters = jsonSchema(properties?.parameters);
    if (parameters !== undefined) parameters.maxProperties = 32;
  }
  return schema;
}

export function agentFacingParameters<T>(
  toolName: string,
  parameters: Tool<T>["parameters"],
): Tool<T>["parameters"] {
  if (!isRuntimeParameterSchema(parameters)) return parameters;
  if (agentParametersMarker in parameters) return parameters;
  const runtimeSchema = parameters;
  return {
    _output: undefined,
    [agentParametersMarker]: true,
    safeParse: runtimeSchema.safeParse.bind(runtimeSchema),
    toJSONSchema: () =>
      enrichAgentJsonSchema(toolName, runtimeSchema.toJSONSchema()),
  } as Tool<T>["parameters"];
}

function collectActionValues(schema: JsonSchema): readonly string[] {
  const actions = new Set<string>();
  visitSchemas(schema, (candidate) => {
    const action = actionValue(candidate);
    if (action !== undefined) actions.add(action);
  });
  return [...actions].sort();
}

function expectedShape(
  schema: JsonSchema,
  suppliedAction: unknown,
): Readonly<Record<string, unknown>> | undefined {
  let selected: JsonSchema | undefined;
  visitSchemas(schema, (candidate) => {
    if (
      selected === undefined &&
      typeof suppliedAction === "string" &&
      actionValue(candidate) === suppliedAction
    ) {
      selected = candidate;
    }
  });
  if (selected === undefined) return undefined;
  const properties =
    selected.properties !== null &&
    typeof selected.properties === "object" &&
    !Array.isArray(selected.properties)
      ? (selected.properties as JsonSchema)
      : {};
  const required = Array.isArray(selected.required)
    ? selected.required.filter(
        (field): field is string => typeof field === "string",
      )
    : [];
  const optional = Object.keys(properties).filter(
    (field) => !required.includes(field),
  );
  const literals = Object.fromEntries(
    Object.entries(properties).flatMap(([field, property]) => {
      const propertySchema = jsonSchema(property);
      if (propertySchema === undefined) return [];
      const literal = propertySchema.const;
      return literal === undefined ? [] : [[field, literal]];
    }),
  );
  const requiresOneOf = Array.isArray(selected.anyOf)
    ? selected.anyOf
        .map((alternative) => {
          const alternativeSchema = jsonSchema(alternative);
          const required = alternativeSchema?.required;
          if (!Array.isArray(required)) return [];
          return required.filter(
            (field: unknown): field is string => typeof field === "string",
          );
        })
        .filter((fields) => fields.length > 0)
    : [];
  return {
    required,
    optional,
    literals,
    ...(requiresOneOf.length === 0 ? {} : { requiresOneOf }),
  };
}

function normalizedIssues(
  issues: readonly Record<string, unknown>[],
): readonly Readonly<Record<string, unknown>>[] {
  return issues.slice(0, 12).map((issue) => ({
    code: typeof issue.code === "string" ? issue.code : "invalid",
    path: Array.isArray(issue.path)
      ? issue.path
          .filter(
            (part): part is string | number =>
              typeof part === "string" || typeof part === "number",
          )
          .slice(0, 12)
      : [],
    message:
      typeof issue.message === "string"
        ? issue.message.slice(0, 512)
        : "Invalid value",
    ...(typeof issue.expected === "string"
      ? { expected: issue.expected.slice(0, 128) }
      : {}),
    ...(Array.isArray(issue.values)
      ? {
          values: issue.values
            .filter((value): value is string | number | boolean =>
              ["string", "number", "boolean"].includes(typeof value),
            )
            .slice(0, 32),
        }
      : {}),
  }));
}

export class AbletonInvalidToolArgumentsError extends Error {
  public readonly code = "invalid_tool_arguments";
  public readonly retryable = true;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    toolName: string,
    suppliedArguments: unknown,
    schema: RuntimeParameterSchema,
    issues: readonly Record<string, unknown>[],
  ) {
    const suppliedAction =
      suppliedArguments !== null &&
      typeof suppliedArguments === "object" &&
      !Array.isArray(suppliedArguments)
        ? (suppliedArguments as Record<string, unknown>).action
        : undefined;
    const jsonSchema = schema.toJSONSchema();
    const validActions = collectActionValues(jsonSchema);
    const suppliedActionDetail =
      typeof suppliedAction === "string"
        ? suppliedAction.slice(0, 128)
        : typeof suppliedAction === "number" ||
            typeof suppliedAction === "boolean"
          ? String(suppliedAction)
          : suppliedAction === null
            ? "null"
            : undefined;
    const actionText =
      typeof suppliedAction === "string"
        ? ` action '${suppliedAction}'`
        : validActions.length > 0
          ? " with a required action"
          : "";
    super(`Invalid arguments for ${toolName}${actionText}`);
    this.name = "AbletonInvalidToolArgumentsError";
    this.details = {
      toolName,
      ...(suppliedActionDetail === undefined
        ? {}
        : { suppliedAction: suppliedActionDetail }),
      ...(validActions.length === 0 ? {} : { validActions }),
      issues: normalizedIssues(issues),
      ...(expectedShape(jsonSchema, suppliedAction) === undefined
        ? {}
        : { expectedShape: expectedShape(jsonSchema, suppliedAction) }),
    };
  }
}

export function abletonToolArgumentError(
  toolName: string,
  parameters: Tool["parameters"],
  suppliedArguments: unknown,
): AbletonInvalidToolArgumentsError | undefined {
  if (!isRuntimeParameterSchema(parameters)) return undefined;
  const parsed = parameters.safeParse(suppliedArguments);
  return parsed.success
    ? undefined
    : new AbletonInvalidToolArgumentsError(
        toolName,
        suppliedArguments,
        parameters,
        parsed.error.issues,
      );
}
