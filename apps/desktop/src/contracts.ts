import { z } from "zod";

export const modes = ["explore", "compose", "arrange", "sound", "mix"] as const;
export type ProductMode = (typeof modes)[number];
export type ApprovalDecision = "approve" | "deny";
export const lifecycleStates = [
  "stopped",
  "starting",
  "ready",
  "degraded",
  "stopping",
  "crashed",
] as const;
export type DesktopLifecycleState = (typeof lifecycleStates)[number];

export const contextChipSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["track", "clip", "range", "device", "section"]),
  label: z.string().min(1).max(160),
});
export type ContextChip = z.infer<typeof contextChipSchema>;

const connectionStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disconnected") }),
  z.object({ state: z.literal("connecting") }),
  z.object({
    state: z.literal("connected"),
    liveVersion: z.string(),
    remoteScriptVersion: z.string(),
    projectId: z.string(),
  }),
  z.object({
    state: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type DesktopConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const trackSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["midi", "audio", "return", "master"]),
  color: z.string(),
  volume: z.number().min(0).max(1),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  clips: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sceneIndex: z.number().int().nonnegative(),
      lengthBeats: z.number().positive(),
      status: z.enum(["playing", "queued", "stopped"]),
    }),
  ),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      enabled: z.boolean(),
      parameters: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          value: z.number().min(0).max(1),
          displayValue: z.string(),
        }),
      ),
    }),
  ),
});
export type DesktopTrack = z.infer<typeof trackSchema>;

export const projectSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  tempo: z.number().positive(),
  timeSignature: z.string(),
  tracks: z.array(trackSchema),
});
export type DesktopProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

export const outputDeliveryModeSchema = z.enum([
  "next-prompt",
  "automatic-analysis",
  "automatic-action",
]);
export type OutputDeliveryMode = z.infer<typeof outputDeliveryModeSchema>;

export const desktopOutputAssignmentSchema = z.object({
  assignmentId: z.string().min(1),
  producerId: z.string().min(1),
  enabled: z.boolean(),
  deliveryMode: outputDeliveryModeSchema,
  usageInstruction: z.string().min(1).max(4096),
  processingPolicyIds: z.array(z.string().min(1)).max(64),
});
export type DesktopOutputAssignment = z.infer<
  typeof desktopOutputAssignmentSchema
>;

export const desktopOutputConnectionSchema = z.object({
  connectionId: z.string().min(1),
  producerId: z.string().min(1),
  instanceId: z.string().min(1),
  displayName: z.string().min(1),
  signalKind: z.enum(["midi", "audio"]),
  state: z.enum(["connected", "stale", "disconnected"]),
  receiving: z.boolean(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  track: z
    .object({
      id: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      name: z.string().optional(),
    })
    .optional(),
  device: z
    .object({ id: z.string().optional(), name: z.string().optional() })
    .optional(),
});
export type DesktopOutputConnection = z.infer<
  typeof desktopOutputConnectionSchema
>;

export const latestAcceptedOutputSchema = z.object({
  assignmentId: z.string().min(1),
  producerId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative(),
  summary: z.string().max(2048),
});
export type LatestAcceptedOutput = z.infer<typeof latestAcceptedOutputSchema>;

export const signalServiceStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled"), detail: z.string() }),
  z.object({ state: z.literal("stopped") }),
  z.object({
    state: z.literal("listening"),
    host: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  z.object({ state: z.literal("error"), detail: z.string() }),
]);
export type SignalServiceStatus = z.infer<typeof signalServiceStatusSchema>;

export const desktopOutputsStateSchema = z.object({
  status: signalServiceStatusSchema,
  connections: z.array(desktopOutputConnectionSchema),
  assignments: z.array(desktopOutputAssignmentSchema),
  latest: z.array(latestAcceptedOutputSchema),
  activeSessionId: z.string().optional(),
});
export type DesktopOutputsState = z.infer<typeof desktopOutputsStateSchema>;

export const planSectionSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  startBar: z.number().int().positive(),
  endBar: z.number().int().positive(),
  tracks: z.array(z.string()),
  status: z.enum(["proposed", "approved", "completed", "partial", "failed"]),
});
export type PlanSection = z.infer<typeof planSectionSchema>;

export const approvalSchema = z.object({
  id: z.string(),
  title: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  changes: z.array(z.string()),
  destructive: z.boolean(),
});
export type ApprovalRequest = z.infer<typeof approvalSchema>;

export const operationSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["running", "completed", "partial", "failed", "cancelled"]),
  detail: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  changed: z.array(z.string()).default([]),
  unchanged: z.array(z.string()).default([]),
  retryable: z.boolean().default(false),
  undoable: z.boolean().default(false),
  timestamp: z.number(),
});
export type OperationView = z.infer<typeof operationSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  projectName: z.string(),
  projectId: z.string().optional(),
  mode: z.enum(modes).default("explore"),
  productionPlan: z.array(planSectionSchema).default([]),
  outputAssignments: z.array(desktopOutputAssignmentSchema).default([]),
});
export type DesktopSession = z.infer<typeof sessionSchema>;

export const preferencesSchema = z.object({
  version: z.literal(1).default(1),
  /** "auto" keeps whatever model the Copilot runtime selects by default. */
  model: z.string().min(1).default("auto"),
  reasoning: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  approvalPolicy: z
    .enum(["always", "risky", "never", "approve-all"])
    .default("risky"),
  abletonPort: z.number().int().min(1).max(65535).default(8765),
  signalPort: z.number().int().min(1).max(65535).default(45832),
  remoteScriptLocation: z.string().default("Auto-detect"),
  loggingLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  telemetryEnabled: z.boolean().default(false),
  workflowDensity: z.enum(["compact", "comfortable"]).default("comfortable"),
});
export type DesktopPreferences = z.infer<typeof preferencesSchema>;

export const diagnosticCheckSchema = z.object({
  label: z.string(),
  status: z.enum(["pass", "warn", "fail"]),
  detail: z.string(),
});
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;

export const desktopDiagnosticsReportSchema = z.object({
  checks: z.array(diagnosticCheckSchema),
  logging: z.object({
    level: z.enum(["error", "warn", "info", "debug"]),
    fileName: z.string().min(1),
    filePath: z.string().min(1),
    environmentOverride: z.boolean().optional(),
  }),
});
export type DesktopDiagnosticsReport = z.infer<
  typeof desktopDiagnosticsReportSchema
>;

export const appEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("lifecycle.changed"),
    state: z.enum(lifecycleStates),
  }),
  z.object({
    type: z.literal("ableton.connection_changed"),
    status: connectionStatusSchema,
  }),
  z.object({
    type: z.literal("agent.message_delta"),
    messageId: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("agent.message_complete"),
    messageId: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("operation.changed"),
    operation: operationSchema,
  }),
  z.object({ type: z.literal("approval.requested"), approval: approvalSchema }),
  z.object({
    type: z.literal("project.snapshot_changed"),
    snapshot: projectSnapshotSchema,
  }),
  z.object({
    type: z.literal("sessions.changed"),
    sessions: z.array(sessionSchema),
  }),
  z.object({
    type: z.literal("session.context_restored"),
    session: sessionSchema,
  }),
  z.object({
    type: z.literal("preferences.changed"),
    preferences: preferencesSchema,
  }),
  z.object({
    type: z.literal("outputs.changed"),
    outputs: desktopOutputsStateSchema,
  }),
  z.object({
    type: z.literal("diagnostic"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
]);
export type DesktopAppEvent = z.infer<typeof appEventSchema>;

export const ipcSchemas = {
  "app:lifecycle": {
    request: z.object({}),
    response: z.object({
      state: z.enum(lifecycleStates),
    }),
  },
  "agent:send": {
    request: z.object({
      message: z.string().trim().min(1).max(20_000),
      context: z.array(contextChipSchema).max(20),
      mode: z.enum(modes),
    }),
    response: z.object({ accepted: z.literal(true), messageId: z.string() }),
  },
  "agent:cancel": {
    request: z.object({}),
    response: z.object({ cancelled: z.boolean() }),
  },
  "agent:create-session": {
    request: z.object({}),
    response: z.object({ sessionId: z.string() }),
  },
  "agent:sessions": {
    request: z.object({}),
    response: z.array(sessionSchema),
  },
  "agent:resume-session": {
    request: z.object({ sessionId: z.string().min(1) }),
    response: z.object({ resumed: z.literal(true) }),
  },
  "ableton:connect": {
    request: z.object({}),
    response: connectionStatusSchema,
  },
  "ableton:status": { request: z.object({}), response: connectionStatusSchema },
  "ableton:capabilities": {
    request: z.object({}),
    response: z.array(z.string()),
  },
  "ableton:snapshot": {
    request: z.object({}),
    response: projectSnapshotSchema,
  },
  "diagnostics:get": {
    request: z.object({}),
    response: desktopDiagnosticsReportSchema,
  },
  "diagnostics:reveal-log": {
    request: z.object({}),
    response: z.object({ revealed: z.literal(true) }),
  },
  "diagnostics:export-support-bundle": {
    request: z.object({}),
    response: z.discriminatedUnion("status", [
      z.object({ status: z.literal("cancelled") }),
      z.object({ status: z.literal("saved"), filePath: z.string().min(1) }),
    ]),
  },
  "diagnostics:copy-summary": {
    request: z.object({}),
    response: z.object({ copied: z.literal(true) }),
  },
  "approvals:resolve": {
    request: z.object({
      id: z.string(),
      decision: z.enum(["approve", "deny"]),
    }),
    response: z.object({ resolved: z.boolean() }),
  },
  "preferences:get": { request: z.object({}), response: preferencesSchema },
  "preferences:set": {
    request: preferencesSchema,
    response: preferencesSchema,
  },
  "project:set-context": {
    request: z.object({ context: z.array(contextChipSchema).max(20) }),
    response: z.object({ updated: z.literal(true) }),
  },
  "plan:update": {
    request: z.object({ sections: z.array(planSectionSchema).max(100) }),
    response: z.object({ updated: z.literal(true) }),
  },
  "operation:retry": {
    request: z.object({ id: z.string() }),
    response: z.object({ accepted: z.boolean() }),
  },
  "operation:undo": {
    request: z.object({ id: z.string() }),
    response: z.object({ accepted: z.boolean() }),
  },
  "outputs:list": {
    request: z.object({}),
    response: desktopOutputsStateSchema,
  },
  "outputs:assign": {
    request: z.object({ producerId: z.string().min(1) }),
    response: desktopOutputAssignmentSchema,
  },
  "outputs:unassign": {
    request: z.object({ producerId: z.string().min(1) }),
    response: z.object({ removed: z.boolean() }),
  },
  "outputs:set-enabled": {
    request: z.object({
      producerId: z.string().min(1),
      enabled: z.boolean(),
    }),
    response: desktopOutputAssignmentSchema,
  },
  "outputs:set-delivery-mode": {
    request: z.object({
      producerId: z.string().min(1),
      deliveryMode: outputDeliveryModeSchema,
    }),
    response: desktopOutputAssignmentSchema,
  },
  "outputs:set-usage-instruction": {
    request: z.object({
      producerId: z.string().min(1),
      usageInstruction: z.string().trim().min(1).max(4096),
    }),
    response: desktopOutputAssignmentSchema,
  },
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type RequestOf<C extends IpcChannel> = z.infer<
  (typeof ipcSchemas)[C]["request"]
>;
export type ResponseOf<C extends IpcChannel> = z.infer<
  (typeof ipcSchemas)[C]["response"]
>;

export interface DesktopApi {
  lifecycle: {
    get(): Promise<DesktopLifecycleState>;
  };
  agent: {
    send(
      message: string,
      context: ContextChip[],
      mode: ProductMode,
    ): Promise<{ accepted: true; messageId: string }>;
    cancel(): Promise<{ cancelled: boolean }>;
    createSession(): Promise<string>;
    getSessions(): Promise<DesktopSession[]>;
    resumeSession(sessionId: string): Promise<void>;
  };
  ableton: {
    connect(): Promise<DesktopConnectionStatus>;
    getStatus(): Promise<DesktopConnectionStatus>;
    getCapabilities(): Promise<string[]>;
    requestSnapshot(): Promise<DesktopProjectSnapshot>;
  };
  approvals: {
    resolve(id: string, decision: ApprovalDecision): Promise<boolean>;
  };
  diagnostics: {
    get(): Promise<DesktopDiagnosticsReport>;
    revealLog(): Promise<void>;
    exportSupportBundle(): Promise<
      { status: "cancelled" } | { status: "saved"; filePath: string }
    >;
    copySummary(): Promise<void>;
  };
  preferences: {
    get(): Promise<DesktopPreferences>;
    set(value: DesktopPreferences): Promise<DesktopPreferences>;
  };
  project: { setContext(context: ContextChip[]): Promise<void> };
  plan: { update(sections: PlanSection[]): Promise<void> };
  operations: {
    retry(id: string): Promise<boolean>;
    undo(id: string): Promise<boolean>;
  };
  outputs: {
    list(): Promise<DesktopOutputsState>;
    assign(producerId: string): Promise<DesktopOutputAssignment>;
    unassign(producerId: string): Promise<boolean>;
    setEnabled(
      producerId: string,
      enabled: boolean,
    ): Promise<DesktopOutputAssignment>;
    setDeliveryMode(
      producerId: string,
      deliveryMode: OutputDeliveryMode,
    ): Promise<DesktopOutputAssignment>;
    setUsageInstruction(
      producerId: string,
      usageInstruction: string,
    ): Promise<DesktopOutputAssignment>;
  };
  events: { subscribe(handler: (event: DesktopAppEvent) => void): () => void };
}
