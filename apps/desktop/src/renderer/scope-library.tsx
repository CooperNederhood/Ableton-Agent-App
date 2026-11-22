import { useCallback, useEffect, useState, type ReactNode } from "react";

import type {
  DesktopArtifactConflict,
  DesktopArtifactKind,
  DesktopArtifactLocation,
  DesktopArtifactMutationResult,
  DesktopArtifactOrigin,
  DesktopArtifactScope,
  DesktopProfileManagerSnapshot,
  DesktopScopedArtifact,
} from "../contracts";
import { Icon } from "./Icon";
import type { LibraryScope } from "./state";

/** Shared pieces for the Agents, Skills, Memory, and Profiles lists. */

export const LIBRARY_SCOPES: readonly DesktopArtifactScope[] = [
  "system",
  "profile",
  "project",
  "session",
];

export const SCOPE_LABELS: Record<DesktopArtifactScope, string> = {
  system: "System",
  profile: "Profile",
  project: "Project",
  session: "Session",
};

/** Bundled items live in the System rung of the ladder. */
export function libraryScopeOf(
  origin: DesktopArtifactOrigin | undefined,
): DesktopArtifactScope {
  return origin === undefined || origin === "bundled" ? "system" : origin;
}

export function artifactLocation(
  artifact: DesktopScopedArtifact,
): DesktopArtifactLocation {
  if (artifact.origin === "bundled" || artifact.origin === "system") {
    return { scope: artifact.origin };
  }
  if (artifact.origin === "profile" && artifact.profile !== undefined) {
    return { scope: "profile", profile: artifact.profile };
  }
  if (
    artifact.origin === "project" &&
    artifact.profile !== undefined &&
    artifact.liveProjectId !== undefined
  ) {
    return {
      scope: "project",
      profile: artifact.profile,
      liveProjectId: artifact.liveProjectId,
    };
  }
  if (artifact.profile !== undefined && artifact.sessionId !== undefined) {
    return {
      scope: "session",
      profile: artifact.profile,
      ...(artifact.liveProjectId === undefined
        ? {}
        : { liveProjectId: artifact.liveProjectId }),
      ...(artifact.liveSetId === undefined
        ? {}
        : { liveSetId: artifact.liveSetId }),
      sessionId: artifact.sessionId,
    };
  }
  throw new Error("Artifact location is incomplete");
}

export function ownedLocation(
  artifact: DesktopScopedArtifact,
): DesktopArtifactLocation {
  if (artifact.scope === "system") return { scope: "system" };
  if (artifact.scope === "profile" && artifact.profile !== undefined) {
    return { scope: "profile", profile: artifact.profile };
  }
  if (
    artifact.scope === "project" &&
    artifact.profile !== undefined &&
    artifact.liveProjectId !== undefined
  ) {
    return {
      scope: "project",
      profile: artifact.profile,
      liveProjectId: artifact.liveProjectId,
    };
  }
  if (artifact.profile !== undefined && artifact.sessionId !== undefined) {
    return {
      scope: "session",
      profile: artifact.profile,
      ...(artifact.liveProjectId === undefined
        ? {}
        : { liveProjectId: artifact.liveProjectId }),
      ...(artifact.liveSetId === undefined
        ? {}
        : { liveSetId: artifact.liveSetId }),
      sessionId: artifact.sessionId,
    };
  }
  throw new Error("Artifact ownership is incomplete");
}

export function sameLocation(
  left: DesktopArtifactLocation,
  right: DesktopArtifactLocation,
): boolean {
  return (
    left.scope === right.scope &&
    left.profile === right.profile &&
    left.liveProjectId === right.liveProjectId &&
    left.liveSetId === right.liveSetId &&
    left.sessionId === right.sessionId
  );
}

/** Loads the Profile Manager snapshot and reloads it when `refreshToken` changes. */
export function useProfileSnapshot(refreshToken: number): {
  snapshot: DesktopProfileManagerSnapshot | undefined;
  setSnapshot: (snapshot: DesktopProfileManagerSnapshot) => void;
  error: string;
  reload: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<DesktopProfileManagerSnapshot>();
  const [error, setError] = useState("");
  const reload = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await window.desktop.profiles.get());
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Profiles could not load",
      );
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [refreshToken, reload]);
  return { snapshot, setSnapshot, error, reload };
}

export interface ActiveScopeContext {
  profile: string;
  liveProjectId?: string;
  liveProjectName?: string;
  liveSetId?: string;
  sessionId?: string;
}

/** The profile, project, and session the user is working in now. */
export function activeScopeContext(
  snapshot: DesktopProfileManagerSnapshot,
): ActiveScopeContext {
  const session = snapshot.profiles
    .find(({ name }) => name === snapshot.activeProfile)
    ?.sessions.find(({ id }) => id === snapshot.activeSessionId);
  return {
    profile: snapshot.activeProfile,
    ...(session?.liveProjectId === undefined
      ? {}
      : { liveProjectId: session.liveProjectId }),
    ...(session?.liveProjectName === undefined
      ? {}
      : { liveProjectName: session.liveProjectName }),
    ...(session === undefined
      ? {}
      : { liveSetId: session.liveSetId, sessionId: session.id }),
  };
}

/** Where a new or moved item lands for each rung, or undefined when unavailable. */
export function scopeDestination(
  context: ActiveScopeContext,
  scope: DesktopArtifactScope,
): DesktopArtifactLocation | undefined {
  if (scope === "system") return { scope: "system" };
  if (scope === "profile")
    return { scope: "profile", profile: context.profile };
  if (scope === "project") {
    return context.liveProjectId === undefined
      ? undefined
      : {
          scope: "project",
          profile: context.profile,
          liveProjectId: context.liveProjectId,
        };
  }
  return context.sessionId === undefined || context.liveSetId === undefined
    ? undefined
    : {
        scope: "session",
        profile: context.profile,
        ...(context.liveProjectId === undefined
          ? {}
          : { liveProjectId: context.liveProjectId }),
        liveSetId: context.liveSetId,
        sessionId: context.sessionId,
      };
}

/** Items that apply to the active context, one row per scope that holds them. */
export function contextArtifacts(
  snapshot: DesktopProfileManagerSnapshot,
  kind?: DesktopArtifactKind,
): DesktopScopedArtifact[] {
  const context = activeScopeContext(snapshot);
  return snapshot.artifacts.filter((artifact) => {
    if (kind !== undefined && artifact.kind !== kind) return false;
    if (artifact.state === "disabled") return false;
    if (artifact.scope === "system") return true;
    if (artifact.profile !== context.profile) return false;
    if (artifact.scope === "profile") return true;
    if (artifact.scope === "project") {
      return artifact.liveProjectId === context.liveProjectId;
    }
    return artifact.sessionId === context.sessionId;
  });
}

/** The snapshot row for a catalog item, matched by where it is defined. */
export function findContextArtifact(
  snapshot: DesktopProfileManagerSnapshot | undefined,
  kind: DesktopArtifactKind,
  name: string,
  origin: DesktopArtifactOrigin | undefined,
): DesktopScopedArtifact | undefined {
  if (snapshot === undefined) return undefined;
  const scope = libraryScopeOf(origin);
  return contextArtifacts(snapshot, kind).find(
    (artifact) =>
      artifact.name === name &&
      artifact.scope === scope &&
      artifact.origin === (origin ?? "bundled"),
  );
}

export function LibraryBar({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="library-bar">
      <h2 className="library-title">{title}</h2>
      {children}
    </div>
  );
}

export function ScopeFilterBar({
  value,
  counts,
  onChange,
}: {
  value: LibraryScope;
  counts: Partial<Record<DesktopArtifactScope, number>>;
  onChange: (scope: LibraryScope) => void;
}): React.JSX.Element {
  const total = LIBRARY_SCOPES.reduce(
    (sum, scope) => sum + (counts[scope] ?? 0),
    0,
  );
  const options: { scope: LibraryScope; label: string; count: number }[] = [
    { scope: "all", label: "All", count: total },
    ...LIBRARY_SCOPES.map((scope) => ({
      scope,
      label: SCOPE_LABELS[scope],
      count: counts[scope] ?? 0,
    })),
  ];
  return (
    <div className="scope-filter" role="radiogroup" aria-label="Show scope">
      {options.map(({ scope, label, count }) => (
        <button
          key={scope}
          type="button"
          role="radio"
          aria-checked={value === scope}
          className="scope-chip scope-filter-chip"
          data-scope={scope}
          onClick={() => onChange(scope)}
        >
          {label} <span className="tabular">{count}</span>
        </button>
      ))}
    </div>
  );
}

export function ScopeChip({
  origin,
}: {
  origin: DesktopArtifactOrigin | undefined;
}): React.JSX.Element {
  const scope = libraryScopeOf(origin);
  const bundled = origin === undefined || origin === "bundled";
  return (
    <span className="scope-chip" data-scope={scope}>
      {bundled && <Icon name="lock" />}
      {bundled ? "Bundled" : SCOPE_LABELS[scope]}
    </span>
  );
}

/**
 * Duplicate to Profile for bundled items, Move ▾ for everything else. Uses the
 * same copy/move/conflict rules as the Profiles tree.
 */
export function ScopeActions({
  snapshot,
  artifact,
  onSnapshot,
  onChanged,
}: {
  snapshot: DesktopProfileManagerSnapshot;
  artifact: DesktopScopedArtifact;
  onSnapshot: (snapshot: DesktopProfileManagerSnapshot) => void;
  onChanged?: (() => void) | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{
    operation: "copy" | "move";
    destination: DesktopArtifactLocation;
    conflict: DesktopArtifactConflict;
  }>();
  const context = activeScopeContext(snapshot);
  const source = artifactLocation(artifact);
  const bundled = artifact.origin === "bundled";

  const transfer = async (
    operation: "copy" | "move",
    destination: DesktopArtifactLocation,
    conflictResolution?: "replace" | "rename",
    renamedName?: string,
  ): Promise<void> => {
    setBusy(true);
    setError("");
    setOpen(false);
    try {
      const request = {
        kind: artifact.kind,
        name: artifact.name,
        source,
        destination,
        expectedRevision: snapshot.revision,
        ...(conflictResolution === undefined ? {} : { conflictResolution }),
        ...(renamedName === undefined ? {} : { renamedName }),
      };
      const result: DesktopArtifactMutationResult =
        operation === "copy"
          ? await window.desktop.profiles.copyArtifact(request)
          : await window.desktop.profiles.moveArtifact(request);
      if (result.status === "conflict") {
        setConflict({ operation, destination, conflict: result.conflict });
      } else {
        setConflict(undefined);
        onSnapshot(result.snapshot);
        onChanged?.();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Move failed");
    } finally {
      setBusy(false);
    }
  };

  const destinations = LIBRARY_SCOPES.flatMap((scope) => {
    const destination = scopeDestination(context, scope);
    return destination === undefined || sameLocation(source, destination)
      ? []
      : [{ scope, destination }];
  });
  const profileDestination = scopeDestination(context, "profile")!;

  return (
    <div className="scope-actions">
      {bundled ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void transfer("copy", profileDestination)}
        >
          Duplicate to Profile
        </button>
      ) : (
        <div className="menu-anchor">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy || destinations.length === 0}
            onClick={() => setOpen((current) => !current)}
          >
            Move ▾
          </button>
          {open && (
            <div className="scope-menu" role="menu">
              {destinations.map(({ scope, destination }) => (
                <button
                  key={scope}
                  type="button"
                  role="menuitem"
                  onClick={() => void transfer("move", destination)}
                >
                  <span
                    className="scope-dot"
                    data-scope={scope}
                    aria-hidden="true"
                  />
                  Move to {SCOPE_LABELS[scope]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {conflict !== undefined && (
        <div className="notice" role="alert">
          <span>
            {SCOPE_LABELS[libraryScopeOf(conflict.destination.scope)]} already
            has “{artifact.name}”.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void transfer(conflict.operation, conflict.destination, "replace")
            }
          >
            Replace it
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void transfer(
                conflict.operation,
                conflict.destination,
                "rename",
                conflict.conflict.suggestedName,
              )
            }
          >
            Keep both
          </button>
          <button type="button" onClick={() => setConflict(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {error !== "" && (
        <span className="status-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

const LADDER_KINDS: readonly {
  kind: DesktopArtifactKind;
  label: string;
  icon: "agent" | "skill" | "memory";
}[] = [
  { kind: "agent", label: "agents", icon: "agent" },
  { kind: "skill", label: "skills", icon: "skill" },
  { kind: "memory", label: "memory", icon: "memory" },
];

/** Broad to narrow: how many agents, skills, and memory topics each scope holds. */
export function ScopeLadder({
  snapshot,
  onOpen,
}: {
  snapshot: DesktopProfileManagerSnapshot;
  onOpen?:
    | ((kind: DesktopArtifactKind, scope: DesktopArtifactScope) => void)
    | undefined;
}): React.JSX.Element {
  const context = activeScopeContext(snapshot);
  const artifacts = contextArtifacts(snapshot);
  const subtitle: Record<DesktopArtifactScope, string> = {
    system: "Bundled with the app",
    profile: context.profile,
    project: context.liveProjectName ?? "No saved Live project open",
    session: "This conversation",
  };
  return (
    <ol
      className="scope-ladder"
      aria-label="What applies right now, broad to narrow"
    >
      {LIBRARY_SCOPES.map((scope) => (
        <li className="scope-rung" key={scope}>
          <div className="scope-band" data-scope={scope}>
            <strong>{SCOPE_LABELS[scope]}</strong>
            <span title={subtitle[scope]}>{subtitle[scope]}</span>
          </div>
          {LADDER_KINDS.map(({ kind, label, icon }) => {
            const count = artifacts.filter(
              (artifact) => artifact.kind === kind && artifact.scope === scope,
            ).length;
            return (
              <button
                type="button"
                key={kind}
                className={`scope-cell ${count === 0 ? "zero" : ""}`}
                aria-label={`Show ${count} ${SCOPE_LABELS[scope]} ${label}`}
                disabled={onOpen === undefined}
                onClick={() => onOpen?.(kind, scope)}
              >
                <span className="scope-cell-count">{count}</span>
                <span className="scope-cell-kind">
                  <Icon name={icon} />
                  {label}
                </span>
              </button>
            );
          })}
        </li>
      ))}
    </ol>
  );
}
