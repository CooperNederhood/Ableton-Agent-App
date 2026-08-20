import type {
  ActiveAgentConfig,
  BoundTrackScope,
} from "@ableton-agent/agent-config";

export type MutationTarget = "read" | "session" | "track" | "tracks";

export interface AbletonToolMutationDescriptor {
  readonly name: string;
  readonly mutationTarget: MutationTarget;
}

export interface AbletonMutationAgentConfig {
  readonly resolvedTools: readonly string[];
  readonly editScope: readonly ActiveAgentConfig["editScope"][number][];
}

export type AbletonEditScopeBinding = BoundTrackScope;

export interface AbletonMutationAuthorizationContext {
  readonly activeAgentConfig: AbletonMutationAgentConfig;
  readonly editScopeBindings: readonly AbletonEditScopeBinding[];
}

export interface AbletonToolInvocation {
  readonly toolName: string;
  readonly args: unknown;
}

export type AbletonMutationAuthorizationCode =
  | "unknown_tool"
  | "tool_not_allowed"
  | "session_scope_required"
  | "track_scope_required"
  | "track_reference_missing"
  | "binding_missing"
  | "binding_ambiguous"
  | "binding_stale"
  | "binding_cross_project"
  | "scope_changed";

export class AbletonMutationAuthorizationError extends Error {
  public readonly code: AbletonMutationAuthorizationCode;
  public readonly retryable = false;

  public constructor(code: AbletonMutationAuthorizationCode, message: string) {
    super(message);
    this.name = "AbletonMutationAuthorizationError";
    this.code = code;
  }
}

export interface AbletonSessionMutationLockScope {
  readonly kind: "session";
}

export interface AbletonTrackMutationLockScope {
  readonly kind: "tracks";
  readonly trackReferences: readonly string[];
}

export type AbletonMutationLockScope =
  AbletonSessionMutationLockScope | AbletonTrackMutationLockScope;

export interface AbletonMutationLockHandle {
  readonly scope: AbletonMutationLockScope;
  release(): void;
}

interface PendingMutationLockRequest {
  readonly scope: AbletonMutationLockScope;
  readonly resolve: (handle: AbletonMutationLockHandle) => void;
}

export interface AbletonMutationAllowResult {
  readonly kind: "allow";
  readonly toolName: string;
  readonly mutationTarget: MutationTarget;
  readonly trackReferences: readonly string[];
  readonly lockScope: AbletonMutationLockScope | undefined;
}

export interface AbletonMutationDenyResult {
  readonly kind: "deny";
  readonly code: AbletonMutationAuthorizationCode;
  readonly message: string;
}

export type AbletonMutationAuthorizationResult =
  AbletonMutationAllowResult | AbletonMutationDenyResult;

export interface AbletonMutationAuthorizer {
  resolveMutationTarget(toolName: string): MutationTarget | undefined;
  authorize(
    context: AbletonMutationAuthorizationContext,
    invocation: AbletonToolInvocation,
  ): AbletonMutationAuthorizationResult;
}

export interface RunAuthorizedMutationOptions<T> {
  readonly authorizer: AbletonMutationAuthorizer;
  readonly lockManager: AbletonMutationLockManager;
  readonly getContext: () => Promise<AbletonMutationAuthorizationContext>;
  readonly invocation: AbletonToolInvocation;
  readonly handler: () => Promise<T>;
}

const abletonTrackReferenceArgumentsByToolName: Record<
  string,
  readonly string[]
> = {
  ableton_tracks_delete: ["expectedReference"],
  ableton_tracks_rename: ["expectedReference"],
  ableton_tracks_set_mixer: ["expectedReference"],
  ableton_clips_create_midi: ["expectedReference"],
  ableton_clips_replace_notes: ["expectedReference"],
  ableton_clips_launch: ["expectedReference"],
  ableton_clips_duplicate: [
    "expectedReference",
    "expectedDestinationTrackReference",
  ],
  ableton_clips_delete: ["expectedReference"],
  ableton_clips_set_properties: ["expectedReference"],
  ableton_arrangement_create_midi_clip: ["expectedReference"],
  ableton_arrangement_delete_clip: ["expectedReference"],
  ableton_arrangement_replace_notes: ["expectedReference"],
  ableton_arrangement_duplicate_clip: ["expectedReference"],
  ableton_arrangement_set_clip_properties: ["expectedReference"],
  ableton_device_set_enabled: ["expectedReference"],
  ableton_device_set_parameter: ["expectedReference"],
  ableton_browser_load_item: ["expectedReference"],
} as const satisfies Record<string, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSessionScope(
  editScope: AbletonMutationAgentConfig["editScope"],
): boolean {
  return editScope.some((entry) => entry === "session");
}

function normalizeTrackReferences(
  trackReferences: readonly string[],
): readonly string[] {
  return [...new Set(trackReferences)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function resolveTrackReferences(
  toolName: string,
  args: unknown,
): readonly string[] | undefined {
  const fields = abletonTrackReferenceArgumentsByToolName[toolName];
  if (fields === undefined) return undefined;
  if (!isRecord(args)) return undefined;
  const trackReferences: string[] = [];
  for (const field of fields) {
    const value = args[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return undefined;
    }
    trackReferences.push(value);
  }
  if (trackReferences.length === 0) return undefined;
  return normalizeTrackReferences(trackReferences);
}

function deny(
  code: AbletonMutationAuthorizationCode,
  message: string,
): AbletonMutationDenyResult {
  return { kind: "deny", code, message };
}

function allow(
  toolName: string,
  mutationTarget: MutationTarget,
  trackReferences: readonly string[],
  lockScope: AbletonMutationLockScope | undefined,
): AbletonMutationAllowResult {
  return {
    kind: "allow",
    toolName,
    mutationTarget,
    trackReferences,
    lockScope,
  };
}

function isSameTrackReferences(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((reference, index) => reference === right[index]);
}

function normalizeTrackScope(scope: AbletonTrackMutationLockScope): {
  readonly kind: "tracks";
  readonly trackReferences: readonly string[];
} {
  const trackReferences = normalizeTrackReferences(scope.trackReferences);
  if (trackReferences.length === 0) {
    throw new Error(
      "Track mutation locks require at least one track reference",
    );
  }
  return {
    kind: "tracks",
    trackReferences,
  };
}

export function createAbletonMutationAuthorizer(
  catalog: readonly AbletonToolMutationDescriptor[],
): AbletonMutationAuthorizer {
  const descriptorsByName = new Map(
    catalog.map((descriptor) => [descriptor.name, descriptor] as const),
  );

  return {
    resolveMutationTarget(toolName: string): MutationTarget | undefined {
      return descriptorsByName.get(toolName)?.mutationTarget;
    },

    authorize(
      context: AbletonMutationAuthorizationContext,
      invocation: AbletonToolInvocation,
    ): AbletonMutationAuthorizationResult {
      const descriptor = descriptorsByName.get(invocation.toolName);
      if (descriptor === undefined) {
        return deny(
          "unknown_tool",
          `Unknown Ableton tool: ${invocation.toolName}`,
        );
      }

      if (
        !context.activeAgentConfig.resolvedTools.includes(invocation.toolName)
      ) {
        return deny(
          "tool_not_allowed",
          `Ableton tool ${invocation.toolName} is not present in the agent's resolvedTools allowlist`,
        );
      }

      switch (descriptor.mutationTarget) {
        case "read":
          return allow(invocation.toolName, "read", [], undefined);
        case "session":
          if (!hasSessionScope(context.activeAgentConfig.editScope)) {
            return deny(
              "session_scope_required",
              `Ableton session edit scope is required for ${invocation.toolName}`,
            );
          }
          return allow(invocation.toolName, "session", [], { kind: "session" });
        case "track":
        case "tracks": {
          const trackReferences = resolveTrackReferences(
            invocation.toolName,
            invocation.args,
          );
          if (trackReferences === undefined) {
            return deny(
              "track_reference_missing",
              `Track mutation ${invocation.toolName} requires explicit expected track references`,
            );
          }

          if (!hasSessionScope(context.activeAgentConfig.editScope)) {
            const allowedTrackReferences = new Set(
              context.editScopeBindings.map(
                (binding) => binding.trackReference,
              ),
            );
            const missingTrackReferences = trackReferences.filter(
              (reference) => !allowedTrackReferences.has(reference),
            );
            if (missingTrackReferences.length > 0) {
              return deny(
                "track_scope_required",
                `Track edit scope is required for ${invocation.toolName}; missing ${missingTrackReferences.join(", ")}`,
              );
            }
          }

          return allow(
            invocation.toolName,
            descriptor.mutationTarget,
            trackReferences,
            { kind: "tracks", trackReferences },
          );
        }
      }
    },
  };
}

export class AbletonMutationLockManager {
  readonly #activeTrackReferences = new Set<string>();
  #activeSession = false;
  readonly #pending: PendingMutationLockRequest[] = [];
  #draining = false;

  public async acquire(
    scope: AbletonMutationLockScope,
  ): Promise<AbletonMutationLockHandle> {
    const normalizedScope =
      scope.kind === "session" ? scope : normalizeTrackScope(scope);
    return new Promise<AbletonMutationLockHandle>((resolve) => {
      this.#pending.push({
        scope: normalizedScope,
        resolve,
      });
      this.#drain();
    });
  }

  public async withLock<T>(
    scope: AbletonMutationLockScope,
    callback: () => Promise<T>,
  ): Promise<T> {
    const handle = await this.acquire(scope);
    try {
      return await callback();
    } finally {
      handle.release();
    }
  }

  #canGrantTrackScope(scope: AbletonTrackMutationLockScope): boolean {
    if (this.#activeSession) return false;
    return scope.trackReferences.every(
      (reference) => !this.#activeTrackReferences.has(reference),
    );
  }

  #hasEarlierConflictingTrackRequest(
    index: number,
    scope: AbletonTrackMutationLockScope,
  ): boolean {
    const trackReferences = new Set(scope.trackReferences);
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
      const earlierRequest = this.#pending[earlierIndex];
      if (
        earlierRequest?.scope.kind === "tracks" &&
        earlierRequest.scope.trackReferences.some((reference) =>
          trackReferences.has(reference),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  #createHandle(scope: AbletonMutationLockScope): AbletonMutationLockHandle {
    let released = false;
    return {
      scope,
      release: () => {
        if (released) return;
        released = true;
        if (scope.kind === "session") {
          this.#activeSession = false;
        } else {
          for (const reference of scope.trackReferences) {
            this.#activeTrackReferences.delete(reference);
          }
        }
        this.#drain();
      },
    };
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (true) {
        if (this.#activeSession) return;

        const sessionIndex = this.#pending.findIndex(
          (request) => request.scope.kind === "session",
        );
        if (sessionIndex >= 0 && this.#activeTrackReferences.size === 0) {
          const request = this.#pending.splice(sessionIndex, 1)[0];
          if (request === undefined) return;
          this.#activeSession = true;
          request.resolve(this.#createHandle(request.scope));
          continue;
        }
        let grantedTrackRequest = false;
        const trackRequestLimit =
          sessionIndex >= 0 ? sessionIndex : this.#pending.length;
        for (let index = 0; index < trackRequestLimit;) {
          const request = this.#pending[index];
          if (request === undefined) {
            index += 1;
            continue;
          }
          if (request.scope.kind === "session") break;

          if (
            this.#canGrantTrackScope(request.scope) &&
            !this.#hasEarlierConflictingTrackRequest(index, request.scope)
          ) {
            this.#pending.splice(index, 1);
            for (const reference of request.scope.trackReferences) {
              this.#activeTrackReferences.add(reference);
            }
            request.resolve(this.#createHandle(request.scope));
            grantedTrackRequest = true;
            continue;
          }

          index += 1;
        }

        if (!grantedTrackRequest) return;
      }
    } finally {
      this.#draining = false;
    }
  }
}

export function createAbletonMutationLockManager(): AbletonMutationLockManager {
  return new AbletonMutationLockManager();
}

export async function runAuthorizedAbletonMutation<T>(
  options: RunAuthorizedMutationOptions<T>,
): Promise<T> {
  const initialContext = await options.getContext();
  const initialAuthorization = options.authorizer.authorize(
    initialContext,
    options.invocation,
  );

  if (initialAuthorization.kind === "deny") {
    throw new AbletonMutationAuthorizationError(
      initialAuthorization.code,
      initialAuthorization.message,
    );
  }

  if (initialAuthorization.lockScope === undefined) {
    return options.handler();
  }

  const handle = await options.lockManager.acquire(
    initialAuthorization.lockScope,
  );
  try {
    const refreshedContext = await options.getContext();
    const refreshedAuthorization = options.authorizer.authorize(
      refreshedContext,
      options.invocation,
    );

    if (refreshedAuthorization.kind === "deny") {
      throw new AbletonMutationAuthorizationError(
        "scope_changed",
        refreshedAuthorization.message,
      );
    }

    if (
      refreshedAuthorization.mutationTarget !==
        initialAuthorization.mutationTarget ||
      !isSameTrackReferences(
        refreshedAuthorization.trackReferences,
        initialAuthorization.trackReferences,
      )
    ) {
      throw new AbletonMutationAuthorizationError(
        "scope_changed",
        "Ableton edit scope changed before mutation execution",
      );
    }

    return await options.handler();
  } finally {
    handle.release();
  }
}
