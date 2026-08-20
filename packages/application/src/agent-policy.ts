import type { SessionSnapshot } from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";
import type { SessionHooks } from "@github/copilot-sdk";
import { abletonToolMetadata } from "@ableton-agent/tools";

import {
  constructNextPromptSignalContext,
  type SignalContextOptions,
} from "./signal-delivery.js";

const NON_RETRYABLE_CODES = new Set([
  "approval_denied",
  "permission_denied",
  "unsupported_capability",
  "stale_reference",
  "ambiguous_reference",
  "invalid_params",
  "applied_indeterminate",
]);

export interface AgentPolicyServices {
  getAbletonStatus(): Promise<ConnectionStatus>;
  inspectSession(): Promise<SessionSnapshot>;
  signalContext?: SignalContextOptions;
  promptContextEnabled?: () => boolean;
  mutationBlocked?: () => boolean;
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
  const tracks = snapshot.tracks.slice(0, 16).map((track) => ({
    index: track.index,
    reference: track.reference,
    name: track.name,
    kind: track.kind,
    muted: track.isMuted,
    soloed: track.isSoloed,
    armed: track.isArmed,
  }));
  return [
    "Current Ableton project context (bounded, refresh before mutation):",
    JSON.stringify({
      projectId: status.projectId,
      tempo: snapshot.tempo,
      timeSignature: `${snapshot.timeSignature.numerator}/${snapshot.timeSignature.denominator}`,
      isPlaying: snapshot.isPlaying,
      trackCount: snapshot.trackCount,
      tracks,
      tracksTruncated: snapshot.trackCount > tracks.length,
      sessionClipCount: snapshot.clips?.length ?? 0,
    }),
  ].join("\n");
}

export function structuredErrorCode(error: string): string | undefined {
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
    const status = await services.getAbletonStatus();
    if (status.state !== "connected") return compactProjectContext(status);
    try {
      return compactProjectContext(status, await services.inspectSession());
    } catch {
      return compactProjectContext(status);
    }
  }

  const hooks: SessionHooks = {
    onSessionStart: async () => ({ additionalContext: await context() }),
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
        return parts
          .filter((value): value is string => value !== undefined)
          .join("\n\n");
      })(),
    }),
    onPreToolUse: (input) => {
      const metadata = abletonToolMetadata.find(
        ({ name }) => name === input.toolName,
      );
      if (services.mutationBlocked?.() && metadata?.risk !== "read") {
        const reason =
          "Automatic analysis turns may inspect Ableton but cannot use mutation tools.";
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
      if (structuredErrorCode(input.error) !== undefined) {
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
