import { randomUUID } from "node:crypto";

import type { ToolApprovalRequest } from "@ableton-agent/tools";

import type {
  ApprovalDecision,
  ApprovalRequest,
  DesktopPreferences,
} from "../contracts.js";

export interface ApprovalAttribution {
  readonly agentInstanceId?: string;
  readonly sdkSessionId?: string;
}

export type AutoApprovedAgentInstanceIds =
  ReadonlySet<string> | (() => ReadonlySet<string>);

interface PendingApproval {
  readonly attribution: ApprovalAttribution;
  readonly resolve: (approved: boolean) => void;
}

/**
 * Maps a shared tool approval request into the desktop approval view model.
 * Risk is derived from tool metadata, never guessed from the tool name.
 */
export function toDesktopApproval(
  id: string,
  request: ToolApprovalRequest,
): ApprovalRequest {
  const risk =
    request.metadata.risk === "reversible"
      ? "medium"
      : request.metadata.risk === "read"
        ? "low"
        : "high";
  return {
    id,
    title: request.metadata.title,
    risk,
    summary: `The agent requested ${request.metadata.title} (${request.metadata.risk}, ${request.metadata.duration} operation).`,
    changes: Object.entries(request.arguments).map(
      ([name, value]) => `${name}: ${JSON.stringify(value) ?? "undefined"}`,
    ),
    destructive: request.metadata.risk === "destructive",
  };
}

/**
 * Bridges the shared approval callback and the desktop approval UI.
 *
 * A request is denied instead of left pending when no renderer is listening or
 * when the service shuts down, so the agent never blocks on a prompt nobody
 * can answer.
 */
export class ApprovalCoordinator {
  readonly #pending = new Map<string, PendingApproval>();
  #publish:
    | ((approval: ApprovalRequest, attribution: ApprovalAttribution) => boolean)
    | undefined;

  /** Registers the sink that shows approvals; returns false when unusable. */
  public setPublisher(
    publish: (
      approval: ApprovalRequest,
      attribution: ApprovalAttribution,
    ) => boolean,
  ): () => void {
    this.#publish = publish;
    return () => {
      if (this.#publish === publish) {
        this.#publish = undefined;
        this.denyAll();
      }
    };
  }

  public get pendingCount(): number {
    return this.#pending.size;
  }

  public request(request: ToolApprovalRequest): Promise<boolean> {
    const publish = this.#publish;
    if (!publish) {
      return Promise.resolve(false);
    }
    const id = randomUUID();
    const approval = toDesktopApproval(id, request);
    const attribution: ApprovalAttribution = {
      ...(request.agentInstanceId === undefined
        ? {}
        : { agentInstanceId: request.agentInstanceId }),
      ...(request.sdkSessionId === undefined
        ? {}
        : { sdkSessionId: request.sdkSessionId }),
    };
    if (!publish(approval, attribution)) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.#pending.set(id, { attribution, resolve });
    });
  }

  /** Resolves a pending approval; false when the id is unknown or stale. */
  public resolve(id: string, decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    pending.resolve(decision === "approve");
    return true;
  }

  /** Approves pending requests attributed to one of the selected agents. */
  public approveForAgentInstanceIds(
    agentInstanceIds: ReadonlySet<string>,
  ): number {
    let resolved = 0;
    for (const [id, pending] of [...this.#pending]) {
      const agentInstanceId = pending.attribution.agentInstanceId;
      if (
        agentInstanceId === undefined ||
        !agentInstanceIds.has(agentInstanceId)
      ) {
        continue;
      }
      this.#pending.delete(id);
      pending.resolve(true);
      resolved += 1;
    }
    return resolved;
  }

  /** Denies everything still pending, e.g. during shutdown. */
  public denyAll(): void {
    this.resolveAll(false);
  }

  public resolveAll(approved: boolean): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.resolve(approved);
    }
  }
}

export class ApprovalPolicyController {
  #policy: DesktopPreferences["approvalPolicy"];
  #autoApprovedAgentInstanceIds: AutoApprovedAgentInstanceIds;

  public constructor(
    policy: DesktopPreferences["approvalPolicy"],
    private readonly approvals: ApprovalCoordinator,
    autoApprovedAgentInstanceIds: AutoApprovedAgentInstanceIds = new Set(),
  ) {
    this.#policy = policy;
    this.#autoApprovedAgentInstanceIds = autoApprovedAgentInstanceIds;
  }

  public readonly request = (
    request: ToolApprovalRequest,
  ): Promise<boolean> => {
    if (this.#policy === "approve-all") return Promise.resolve(true);
    if (this.#policy === "never") return Promise.resolve(false);
    if (
      request.agentInstanceId !== undefined &&
      this.#getAutoApprovedAgentInstanceIds().has(request.agentInstanceId)
    ) {
      return Promise.resolve(true);
    }
    return this.approvals.request(request);
  };

  public readonly askForReads = (): boolean => this.#policy === "always";

  public setPolicy(policy: DesktopPreferences["approvalPolicy"]): void {
    this.#policy = policy;
    if (policy === "approve-all") this.approvals.resolveAll(true);
    if (policy === "never") this.approvals.resolveAll(false);
    if (policy === "always" || policy === "risky") {
      this.#approvePendingOverrides();
    }
  }

  public setAutoApprovedAgentInstanceIds(
    autoApprovedAgentInstanceIds: AutoApprovedAgentInstanceIds,
  ): void {
    const previous = this.#getAutoApprovedAgentInstanceIds();
    this.#autoApprovedAgentInstanceIds = autoApprovedAgentInstanceIds;
    if (this.#policy === "always" || this.#policy === "risky") {
      const added = new Set(
        [...this.#getAutoApprovedAgentInstanceIds()].filter(
          (id) => !previous.has(id),
        ),
      );
      if (added.size > 0) {
        this.approvals.approveForAgentInstanceIds(added);
      }
    }
  }

  #getAutoApprovedAgentInstanceIds(): ReadonlySet<string> {
    return typeof this.#autoApprovedAgentInstanceIds === "function"
      ? this.#autoApprovedAgentInstanceIds()
      : this.#autoApprovedAgentInstanceIds;
  }

  #approvePendingOverrides(): void {
    this.approvals.approveForAgentInstanceIds(
      this.#getAutoApprovedAgentInstanceIds(),
    );
  }
}
