import { randomUUID } from "node:crypto";

import type { ToolApprovalRequest } from "@ableton-agent/tools";

import type {
  ApprovalDecision,
  ApprovalRequest,
  DesktopPreferences,
} from "../contracts.js";

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
  readonly #pending = new Map<string, (approved: boolean) => void>();
  #publish: ((approval: ApprovalRequest) => boolean) | undefined;

  /** Registers the sink that shows approvals; returns false when unusable. */
  public setPublisher(
    publish: (approval: ApprovalRequest) => boolean,
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
    if (!publish(approval)) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.#pending.set(id, resolve);
    });
  }

  /** Resolves a pending approval; false when the id is unknown or stale. */
  public resolve(id: string, decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    pending(decision === "approve");
    return true;
  }

  /** Denies everything still pending, e.g. during shutdown. */
  public denyAll(): void {
    this.resolveAll(false);
  }

  public resolveAll(approved: boolean): void {
    for (const [id, resolve] of [...this.#pending]) {
      this.#pending.delete(id);
      resolve(approved);
    }
  }
}

export class ApprovalPolicyController {
  #policy: DesktopPreferences["approvalPolicy"];

  public constructor(
    policy: DesktopPreferences["approvalPolicy"],
    private readonly approvals: ApprovalCoordinator,
  ) {
    this.#policy = policy;
  }

  public readonly request = (
    request: ToolApprovalRequest,
  ): Promise<boolean> => {
    if (this.#policy === "approve-all") return Promise.resolve(true);
    if (this.#policy === "never") return Promise.resolve(false);
    return this.approvals.request(request);
  };

  public readonly askForReads = (): boolean => this.#policy === "always";

  public setPolicy(policy: DesktopPreferences["approvalPolicy"]): void {
    this.#policy = policy;
    if (policy === "approve-all") this.approvals.resolveAll(true);
    if (policy === "never") this.approvals.resolveAll(false);
  }
}
