import type { AgentEventListener } from "@ableton-agent/agent-config";
import type { SessionSnapshot } from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";
import type { SessionHooks } from "@github/copilot-sdk";
import {
  BROWSER_IDENTITY_GUIDANCE,
  SESSION_TRANSPORT_GUIDANCE,
  SESSION_SEQUENCE_GUIDANCE,
  abletonToolMetadata,
  parseAbletonToolFailure,
  resolveAbletonOperation,
} from "@ableton-agent/tools";

import {
  constructNextPromptSignalContext,
  type SignalContextOptions,
} from "./signal-delivery.js";
import {
  constructNextPromptLiveEventContext,
  type LiveEventContextOptions,
} from "./live-event-delivery.js";

const NON_RETRYABLE_CODES = new Set([
  "approval_denied",
  "permission_denied",
  "unsupported_capability",
  "stale_reference",
  "ambiguous_reference",
  "invalid_params",
  "applied_indeterminate",
]);
const projectContextTrackLimit = 16;
const projectContextSessionClipLimit = 128;
export const VERIFIED_TOOL_RESULT_GUIDANCE =
  "Use the verified tool result as observed state. Re-inspect before any dependent mutation when the project may have changed.";
export const TRANSPORT_SOURCE_FLAG_GUIDANCE =
  'In Live 11 transport results, backToArrangement=true means Session override is active (Back to Arrangement is lit), not that Arrangement is active. backToArrangement=false clears only the global override; it does not certify per-listener Arrangement eligibility. null is unknown. Before a planned user-requested Arrangement capture with that flag true, restore the source using ableton_transport action "back-to-arrangement" through ordinary approval. This does not authorize repair or retry of a failed capture.';
export const AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE =
  "Automatic Listening Event identity policy: cached-context freshness describes mutable state age, not exact identity validity. When the required track and Session clip are present as one unambiguous exact-reference match, use those references directly with the tool's expected-reference guards. Do not inspect solely because freshness is stale or project revisions differ. Inspect only when a required identity is missing, ambiguous, unresolved, or truncated, or after a guarded tool rejects an identity as stale or ambiguous. Never retry unchanged rejected mutation arguments.";

export function postToolUseGuidance(
  toolName: string,
  operationId?: string,
): string {
  return [
    VERIFIED_TOOL_RESULT_GUIDANCE,
    ...(toolName === "ableton_transport"
      ? [TRANSPORT_SOURCE_FLAG_GUIDANCE]
      : []),
    ...(operationId === "tracks.stop_clips"
      ? [SESSION_TRANSPORT_GUIDANCE]
      : []),
    ...(operationId === "listening.play_session_and_listen"
      ? [SESSION_SEQUENCE_GUIDANCE]
      : []),
    ...(toolName === "ableton_browser" ? [BROWSER_IDENTITY_GUIDANCE] : []),
  ].join("\n");
}

export interface AgentIdentityContext {
  readonly liveSetId: string;
  readonly liveProjectId?: string;
  readonly appSessionId?: string;
}

export function formatAgentIdentityContext(
  context: AgentIdentityContext,
  kind: "initial" | "changed",
): string {
  const heading =
    kind === "initial"
      ? "Current Ableton identity context:"
      : "Ableton identity_changed context (this supersedes the identity in the system message):";
  return [
    heading,
    JSON.stringify({
      type: kind === "initial" ? "identity_initial" : "identity_changed",
      liveSetId: context.liveSetId,
      ...(context.liveProjectId === undefined
        ? {}
        : { liveProjectId: context.liveProjectId }),
      ...(context.appSessionId === undefined
        ? {}
        : { appSessionId: context.appSessionId }),
    }),
    "Live Set and Live Project IDs are owned by Ableton integration. App-session ID is application-owned.",
  ].join("\n");
}

function identityContextKey(context: AgentIdentityContext): string {
  return JSON.stringify(context);
}

export interface AgentPolicyServices {
  sessionContext?: {
    getInventory(): Promise<string>;
  };
  getAbletonStatus(): Promise<ConnectionStatus>;
  /** Retained for tool-service compatibility; prompt hooks never call it. */
  inspectSession?: () => Promise<SessionSnapshot>;
  preparedContext?: {
    getPreparedContext(listener?: AgentEventListener): string;
    activeListener?: () => AgentEventListener | undefined;
  };
  signalContext?: SignalContextOptions;
  liveEventContext?: LiveEventContextOptions;
  promptContextEnabled?: () => boolean;
  mutationBlocked?: () => boolean;
  mutationBlockReason?: () => string | undefined;
  /** Sub-agent definition names whose replies the parent must never see. */
  hiddenResultSubagents?: ReadonlySet<string>;
  identityContext?: {
    readonly initial: AgentIdentityContext | undefined;
    current(): AgentIdentityContext | undefined;
    delivered?(kind: "changed", context: AgentIdentityContext): void;
  };
  /** Memory index text: delivered when it differs from the last delivery. */
  memoryContext?: {
    readonly initial: string | undefined;
    current(): Promise<string | undefined>;
    delivered?(context: string | undefined): void;
  };
}

export function hiddenSubagentResult(agentName: string): string {
  return `The ${agentName} sub-agent finished. Its replies are hidden from you by design; inspect Ableton Live to see what it did.`;
}

function agentIdsFromArgs(toolArgs: unknown): string[] {
  if (typeof toolArgs !== "object" || toolArgs === null) return [];
  const { agent_id: agentId, agent_ids: agentIds } = toolArgs as {
    agent_id?: unknown;
    agent_ids?: unknown;
  };
  const ids: unknown[] = Array.isArray(agentIds) ? agentIds : [];
  return [agentId, ...ids].filter((id): id is string => typeof id === "string");
}

export interface AgentPolicy {
  readonly hooks: SessionHooks;
  blockAttempt(toolName: string, toolArgs: unknown, reason: string): void;
}

function resolveInvocationOperation(toolName: string, toolArgs: unknown) {
  try {
    return resolveAbletonOperation(toolName, toolArgs);
  } catch {
    return undefined;
  }
}

export function browserIntentGuidance(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase();
  const recommendations: string[] = [];
  if (/\b(piano|keys?|keyboard)\b/u.test(normalized)) {
    recommendations.push(
      'Piano request: search roots ["sounds","instruments","packs","user_library"] using "piano"; if weak or truncated, try "grand piano" or "acoustic piano".',
    );
  }
  if (
    /\b(string bass|upright bass|double bass|acoustic bass)\b/u.test(normalized)
  ) {
    recommendations.push(
      'String-bass request: search roots ["sounds","instruments","packs","user_library"] separately using "upright bass"; if weak or truncated, try "double bass" and then "string bass".',
    );
  }
  if (/\b(808|drum kit|drum rack|kit)\b/u.test(normalized)) {
    recommendations.push(
      'Drum/kit request: search roots ["drums","packs","user_library"] with the literal kit term.',
    );
  }
  if (recommendations.length === 0) return undefined;
  return [
    "Ableton Browser intent guidance:",
    ...recommendations,
    "Resolve every distinct requested sound before creating tracks. Inspect truncated/weak results and run a narrower follow-up search instead of loading the first loose match.",
  ].join("\n");
}

export function compactProjectContext(
  status: ConnectionStatus,
  snapshot?: SessionSnapshot,
): string {
  if (status.state !== "connected") {
    return `Ableton connection: ${status.state}. Do not attempt mutations until the connection is healthy.`;
  }
  if (snapshot === undefined) {
    return "Ableton connection: connected. Inspect the session before making Live Set-specific claims.";
  }
  const tracks = snapshot.tracks
    .slice(0, projectContextTrackLimit)
    .map((track) => ({
      index: track.index,
      reference: track.reference,
      name: track.name,
      kind: track.kind,
      muted: track.isMuted,
      soloed: track.isSoloed,
      armed: track.isArmed,
    }));
  const snapshotClips = snapshot.clips ?? [];
  const sessionClips = snapshotClips
    .slice(0, projectContextSessionClipLimit)
    .map((clip) => ({
      reference: clip.reference,
      trackReference: clip.trackReference,
      trackIndex: clip.trackIndex,
      sceneIndex: clip.sceneIndex,
      name: clip.name,
      kind: clip.kind,
    }));
  return [
    "Fresh Ableton Live Set state for this prompt (bounded; use exact object references directly when sufficient):",
    JSON.stringify({
      tempo: snapshot.tempo,
      timeSignature: `${snapshot.timeSignature.numerator}/${snapshot.timeSignature.denominator}`,
      isPlaying: snapshot.isPlaying,
      trackCount: snapshot.trackCount,
      tracks,
      tracksTruncated:
        snapshot.trackCount > tracks.length ||
        snapshot.tracks.length > tracks.length,
      sessionClipCount: snapshotClips.length,
      sessionClips,
      sessionClipsTruncated: snapshotClips.length > sessionClips.length,
    }),
  ].join("\n");
}

export function structuredErrorCode(error: string): string | undefined {
  const structured = parseAbletonToolFailure(error);
  if (structured !== undefined) return structured.code;
  const normalized = error.toLowerCase();
  if (
    normalized.includes("postcondition verification failed") ||
    normalized.includes("applied but could not be fully verified") ||
    normalized.includes('"outcome":"applied_indeterminate"') ||
    normalized.includes('"outcome": "applied_indeterminate"')
  ) {
    return "applied_indeterminate";
  }
  return [...NON_RETRYABLE_CODES].find(
    (code) =>
      normalized.includes(code) ||
      normalized.includes(code.replaceAll("_", " ")),
  );
}

export function retryGuidance(error: string): string {
  const structured = parseAbletonToolFailure(error);
  const code = structuredErrorCode(error);
  switch (code) {
    case "stale_reference":
    case "ambiguous_reference":
      return "Do not retry the same mutation arguments. Re-inspect the target, obtain a fresh exact reference, and ask the user when ambiguity remains.";
    case "unsupported_capability":
      return "Do not retry this tool. Explain that the connected Live/Remote Script capability is unsupported and offer a supported alternative.";
    case "approval_denied":
    case "permission_denied":
      return "Do not retry or rephrase the same operation to bypass the denial. Acknowledge the decision and wait for a new user request.";
    case "invalid_params":
      return "Do not retry unchanged arguments. Correct them from inspected state or ask for missing intent.";
    case "applied_indeterminate":
      return "The mutation may already have changed Ableton. Do not retry it. Re-inspect the relevant project state, report the verified result, and only continue from that fresh state.";
    default:
      if (structured?.retryable === false) {
        return `Do not retry unchanged arguments. The tool reported ${structured.code}: ${structured.message}`;
      }
      return "Retry at most once only when the failure is explicitly retryable. Otherwise report the failure and preserve the observed state.";
  }
}

function attemptKey(toolName: string, toolArgs: unknown): string {
  try {
    return `${toolName}:${JSON.stringify(toolArgs)}`;
  } catch {
    return toolName;
  }
}

export function createAgentPolicy(services: AgentPolicyServices): AgentPolicy {
  const blockedAttempts = new Map<string, string>();
  const hiddenResultSubagents = services.hiddenResultSubagents ?? new Set();
  /** Running or finished sub-agent IDs mapped to their hidden definition name. */
  const hiddenSubagentIds = new Map<string, string>();

  function hiddenToolResult(
    toolName: string,
    toolArgs: unknown,
  ): string | undefined {
    if (toolName === "task") {
      const { agent_type: agentType, mode } = (toolArgs ?? {}) as {
        agent_type?: unknown;
        mode?: unknown;
      };
      // Background starts only return the agent ID the parent needs to follow up.
      return typeof agentType === "string" &&
        hiddenResultSubagents.has(agentType) &&
        mode !== "background"
        ? hiddenSubagentResult(agentType)
        : undefined;
    }
    if (toolName !== "read_agent" && toolName !== "write_agent") {
      return undefined;
    }
    const name = agentIdsFromArgs(toolArgs)
      .map((id) => hiddenSubagentIds.get(id))
      .find((value) => value !== undefined);
    return name === undefined ? undefined : hiddenSubagentResult(name);
  }
  let deliveredIdentityKey =
    services.identityContext?.initial === undefined
      ? undefined
      : identityContextKey(services.identityContext.initial);

  function changedIdentityContext(): string | undefined {
    const current = services.identityContext?.current();
    if (current === undefined) return undefined;
    const key = identityContextKey(current);
    if (key === deliveredIdentityKey) return undefined;
    deliveredIdentityKey = key;
    services.identityContext?.delivered?.("changed", current);
    return formatAgentIdentityContext(current, "changed");
  }

  let deliveredMemory = services.memoryContext?.initial;
  async function changedMemoryContext(): Promise<string | undefined> {
    if (services.memoryContext === undefined) return undefined;
    const current = await services.memoryContext.current();
    if (current === deliveredMemory) return undefined;
    deliveredMemory = current;
    services.memoryContext.delivered?.(current);
    return current === undefined
      ? "<memory_index>\nAll reviewed memory was removed; ignore earlier memory indexes.\n</memory_index>"
      : `Memory changed since the last index you saw; this replaces it.\n${current}`;
  }

  async function context(): Promise<string> {
    const listener = services.preparedContext?.activeListener?.();
    if (services.preparedContext !== undefined) {
      const prepared = services.preparedContext.getPreparedContext(listener);
      return listener === undefined
        ? prepared
        : [prepared, AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE].join("\n\n");
    }
    return compactProjectContext(await services.getAbletonStatus());
  }

  const hooks: SessionHooks = {
    onSessionStart: async () => ({
      additionalContext:
        services.preparedContext === undefined
          ? await context()
          : "Ableton project context is supplied per prompt from the prepared context store so it can match the active agent and Listening Event binding.",
    }),
    onUserPromptSubmitted: async (input) => ({
      additionalContext: await (async () => {
        const parts = [
          changedIdentityContext(),
          await changedMemoryContext(),
          await context(),
          services.sessionContext === undefined ||
          !(services.promptContextEnabled?.() ?? true)
            ? undefined
            : (await services.sessionContext.getInventory()).slice(0, 16_384),
          browserIntentGuidance(input.prompt),
        ];
        const signalOptions = services.signalContext;
        if (
          signalOptions?.provider !== undefined &&
          (services.promptContextEnabled?.() ?? true)
        ) {
          const pending = await signalOptions.provider.getPendingContexts(
            input.sessionId,
          );
          const constructed = constructNextPromptSignalContext(
            pending,
            signalOptions,
          );
          if (constructed.additionalContext !== undefined) {
            parts.push(constructed.additionalContext);
            await signalOptions.provider.markDelivered(
              input.sessionId,
              constructed.deliveryIds,
            );
          }
        }
        const liveEventOptions = services.liveEventContext;
        if (
          liveEventOptions?.provider !== undefined &&
          (services.promptContextEnabled?.() ?? true)
        ) {
          const pending =
            await liveEventOptions.provider.getPendingLiveEventContexts(
              input.sessionId,
            );
          const constructed = constructNextPromptLiveEventContext(
            pending,
            liveEventOptions,
          );
          if (constructed.additionalContext !== undefined) {
            parts.push(constructed.additionalContext);
            await liveEventOptions.provider.markLiveEventContextsDelivered(
              input.sessionId,
              constructed.deliveryIds,
            );
          }
        }
        return parts
          .filter((value): value is string => value !== undefined)
          .join("\n\n");
      })(),
    }),
    onSubagentStart: async (input) => {
      if (
        input.agentId !== undefined &&
        hiddenResultSubagents.has(input.agentName)
      ) {
        hiddenSubagentIds.set(input.agentId, input.agentName);
      }
      const identity = services.identityContext?.current();
      return {
        additionalContext: [
          identity === undefined
            ? undefined
            : formatAgentIdentityContext(identity, "initial"),
          await context(),
        ]
          .filter((value): value is string => value !== undefined)
          .join("\n\n"),
      };
    },
    onSubagentStop: (input) => {
      if (!hiddenResultSubagents.has(input.agentName)) return;
      if (input.agentId !== undefined) {
        hiddenSubagentIds.set(input.agentId, input.agentName);
      }
      return { modifiedResponse: hiddenSubagentResult(input.agentName) };
    },
    onPreToolUse: (input) => {
      const operation = resolveInvocationOperation(
        input.toolName,
        input.toolArgs,
      );
      if (
        services.mutationBlocked?.() &&
        operation !== undefined &&
        operation.metadata.risk !== "read"
      ) {
        const reason =
          services.mutationBlockReason?.() ??
          "This turn may inspect Ableton but cannot use mutation tools.";
        return {
          permissionDecision: "deny",
          permissionDecisionReason: reason,
          additionalContext: reason,
        };
      }
      const reason = blockedAttempts.get(
        attemptKey(input.toolName, input.toolArgs),
      );
      if (reason === undefined) return;
      return {
        permissionDecision: "deny",
        permissionDecisionReason: reason,
        additionalContext: reason,
      };
    },
    onPostToolUse: (input) => {
      const hidden = hiddenToolResult(input.toolName, input.toolArgs);
      if (hidden !== undefined) {
        return {
          modifiedResult: { textResultForLlm: hidden, resultType: "success" },
        };
      }
      if (!abletonToolMetadata.some(({ name }) => name === input.toolName)) {
        return;
      }
      blockedAttempts.delete(attemptKey(input.toolName, input.toolArgs));
      const operationId = resolveInvocationOperation(
        input.toolName,
        input.toolArgs,
      )?.metadata.operationId;
      return {
        additionalContext: postToolUseGuidance(input.toolName, operationId),
      };
    },
    onPostToolUseFailure: (input) => {
      if (!abletonToolMetadata.some(({ name }) => name === input.toolName)) {
        return;
      }
      const guidance = retryGuidance(input.error);
      const structured = parseAbletonToolFailure(input.error);
      if (
        structured?.retryable === false ||
        (structured === undefined &&
          structuredErrorCode(input.error) !== undefined)
      ) {
        blockedAttempts.set(
          attemptKey(input.toolName, input.toolArgs),
          guidance,
        );
      }
      return { additionalContext: guidance };
    },
  };
  return {
    hooks,
    blockAttempt: (toolName, toolArgs, reason) => {
      blockedAttempts.set(attemptKey(toolName, toolArgs), reason);
    },
  };
}

export function createAgentHooks(services: AgentPolicyServices): SessionHooks {
  return createAgentPolicy(services).hooks;
}
