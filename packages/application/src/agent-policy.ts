import type { AgentEventListener } from "@ableton-agent/agent-config";
import type { SessionSnapshot } from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";
import type { SessionHooks } from "@github/copilot-sdk";
import {
  abletonToolMetadata,
  parseAbletonToolFailure,
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
export const AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE =
  "Automatic Listening Event identity policy: cached-context freshness describes mutable state age, not exact identity validity. When the required track and Session clip are present as one unambiguous exact-reference match, use those references directly with the tool's expected-reference guards. Do not inspect solely because freshness is stale or project revisions differ. Inspect only when a required identity is missing, ambiguous, unresolved, or truncated, or after a guarded tool rejects an identity as stale or ambiguous. Never retry unchanged rejected mutation arguments.";

export interface AgentPolicyServices {
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
}

export interface AgentPolicy {
  readonly hooks: SessionHooks;
  blockAttempt(toolName: string, toolArgs: unknown, reason: string): void;
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
    return `Ableton connection: connected to project ${status.projectId}. Inspect the session before making project-specific claims.`;
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
    "Fresh Ableton project context for this prompt (bounded; use these exact identities directly when sufficient):",
    JSON.stringify({
      projectId: status.projectId,
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
        const parts = [await context(), browserIntentGuidance(input.prompt)];
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
    onPreToolUse: (input) => {
      const metadata = abletonToolMetadata.find(
        ({ name }) => name === input.toolName,
      );
      if (
        services.mutationBlocked?.() &&
        metadata !== undefined &&
        metadata.risk !== "read"
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
      if (!abletonToolMetadata.some(({ name }) => name === input.toolName)) {
        return;
      }
      blockedAttempts.delete(attemptKey(input.toolName, input.toolArgs));
      return {
        additionalContext:
          "Use the verified tool result as observed state. Re-inspect before any dependent mutation when the project may have changed.",
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
