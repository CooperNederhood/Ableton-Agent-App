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
});
export type DesktopSession = z.infer<typeof sessionSchema>;

export const preferencesSchema = z.object({
  version: z.literal(1).default(1),
  /** "auto" keeps whatever model the Copilot runtime selects by default. */
  model: z.string().min(1).default("auto"),
  reasoning: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  approvalPolicy: z.enum(["always", "risky", "never"]).default("risky"),
  abletonPort: z.number().int().min(1).max(65535).default(8765),
  remoteScriptLocation: z.string().default("Auto-detect"),
  loggingLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  telemetryEnabled: z.boolean().default(false),
  workflowDensity: z.enum(["compact", "comfortable"]).default("comfortable"),
});
export type DesktopPreferences = z.infer<typeof preferencesSchema>;

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
    type: z.literal("preferences.changed"),
    preferences: preferencesSchema,
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
    response: z.array(
      z.object({
        label: z.string(),
        status: z.enum(["pass", "warn", "fail"]),
        detail: z.string(),
      }),
    ),
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
    get(): Promise<
      Array<{ label: string; status: "pass" | "warn" | "fail"; detail: string }>
    >;
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
  events: { subscribe(handler: (event: DesktopAppEvent) => void): () => void };
}
