export interface Schema<T> {
  readonly parse: (value: unknown) => T;
}

function schema<T>(parse: (value: unknown) => T): Schema<T> {
  return { parse };
}

function record(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const unexpected = Object.keys(result).find((key) => !keys.includes(key));
  if (unexpected !== undefined) {
    throw new TypeError(`${label} has unexpected key '${unexpected}'`);
  }
  return result;
}

function stringValue(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function numberValue(
  value: unknown,
  label: string,
  options: { integer?: boolean; min?: number; positive?: boolean } = {},
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isInteger(value)) ||
    (options.min !== undefined && value < options.min) ||
    (options.positive === true && value <= 0)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function arrayValue<T>(
  value: unknown,
  parser: (item: unknown) => T,
  label: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map(parser);
}

function optional<T>(
  value: unknown,
  parser: (item: unknown) => T,
): T | undefined {
  return value === undefined ? undefined : parser(value);
}

function present<T extends object, K extends string, V>(
  object: T,
  key: K,
  value: V | undefined,
): T & Partial<Record<K, V>> {
  return value === undefined ? object : { ...object, [key]: value };
}

export const idSchema = schema<string>((value) => {
  const id = stringValue(value, "id");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  ) {
    throw new TypeError("id must be a UUID");
  }
  return id;
});

export const timestampSchema = schema<string>((value) => {
  const timestamp = stringValue(value, "timestamp");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      timestamp,
    ) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw new TypeError("timestamp must be ISO-8601 with an offset");
  }
  return timestamp;
});

export const revisionSchema = schema<number>((value) =>
  numberValue(value, "revision", { integer: true, min: 0 }),
);

export interface ProjectIdentity {
  readonly id: string;
  readonly abletonProjectId: string;
  readonly displayName: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export const projectIdentitySchema = schema<ProjectIdentity>((value) => {
  const input = record(
    value,
    ["id", "abletonProjectId", "displayName", "firstSeenAt", "lastSeenAt"],
    "project identity",
  );
  return {
    id: idSchema.parse(input.id),
    abletonProjectId: stringValue(input.abletonProjectId, "abletonProjectId"),
    displayName: stringValue(input.displayName, "displayName"),
    firstSeenAt: timestampSchema.parse(input.firstSeenAt),
    lastSeenAt: timestampSchema.parse(input.lastSeenAt),
  };
});

const entityKinds = [
  "track",
  "return-track",
  "master-track",
  "scene",
  "session-clip",
  "arrangement-clip",
  "device",
  "cue-point",
] as const;
export type EntityKind = (typeof entityKinds)[number];
export const entityKindSchema = schema<EntityKind>((value) =>
  enumValue(value, entityKinds, "entity kind"),
);

export interface EntityReference {
  readonly projectId: string;
  readonly kind: EntityKind;
  readonly id: string;
  readonly revision: number;
}

export const entityReferenceSchema = schema<EntityReference>((value) => {
  const input = record(
    value,
    ["projectId", "kind", "id", "revision"],
    "entity reference",
  );
  return {
    projectId: idSchema.parse(input.projectId),
    kind: entityKindSchema.parse(input.kind),
    id: stringValue(input.id, "entity id"),
    revision: revisionSchema.parse(input.revision),
  };
});

export interface TrackSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "audio" | "midi" | "return" | "master";
  readonly index: number;
  readonly color: number | null;
  readonly isMuted: boolean;
  readonly isSoloed: boolean;
  readonly isArmed: boolean;
}

export const trackSummarySchema = schema<TrackSummary>((value) => {
  const input = record(
    value,
    ["id", "name", "kind", "index", "color", "isMuted", "isSoloed", "isArmed"],
    "track summary",
  );
  return {
    id: stringValue(input.id, "track id"),
    name: stringValue(input.name, "track name", true),
    kind: enumValue(
      input.kind,
      ["audio", "midi", "return", "master"] as const,
      "track kind",
    ),
    index: numberValue(input.index, "track index", {
      integer: true,
      min: 0,
    }),
    color:
      input.color === null
        ? null
        : numberValue(input.color, "track color", { integer: true }),
    isMuted: booleanValue(input.isMuted, "isMuted"),
    isSoloed: booleanValue(input.isSoloed, "isSoloed"),
    isArmed: booleanValue(input.isArmed, "isArmed"),
  };
});

export interface SceneSummary {
  readonly id: string;
  readonly name: string;
  readonly index: number;
}
export const sceneSummarySchema = schema<SceneSummary>((value) => {
  const input = record(value, ["id", "name", "index"], "scene summary");
  return {
    id: stringValue(input.id, "scene id"),
    name: stringValue(input.name, "scene name", true),
    index: numberValue(input.index, "scene index", {
      integer: true,
      min: 0,
    }),
  };
});

export interface SessionClipSummary {
  readonly id: string;
  readonly name: string;
  readonly trackId: string;
  readonly sceneId: string;
  readonly hasContent: boolean;
  readonly isPlaying: boolean;
  readonly isTriggered: boolean;
}
export const sessionClipSummarySchema = schema<SessionClipSummary>((value) => {
  const input = record(
    value,
    [
      "id",
      "name",
      "trackId",
      "sceneId",
      "hasContent",
      "isPlaying",
      "isTriggered",
    ],
    "session clip summary",
  );
  return {
    id: stringValue(input.id, "clip id"),
    name: stringValue(input.name, "clip name", true),
    trackId: stringValue(input.trackId, "trackId"),
    sceneId: stringValue(input.sceneId, "sceneId"),
    hasContent: booleanValue(input.hasContent, "hasContent"),
    isPlaying: booleanValue(input.isPlaying, "isPlaying"),
    isTriggered: booleanValue(input.isTriggered, "isTriggered"),
  };
});

export interface ArrangementClipSummary {
  readonly id: string;
  readonly name: string;
  readonly trackId: string;
  readonly start: number;
  readonly duration: number;
}
export const arrangementClipSummarySchema = schema<ArrangementClipSummary>(
  (value) => {
    const input = record(
      value,
      ["id", "name", "trackId", "start", "duration"],
      "arrangement clip summary",
    );
    return {
      id: stringValue(input.id, "clip id"),
      name: stringValue(input.name, "clip name", true),
      trackId: stringValue(input.trackId, "trackId"),
      start: numberValue(input.start, "clip start", { min: 0 }),
      duration: numberValue(input.duration, "clip duration", {
        positive: true,
      }),
    };
  },
);

export interface DeviceSummary {
  readonly id: string;
  readonly name: string;
  readonly trackId: string;
  readonly index: number;
  readonly className: string;
  readonly isEnabled: boolean;
}
export const deviceSummarySchema = schema<DeviceSummary>((value) => {
  const input = record(
    value,
    ["id", "name", "trackId", "index", "className", "isEnabled"],
    "device summary",
  );
  return {
    id: stringValue(input.id, "device id"),
    name: stringValue(input.name, "device name", true),
    trackId: stringValue(input.trackId, "trackId"),
    index: numberValue(input.index, "device index", {
      integer: true,
      min: 0,
    }),
    className: stringValue(input.className, "className"),
    isEnabled: booleanValue(input.isEnabled, "isEnabled"),
  };
});

export interface CuePointSummary {
  readonly id: string;
  readonly name: string;
  readonly time: number;
}
export const cuePointSummarySchema = schema<CuePointSummary>((value) => {
  const input = record(value, ["id", "name", "time"], "cue point summary");
  return {
    id: stringValue(input.id, "cue point id"),
    name: stringValue(input.name, "cue point name", true),
    time: numberValue(input.time, "cue point time", { min: 0 }),
  };
});

export interface TransportSummary {
  readonly tempo: number;
  readonly timeSignature: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly loop: {
    readonly enabled: boolean;
    readonly start: number;
    readonly duration: number;
  };
  readonly isPlaying: boolean;
  readonly currentTime: number;
}
export const transportSummarySchema = schema<TransportSummary>((value) => {
  const input = record(
    value,
    ["tempo", "timeSignature", "loop", "isPlaying", "currentTime"],
    "transport",
  );
  const signature = record(
    input.timeSignature,
    ["numerator", "denominator"],
    "time signature",
  );
  const loop = record(input.loop, ["enabled", "start", "duration"], "loop");
  return {
    tempo: numberValue(input.tempo, "tempo", { positive: true }),
    timeSignature: {
      numerator: numberValue(signature.numerator, "numerator", {
        integer: true,
        positive: true,
      }),
      denominator: numberValue(signature.denominator, "denominator", {
        integer: true,
        positive: true,
      }),
    },
    loop: {
      enabled: booleanValue(loop.enabled, "loop enabled"),
      start: numberValue(loop.start, "loop start", { min: 0 }),
      duration: numberValue(loop.duration, "loop duration", {
        positive: true,
      }),
    },
    isPlaying: booleanValue(input.isPlaying, "isPlaying"),
    currentTime: numberValue(input.currentTime, "currentTime", { min: 0 }),
  };
});

export interface ProjectSnapshot {
  readonly project: ProjectIdentity;
  readonly revision: number;
  readonly liveVersion: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly transport: TransportSummary;
  readonly tracks: readonly TrackSummary[];
  readonly scenes: readonly SceneSummary[];
  readonly sessionClips: readonly SessionClipSummary[];
  readonly arrangementClips: readonly ArrangementClipSummary[];
  readonly devices: readonly DeviceSummary[];
  readonly cuePoints: readonly CuePointSummary[];
  readonly selected: readonly EntityReference[];
}
export const projectSnapshotSchema = schema<ProjectSnapshot>((value) => {
  const input = record(
    value,
    [
      "project",
      "revision",
      "liveVersion",
      "capabilities",
      "transport",
      "tracks",
      "scenes",
      "sessionClips",
      "arrangementClips",
      "devices",
      "cuePoints",
      "selected",
    ],
    "project snapshot",
  );
  if (
    typeof input.capabilities !== "object" ||
    input.capabilities === null ||
    Array.isArray(input.capabilities)
  ) {
    throw new TypeError("capabilities must be an object");
  }
  const parsedCapabilities: Record<string, boolean> = {};
  for (const [key, capability] of Object.entries(
    input.capabilities as Record<string, unknown>,
  )) {
    parsedCapabilities[key] = booleanValue(capability, `capability ${key}`);
  }
  return {
    project: projectIdentitySchema.parse(input.project),
    revision: revisionSchema.parse(input.revision),
    liveVersion: stringValue(input.liveVersion, "liveVersion"),
    capabilities: parsedCapabilities,
    transport: transportSummarySchema.parse(input.transport),
    tracks: arrayValue(input.tracks, trackSummarySchema.parse, "tracks"),
    scenes: arrayValue(input.scenes, sceneSummarySchema.parse, "scenes"),
    sessionClips: arrayValue(
      input.sessionClips,
      sessionClipSummarySchema.parse,
      "sessionClips",
    ),
    arrangementClips: arrayValue(
      input.arrangementClips,
      arrangementClipSummarySchema.parse,
      "arrangementClips",
    ),
    devices: arrayValue(input.devices, deviceSummarySchema.parse, "devices"),
    cuePoints: arrayValue(
      input.cuePoints,
      cuePointSummarySchema.parse,
      "cuePoints",
    ),
    selected: arrayValue(
      input.selected,
      entityReferenceSchema.parse,
      "selected",
    ),
  };
});

export interface SectionPlan {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}
export interface TrackRole {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}
function namedPlanItem(value: unknown, label: string): SectionPlan {
  const input = record(value, ["id", "name", "purpose"], label);
  return {
    id: idSchema.parse(input.id),
    name: stringValue(input.name, `${label} name`),
    purpose: stringValue(input.purpose, `${label} purpose`),
  };
}
export const sectionPlanSchema = schema<SectionPlan>((value) =>
  namedPlanItem(value, "section"),
);
export const trackRoleSchema = schema<TrackRole>((value) =>
  namedPlanItem(value, "track role"),
);
const productionPlanStatuses = [
  "draft",
  "approved",
  "in-progress",
  "complete",
] as const;
export type ProductionPlanStatus = (typeof productionPlanStatuses)[number];
export const productionPlanStatusSchema = schema<ProductionPlanStatus>(
  (value) => enumValue(value, productionPlanStatuses, "plan status"),
);
export interface ProductionPlan {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly tempo?: number;
  readonly key?: string;
  readonly sections: readonly SectionPlan[];
  readonly trackRoles: readonly TrackRole[];
  readonly constraints: readonly string[];
  readonly status: ProductionPlanStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export const productionPlanSchema = schema<ProductionPlan>((value) => {
  const input = record(
    value,
    [
      "id",
      "projectId",
      "goal",
      "tempo",
      "key",
      "sections",
      "trackRoles",
      "constraints",
      "status",
      "version",
      "createdAt",
      "updatedAt",
    ],
    "production plan",
  );
  let result: ProductionPlan = {
    id: idSchema.parse(input.id),
    projectId: idSchema.parse(input.projectId),
    goal: stringValue(input.goal, "goal"),
    sections: arrayValue(input.sections, sectionPlanSchema.parse, "sections"),
    trackRoles: arrayValue(
      input.trackRoles,
      trackRoleSchema.parse,
      "trackRoles",
    ),
    constraints: arrayValue(
      input.constraints,
      (item) => stringValue(item, "constraint"),
      "constraints",
    ),
    status: productionPlanStatusSchema.parse(input.status),
    version: numberValue(input.version, "version", {
      integer: true,
      positive: true,
    }),
    createdAt: timestampSchema.parse(input.createdAt),
    updatedAt: timestampSchema.parse(input.updatedAt),
  };
  result = present(
    result,
    "tempo",
    optional(input.tempo, (item) =>
      numberValue(item, "tempo", { positive: true }),
    ),
  );
  return present(
    result,
    "key",
    optional(input.key, (item) => stringValue(item, "key")),
  );
});

export type MetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly MetadataValue[]
  | { readonly [key: string]: MetadataValue };

const forbiddenDetailKeys = new Set([
  "audio",
  "clipnotes",
  "notes",
  "parameters",
  "samples",
  "waveform",
]);

export const metadataValueSchema: Schema<MetadataValue> = schema<MetadataValue>(
  (value): MetadataValue => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item): MetadataValue =>
        metadataValueSchema.parse(item),
      );
    }
    if (typeof value === "object") {
      const output: Record<string, MetadataValue> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (forbiddenDetailKeys.has(key.toLowerCase())) {
          throw new TypeError(
            `Detailed musical content '${key}' is not persistent metadata`,
          );
        }
        output[key] = metadataValueSchema.parse(item);
      }
      return output;
    }
    throw new TypeError("metadata value is invalid");
  },
);

function metadataRecord(
  value: unknown,
  label: string,
): Record<string, MetadataValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const output: Record<string, MetadataValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = metadataValueSchema.parse(item);
  }
  return output;
}

export interface MutationRecord {
  readonly id: string;
  readonly operation: string;
  readonly target?: EntityReference;
  readonly data: Readonly<Record<string, MetadataValue>>;
  readonly recordedAt: string;
}
export const mutationRecordSchema = schema<MutationRecord>((value) => {
  const input = record(
    value,
    ["id", "operation", "target", "data", "recordedAt"],
    "mutation record",
  );
  return present(
    {
      id: idSchema.parse(input.id),
      operation: stringValue(input.operation, "operation"),
      data: metadataRecord(input.data ?? {}, "mutation data"),
      recordedAt: timestampSchema.parse(input.recordedAt),
    },
    "target",
    optional(input.target, entityReferenceSchema.parse),
  );
});

export interface Verification {
  readonly status: "pending" | "passed" | "failed";
  readonly summary: string;
  readonly checkedAt?: string;
}
export const verificationSchema = schema<Verification>((value) => {
  const input = record(
    value,
    ["status", "summary", "checkedAt"],
    "verification",
  );
  return present(
    {
      status: enumValue(
        input.status,
        ["pending", "passed", "failed"] as const,
        "verification status",
      ),
      summary: stringValue(input.summary, "verification summary", true),
    },
    "checkedAt",
    optional(input.checkedAt, timestampSchema.parse),
  );
});

const changeSetStatuses = [
  "pending",
  "in-progress",
  "verified",
  "failed",
  "recovered",
] as const;
export type ChangeSetStatus = (typeof changeSetStatuses)[number];
export const changeSetStatusSchema = schema<ChangeSetStatus>((value) =>
  enumValue(value, changeSetStatuses, "change-set status"),
);
export interface ChangeSet {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly userIntent: string;
  readonly workflow: string;
  readonly targets: readonly EntityReference[];
  readonly beforeState: Readonly<Record<string, MetadataValue>>;
  readonly requestedMutations: readonly MutationRecord[];
  readonly completedMutations: readonly MutationRecord[];
  readonly verification: Verification;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly recovery: readonly string[];
  readonly status: ChangeSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export const changeSetSchema = schema<ChangeSet>((value) => {
  const input = record(
    value,
    [
      "id",
      "projectId",
      "sessionId",
      "correlationId",
      "userIntent",
      "workflow",
      "targets",
      "beforeState",
      "requestedMutations",
      "completedMutations",
      "verification",
      "warnings",
      "errors",
      "recovery",
      "status",
      "createdAt",
      "updatedAt",
    ],
    "change set",
  );
  const parsed: ChangeSet = {
    id: idSchema.parse(input.id),
    projectId: idSchema.parse(input.projectId),
    sessionId: idSchema.parse(input.sessionId),
    correlationId: idSchema.parse(input.correlationId),
    userIntent: stringValue(input.userIntent, "user intent"),
    workflow: stringValue(input.workflow, "workflow"),
    targets: arrayValue(input.targets, entityReferenceSchema.parse, "targets"),
    beforeState: metadataRecord(input.beforeState, "before state"),
    requestedMutations: arrayValue(
      input.requestedMutations,
      mutationRecordSchema.parse,
      "requested mutations",
    ),
    completedMutations: arrayValue(
      input.completedMutations,
      mutationRecordSchema.parse,
      "completed mutations",
    ),
    verification: verificationSchema.parse(input.verification),
    warnings: arrayValue(
      input.warnings,
      (item) => stringValue(item, "warning", true),
      "warnings",
    ),
    errors: arrayValue(
      input.errors,
      (item) => stringValue(item, "error", true),
      "errors",
    ),
    recovery: arrayValue(
      input.recovery,
      (item) => stringValue(item, "recovery", true),
      "recovery",
    ),
    status: changeSetStatusSchema.parse(input.status),
    createdAt: timestampSchema.parse(input.createdAt),
    updatedAt: timestampSchema.parse(input.updatedAt),
  };
  const references = [
    ...parsed.targets,
    ...parsed.requestedMutations.flatMap((mutation) =>
      mutation.target === undefined ? [] : [mutation.target],
    ),
    ...parsed.completedMutations.flatMap((mutation) =>
      mutation.target === undefined ? [] : [mutation.target],
    ),
  ];
  if (
    references.some((reference) => reference.projectId !== parsed.projectId)
  ) {
    throw new TypeError("Change-set references must belong to its project");
  }
  if (parsed.status === "verified" && parsed.verification.status !== "passed") {
    throw new TypeError("Verified change sets require passed verification");
  }
  if (parsed.status === "failed" && parsed.verification.status !== "failed") {
    throw new TypeError("Failed change sets require failed verification");
  }
  if (
    (parsed.status === "pending" || parsed.status === "in-progress") &&
    parsed.verification.status !== "pending"
  ) {
    throw new TypeError("Open change sets require pending verification");
  }
  return parsed;
});

export interface AppSession {
  readonly id: string;
  readonly activeProjectId?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}
export const appSessionSchema = schema<AppSession>((value) => {
  const input = record(
    value,
    ["id", "activeProjectId", "startedAt", "updatedAt"],
    "app session",
  );
  return present(
    {
      id: idSchema.parse(input.id),
      startedAt: timestampSchema.parse(input.startedAt),
      updatedAt: timestampSchema.parse(input.updatedAt),
    },
    "activeProjectId",
    optional(input.activeProjectId, idSchema.parse),
  );
});

export interface Preference {
  readonly sessionId: string;
  readonly key: string;
  readonly value: MetadataValue;
  readonly updatedAt: string;
}
export const preferenceSchema = schema<Preference>((value) => {
  const input = record(
    value,
    ["sessionId", "key", "value", "updatedAt"],
    "preference",
  );
  return {
    sessionId: idSchema.parse(input.sessionId),
    key: stringValue(input.key, "preference key"),
    value: metadataValueSchema.parse(input.value),
    updatedAt: timestampSchema.parse(input.updatedAt),
  };
});

export interface ApprovalDecision {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly subjectType: "plan" | "change-set";
  readonly subjectId: string;
  readonly decision: "approved" | "rejected";
  readonly reason: string;
  readonly decidedAt: string;
}
export const approvalDecisionSchema = schema<ApprovalDecision>((value) => {
  const input = record(
    value,
    [
      "id",
      "projectId",
      "sessionId",
      "subjectType",
      "subjectId",
      "decision",
      "reason",
      "decidedAt",
    ],
    "approval decision",
  );
  return {
    id: idSchema.parse(input.id),
    projectId: idSchema.parse(input.projectId),
    sessionId: idSchema.parse(input.sessionId),
    subjectType: enumValue(
      input.subjectType,
      ["plan", "change-set"] as const,
      "subject type",
    ),
    subjectId: idSchema.parse(input.subjectId),
    decision: enumValue(
      input.decision,
      ["approved", "rejected"] as const,
      "decision",
    ),
    reason: stringValue(input.reason, "reason", true),
    decidedAt: timestampSchema.parse(input.decidedAt),
  };
});
