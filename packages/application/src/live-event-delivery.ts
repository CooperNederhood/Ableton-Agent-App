import type {
  AgentEventListener,
  LiveEventOccurrence,
} from "@ableton-agent/agent-config";

export interface PreparedContextProvider {
  getPreparedContext(
    agentInstanceId: string,
    listener?: AgentEventListener,
  ): string;
}

export interface PendingLiveEventContext {
  readonly deliveryId: string;
  readonly agentInstanceId: string;
  readonly listener: AgentEventListener;
  readonly occurrence: LiveEventOccurrence;
  readonly preparedContext?: string;
}

export interface LiveEventContextProvider {
  getPendingLiveEventContexts(
    agentInstanceId: string,
  ): Promise<readonly PendingLiveEventContext[]>;
  markLiveEventContextsDelivered(
    agentInstanceId: string,
    deliveryIds: readonly string[],
  ): Promise<void>;
}

export type LiveEventTurnRequest = PendingLiveEventContext;

export interface LiveEventDeliveryService {
  enqueueLiveEventTurn(request: LiveEventTurnRequest): Promise<string>;
}

export interface LiveEventContextOptions {
  readonly provider?: LiveEventContextProvider;
  readonly maximumContexts?: number;
  readonly maximumContextCharacters?: number;
}

const DEFAULT_MAXIMUM_CONTEXTS = 16;
const DEFAULT_MAXIMUM_CONTEXT_CHARACTERS = 12_000;

function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 14) return value.slice(0, maximum);
  return `${value.slice(0, Math.max(0, maximum - 14))}\n[truncated]`;
}

function formatOccurrence(entry: PendingLiveEventContext): string {
  return [
    ...(entry.listener.messagePrefix === undefined
      ? []
      : [entry.listener.messagePrefix]),
    JSON.stringify(entry.occurrence, undefined, 2),
  ].join("\n");
}

function formatEntry(entry: PendingLiveEventContext): string {
  return [
    formatOccurrence(entry),
    ...(entry.preparedContext === undefined ? [] : [entry.preparedContext]),
  ].join("\n\n");
}

export function constructNextPromptLiveEventContext(
  entries: readonly PendingLiveEventContext[],
  options: LiveEventContextOptions = {},
): {
  readonly additionalContext?: string;
  readonly deliveryIds: readonly string[];
} {
  const maximumContexts = options.maximumContexts ?? DEFAULT_MAXIMUM_CONTEXTS;
  const maximumCharacters =
    options.maximumContextCharacters ?? DEFAULT_MAXIMUM_CONTEXT_CHARACTERS;
  const ordered = [...entries]
    .filter(({ listener }) => listener.responseMode === "next-prompt")
    .sort(
      (left, right) =>
        Date.parse(left.occurrence.observedAt) -
          Date.parse(right.occurrence.observedAt) ||
        left.occurrence.sequence - right.occurrence.sequence ||
        left.listener.id.localeCompare(right.listener.id),
    )
    .slice(-maximumContexts);
  const prefix = [
    '<live-event-context hidden="true">',
    "The following are deterministic Ableton Live observations for this agent, not user-authored requests.",
  ].join("\n\n");
  const suffix = "</live-event-context>";
  const bodyBudget = Math.max(
    0,
    maximumCharacters - prefix.length - suffix.length - 4,
  );
  const included: PendingLiveEventContext[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const entry of ordered) {
    const block = formatEntry(entry);
    const separator = blocks.length === 0 ? 0 : 2;
    if (used + separator + block.length > bodyBudget) {
      if (blocks.length === 0 && bodyBudget > 0) {
        blocks.push(bounded(block, bodyBudget));
        included.push(entry);
      }
      break;
    }
    blocks.push(block);
    included.push(entry);
    used += separator + block.length;
  }
  if (blocks.length === 0) return { deliveryIds: [] };
  return {
    additionalContext: [prefix, ...blocks, suffix].join("\n\n"),
    deliveryIds: included.map(({ deliveryId }) => deliveryId),
  };
}

export function formatAutomaticLiveEventPrompt(
  request: LiveEventTurnRequest,
  options: LiveEventContextOptions = {},
): string {
  const prefix = `<live-event-trigger delivery-id="${request.deliveryId}" occurrence-id="${request.occurrence.occurrenceId}">`;
  const suffix = "</live-event-trigger>";
  const maximum =
    options.maximumContextCharacters ?? DEFAULT_MAXIMUM_CONTEXT_CHARACTERS;
  return [
    prefix,
    bounded(
      formatOccurrence(request),
      Math.max(0, maximum - prefix.length - suffix.length - 2),
    ),
    suffix,
  ].join("\n");
}
