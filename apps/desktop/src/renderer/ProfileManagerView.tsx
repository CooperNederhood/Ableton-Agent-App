import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import type {
  DesktopArtifactConflict,
  DesktopArtifactLocation,
  DesktopArtifactMutationResult,
  DesktopProfileManagerSnapshot,
  DesktopScopedArtifact,
} from "../contracts";

type ArtifactTransfer = {
  operation: "copy" | "move";
  artifact: DesktopScopedArtifact;
  revision: string;
};

type PendingConflict = ArtifactTransfer & {
  destination: DesktopArtifactLocation;
  conflict: DesktopArtifactConflict;
};

type MenuState =
  | {
      kind: "profile";
      x: number;
      y: number;
      profile: DesktopProfileManagerSnapshot["profiles"][number];
    }
  | {
      kind: "artifact";
      x: number;
      y: number;
      artifact: DesktopScopedArtifact;
    }
  | {
      kind: "scope";
      x: number;
      y: number;
      destination: DesktopArtifactLocation;
    };

type RenameTarget =
  | { kind: "profile"; name: string }
  | { kind: "artifact"; artifact: DesktopScopedArtifact };

function artifactLocation(
  artifact: DesktopScopedArtifact,
): DesktopArtifactLocation {
  if (artifact.origin === "bundled" || artifact.origin === "system") {
    return { scope: artifact.origin };
  }
  if (artifact.origin === "profile" && artifact.profile !== undefined) {
    return { scope: "profile", profile: artifact.profile };
  }
  if (artifact.profile !== undefined && artifact.sessionId !== undefined) {
    return {
      scope: "session",
      profile: artifact.profile,
      sessionId: artifact.sessionId,
    };
  }
  throw new Error("Artifact location is incomplete");
}

function ownedLocation(
  artifact: DesktopScopedArtifact,
): DesktopArtifactLocation {
  if (artifact.scope === "system") return { scope: "system" };
  if (artifact.scope === "profile" && artifact.profile !== undefined) {
    return { scope: "profile", profile: artifact.profile };
  }
  if (artifact.profile !== undefined && artifact.sessionId !== undefined) {
    return {
      scope: "session",
      profile: artifact.profile,
      sessionId: artifact.sessionId,
    };
  }
  throw new Error("Artifact ownership is incomplete");
}

function artifactStatus(artifact: DesktopScopedArtifact): string {
  if (artifact.state === "disabled") return "Disabled";
  if (artifact.origin === "bundled") return "Bundled";
  if (artifact.state === "overridden") return "Override";
  return "Local";
}

function artifactNodeKey(artifact: DesktopScopedArtifact): string {
  return [
    artifact.scope,
    artifact.profile ?? "",
    artifact.sessionId ?? "",
    artifact.kind,
    artifact.name,
  ].join(":");
}

function compactSessionId(sessionId: string): string {
  return sessionId.length <= 18
    ? sessionId
    : `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`;
}

function sameLocation(
  left: DesktopArtifactLocation,
  right: DesktopArtifactLocation,
): boolean {
  return (
    left.scope === right.scope &&
    left.profile === right.profile &&
    left.sessionId === right.sessionId
  );
}

function menuCoordinates(element: HTMLElement): { x: number; y: number } {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left + 16, y: bounds.bottom + 4 };
}

function ContextMenu({
  state,
  onClose,
  children,
}: {
  state: MenuState;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [position, setPosition] = useState({ x: state.x, y: state.y });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (menu === null) return;
    const margin = 8;
    setPosition({
      x: Math.max(
        margin,
        Math.min(state.x, window.innerWidth - menu.offsetWidth - margin),
      ),
      y: Math.max(
        margin,
        Math.min(state.y, window.innerHeight - menu.offsetHeight - margin),
      ),
    });
  }, [state.x, state.y]);
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const close = (): void => onClose();
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("blur", close);
      returnFocus.current?.focus();
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="profile-context-menu"
      role="menu"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(current + delta + items.length) % items.length]?.focus();
      }}
    >
      {children}
    </div>
  );
}

function MenuButton({
  children,
  disabled,
  onSelect,
}: {
  children: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

function contextMenuHandler(open: (x: number, y: number) => void): {
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
  return {
    onContextMenu: (event) => {
      event.preventDefault();
      open(event.clientX, event.clientY);
    },
    onKeyDown: (event) => {
      if (
        event.key !== "ContextMenu" &&
        !(event.shiftKey && event.key === "F10")
      )
        return;
      event.preventDefault();
      const { x, y } = menuCoordinates(event.currentTarget);
      open(x, y);
    },
  };
}

function ArtifactGroups({
  artifacts,
  clipboard,
  onOpenMenu,
  onDragStart,
  onDragEnd,
}: {
  artifacts: DesktopScopedArtifact[];
  clipboard: ArtifactTransfer | undefined;
  onOpenMenu: (artifact: DesktopScopedArtifact, x: number, y: number) => void;
  onDragStart: (
    event: DragEvent<HTMLButtonElement>,
    artifact: DesktopScopedArtifact,
  ) => void;
  onDragEnd: () => void;
}): React.JSX.Element {
  return (
    <div className="profile-tree-artifacts">
      {(["agent", "skill"] as const).map((kind) => {
        const entries = artifacts.filter((artifact) => artifact.kind === kind);
        return (
          <section className="profile-tree-artifact-group" key={kind}>
            <header>
              <h3>{kind === "agent" ? "Agents" : "Skills"}</h3>
              <span aria-label={`${entries.length} ${kind}s`}>
                {entries.length}
              </span>
            </header>
            {entries.length === 0 ? (
              <p className="muted">None defined here</p>
            ) : (
              <ul className="artifact-list">
                {entries.map((artifact) => {
                  const cut =
                    clipboard?.operation === "move" &&
                    artifactNodeKey(clipboard.artifact) ===
                      artifactNodeKey(artifact);
                  return (
                    <li key={artifactNodeKey(artifact)}>
                      <button
                        type="button"
                        className={cut ? "artifact-cut" : ""}
                        draggable={artifact.state !== "disabled"}
                        aria-label={`${artifact.name}, ${artifactStatus(artifact)}`}
                        title="Drag to move; hold Option while dragging to copy"
                        {...contextMenuHandler((x, y) =>
                          onOpenMenu(artifact, x, y),
                        )}
                        onDragStart={(event) => onDragStart(event, artifact)}
                        onDragEnd={onDragEnd}
                      >
                        <span>
                          <strong>{artifact.name}</strong>
                          {artifact.description !== "" && (
                            <small>{artifact.description}</small>
                          )}
                        </span>
                        <span className={`artifact-state ${artifact.state}`}>
                          {artifactStatus(artifact)}
                        </span>
                      </button>
                      {artifact.diagnostics.map((diagnostic) => (
                        <small
                          className="status-error"
                          key={`${artifactNodeKey(artifact)}:${diagnostic}`}
                        >
                          {diagnostic}
                        </small>
                      ))}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function ProfileManagerView({
  activeSessionId,
  onProfilesChanged,
}: {
  activeSessionId?: string;
  onProfilesChanged?: () => void;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopProfileManagerSnapshot>();
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => new Set(["system", "profile:default"]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<MenuState>();
  const [createOpen, setCreateOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [deleteProfile, setDeleteProfile] = useState<string>();
  const [deleteArtifact, setDeleteArtifact] = useState<DesktopScopedArtifact>();
  const [switchProfile, setSwitchProfile] = useState<string>();
  const [clipboard, setClipboard] = useState<ArtifactTransfer>();
  const [dragging, setDragging] = useState<ArtifactTransfer>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [pendingConflict, setPendingConflict] = useState<PendingConflict>();

  const load = async (selectedProfile?: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await window.desktop.profiles.get(selectedProfile));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Profile Manager could not be loaded",
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, [activeSessionId]);

  useEffect(() => {
    if (menu === undefined) return;
    const close = (): void => setMenu(undefined);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  const systemArtifacts = useMemo(
    () =>
      (snapshot?.artifacts ?? []).filter(
        (artifact) => artifact.scope === "system",
      ),
    [snapshot],
  );
  const profileArtifacts = useMemo(
    () =>
      (snapshot?.artifacts ?? []).filter(
        (artifact) =>
          artifact.scope === "profile" &&
          artifact.profile === snapshot?.selectedProfile,
      ),
    [snapshot],
  );
  const sessionArtifacts = useMemo(
    () =>
      (snapshot?.artifacts ?? []).filter(
        (artifact) =>
          artifact.scope === "session" &&
          artifact.profile === snapshot?.selectedProfile,
      ),
    [snapshot],
  );

  if (snapshot === undefined) {
    return (
      <section className="panel profile-manager">
        <h1>Profiles</h1>
        <p className={error === "" ? "muted" : "status-error"}>
          {error || "Loading scoped agents and skills..."}
        </p>
        {error !== "" && (
          <button type="button" onClick={() => void load()} disabled={busy}>
            Retry
          </button>
        )}
      </section>
    );
  }

  const commit = async (
    operation: () => Promise<DesktopProfileManagerSnapshot>,
  ): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await operation());
      setMenu(undefined);
      onProfilesChanged?.();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Operation failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const transfer = async (
    value: ArtifactTransfer,
    destination: DesktopArtifactLocation,
    conflictResolution?: "replace" | "rename",
    renamedName?: string,
  ): Promise<void> => {
    if (value.revision !== snapshot.revision) {
      setError("Profiles changed; copy or cut the artifact again");
      return;
    }
    const source = artifactLocation(value.artifact);
    if (sameLocation(source, destination)) {
      setError("Choose a different scope for this artifact");
      return;
    }
    if (value.operation === "move" && value.artifact.origin === "bundled") {
      setError(
        "Bundled artifacts cannot be moved; hold Option while dragging to copy",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const request = {
        kind: value.artifact.kind,
        name: value.artifact.name,
        source,
        destination,
        expectedRevision: snapshot.revision,
        ...(conflictResolution === undefined ? {} : { conflictResolution }),
        ...(renamedName === undefined ? {} : { renamedName }),
      };
      const result: DesktopArtifactMutationResult =
        value.operation === "copy"
          ? await window.desktop.profiles.copyArtifact(request)
          : await window.desktop.profiles.moveArtifact(request);
      if (result.status === "conflict") {
        setPendingConflict({
          ...value,
          destination,
          conflict: result.conflict,
        });
      } else {
        setSnapshot(result.snapshot);
        setPendingConflict(undefined);
        if (value.operation === "move") setClipboard(undefined);
        onProfilesChanged?.();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleNode = (node: string): void => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  };

  const openArtifactMenu = (
    artifact: DesktopScopedArtifact,
    x: number,
    y: number,
  ): void => setMenu({ kind: "artifact", artifact, x, y });

  const beginDrag = (
    event: DragEvent<HTMLButtonElement>,
    artifact: DesktopScopedArtifact,
  ): void => {
    const value: ArtifactTransfer = {
      operation: event.altKey ? "copy" : "move",
      artifact,
      revision: snapshot.revision,
    };
    setDragging(value);
    event.dataTransfer.effectAllowed =
      artifact.origin === "bundled" ? "copy" : "copyMove";
    event.dataTransfer.setData("text/plain", artifact.name);
  };

  const scopeDropHandlers = (
    destination: DesktopArtifactLocation,
    key: string,
  ) => ({
    onDragOver: (event: DragEvent<HTMLElement>): void => {
      if (dragging === undefined) return;
      const operation = event.altKey ? "copy" : "move";
      if (operation === "move" && dragging.artifact.origin === "bundled")
        return;
      if (sameLocation(artifactLocation(dragging.artifact), destination))
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = operation;
      setDropTarget(key);
    },
    onDragLeave: (): void => setDropTarget(undefined),
    onDrop: (event: DragEvent<HTMLElement>): void => {
      event.preventDefault();
      setDropTarget(undefined);
      if (dragging === undefined) return;
      const value = {
        ...dragging,
        operation: event.altKey ? ("copy" as const) : ("move" as const),
      };
      setDragging(undefined);
      void transfer(value, destination);
    },
  });

  const visibleProfiles = snapshot.profiles.filter(({ reserved }) => !reserved);

  return (
    <section className="panel profile-manager" aria-labelledby="profiles-title">
      <div className="profile-manager-heading">
        <div>
          <h1 id="profiles-title">Profiles</h1>
          <p className="muted">System / profile / session</p>
        </div>
        <div className="profile-heading-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Create profile"
            aria-expanded={createOpen}
            onClick={() => {
              setInputValue("");
              setCreateOpen((open) => !open);
            }}
          >
            +
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh profiles"
            onClick={() => void load(snapshot.selectedProfile)}
            disabled={busy}
          >
            R
          </button>
          {createOpen && (
            <form
              className="profile-popover"
              onSubmit={(event) => {
                event.preventDefault();
                const name = inputValue.trim();
                if (name === "") return;
                void commit(() =>
                  window.desktop.profiles.create(name, snapshot.revision),
                ).then((completed) => {
                  if (completed) {
                    setCreateOpen(false);
                    setInputValue("");
                  }
                });
              }}
            >
              <label>
                New profile
                <input
                  autoFocus
                  maxLength={64}
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                />
              </label>
              <button disabled={busy || inputValue.trim() === ""}>
                Create
              </button>
            </form>
          )}
        </div>
      </div>

      {clipboard !== undefined && (
        <div className="profile-clipboard" role="status">
          {clipboard.operation === "copy" ? "Copied" : "Cut"}{" "}
          <strong>{clipboard.artifact.name}</strong>
          <button
            type="button"
            aria-label="Clear artifact clipboard"
            onClick={() => setClipboard(undefined)}
          >
            x
          </button>
        </div>
      )}
      {error !== "" && <p className="status-error">{error}</p>}
      {snapshot.switchingDisabledReason !== undefined && (
        <p className="profile-manager-notice">
          {snapshot.switchingDisabledReason}
        </p>
      )}

      <div className="profile-tree" aria-label="Profile scope hierarchy">
        <section className="profile-tree-node system-node">
          <header
            className={`profile-tree-row ${dropTarget === "system" ? "drop-target" : ""}`}
            tabIndex={0}
            {...contextMenuHandler((x, y) =>
              setMenu({
                kind: "scope",
                destination: { scope: "system" },
                x,
                y,
              }),
            )}
            {...scopeDropHandlers({ scope: "system" }, "system")}
          >
            <button
              type="button"
              className="profile-tree-toggle"
              aria-label={
                expandedNodes.has("system")
                  ? "Collapse System artifacts"
                  : "Expand System artifacts"
              }
              aria-expanded={expandedNodes.has("system")}
              onClick={() => toggleNode("system")}
            >
              {expandedNodes.has("system") ? "^" : "v"}
            </button>
            <div className="profile-tree-label">
              <h2>System</h2>
            </div>
            <span className="profile-tree-count">{systemArtifacts.length}</span>
          </header>
          {expandedNodes.has("system") && (
            <ArtifactGroups
              artifacts={systemArtifacts}
              clipboard={clipboard}
              onOpenMenu={openArtifactMenu}
              onDragStart={beginDrag}
              onDragEnd={() => setDragging(undefined)}
            />
          )}

          <div className="profile-tree-children">
            {visibleProfiles.map((profile) => {
              const profileNode = `profile:${profile.name}`;
              const profileExpanded = expandedNodes.has(profileNode);
              const isSelected = profile.name === snapshot.selectedProfile;
              const profileLocation: DesktopArtifactLocation = {
                scope: "profile",
                profile: profile.name,
              };
              return (
                <section
                  className={`profile-tree-node profile-node ${
                    isSelected ? "selected-scope" : ""
                  }`}
                  key={profile.name}
                >
                  <header
                    className={`profile-tree-row ${
                      dropTarget === profileNode ? "drop-target" : ""
                    }`}
                    tabIndex={0}
                    {...contextMenuHandler((x, y) =>
                      setMenu({ kind: "profile", profile, x, y }),
                    )}
                    {...scopeDropHandlers(profileLocation, profileNode)}
                  >
                    <button
                      type="button"
                      className="profile-tree-toggle"
                      aria-label={
                        profileExpanded
                          ? `Collapse ${profile.name} profile`
                          : `Expand ${profile.name} profile`
                      }
                      aria-expanded={profileExpanded}
                      disabled={busy}
                      onClick={() => {
                        toggleNode(profileNode);
                        if (!isSelected) void load(profile.name);
                      }}
                    >
                      {profileExpanded ? "^" : "v"}
                    </button>
                    <button
                      type="button"
                      className="profile-tree-label"
                      disabled={busy}
                      onClick={() => {
                        if (!isSelected) void load(profile.name);
                      }}
                    >
                      <span className="scope-name">
                        <strong>{profile.name}</strong>
                        {profile.active && (
                          <span
                            className="scope-active-indicator"
                            aria-label="Active profile"
                            title="Active profile"
                          />
                        )}
                      </span>
                    </button>
                    <span className="profile-tree-count">
                      {profile.sessions.length}
                    </span>
                  </header>
                  {profileExpanded && isSelected && (
                    <>
                      <ArtifactGroups
                        artifacts={profileArtifacts}
                        clipboard={clipboard}
                        onOpenMenu={openArtifactMenu}
                        onDragStart={beginDrag}
                        onDragEnd={() => setDragging(undefined)}
                      />
                      <div className="profile-tree-children">
                        {profile.sessions.length === 0 ? (
                          <p className="profile-tree-empty muted">
                            No sessions
                          </p>
                        ) : (
                          profile.sessions.map((session) => {
                            const sessionNode = `session:${profile.name}:${session.id}`;
                            const sessionExpanded =
                              expandedNodes.has(sessionNode);
                            const ownedArtifacts = sessionArtifacts.filter(
                              (artifact) => artifact.sessionId === session.id,
                            );
                            const sessionLocation: DesktopArtifactLocation = {
                              scope: "session",
                              profile: profile.name,
                              sessionId: session.id,
                            };
                            return (
                              <section
                                className="profile-tree-node session-node"
                                key={session.id}
                              >
                                <header
                                  className={`profile-tree-row ${
                                    dropTarget === sessionNode
                                      ? "drop-target"
                                      : ""
                                  }`}
                                  tabIndex={0}
                                  {...contextMenuHandler((x, y) =>
                                    setMenu({
                                      kind: "scope",
                                      destination: sessionLocation,
                                      x,
                                      y,
                                    }),
                                  )}
                                  {...scopeDropHandlers(
                                    sessionLocation,
                                    sessionNode,
                                  )}
                                >
                                  <button
                                    type="button"
                                    className="profile-tree-toggle"
                                    aria-label={
                                      sessionExpanded
                                        ? `Collapse ${session.title} session`
                                        : `Expand ${session.title} session`
                                    }
                                    aria-expanded={sessionExpanded}
                                    onClick={() => toggleNode(sessionNode)}
                                  >
                                    {sessionExpanded ? "^" : "v"}
                                  </button>
                                  <div className="profile-tree-label">
                                    <span className="scope-name">
                                      <strong>{session.title}</strong>
                                      {session.active && (
                                        <span
                                          className="scope-active-indicator"
                                          aria-label="Active session"
                                          title="Active session"
                                        />
                                      )}
                                    </span>
                                    <small title={session.id}>
                                      {compactSessionId(session.id)}
                                    </small>
                                  </div>
                                  <span className="profile-tree-count">
                                    {ownedArtifacts.length}
                                  </span>
                                </header>
                                {sessionExpanded && (
                                  <ArtifactGroups
                                    artifacts={ownedArtifacts}
                                    clipboard={clipboard}
                                    onOpenMenu={openArtifactMenu}
                                    onDragStart={beginDrag}
                                    onDragEnd={() => setDragging(undefined)}
                                  />
                                )}
                              </section>
                            );
                          })
                        )}
                      </div>
                    </>
                  )}
                </section>
              );
            })}
          </div>
        </section>
      </div>

      {menu !== undefined && (
        <ContextMenu state={menu} onClose={() => setMenu(undefined)}>
          {menu.kind === "profile" ? (
            <>
              <MenuButton
                disabled={
                  clipboard === undefined ||
                  clipboard.revision !== snapshot.revision ||
                  sameLocation(
                    clipboard === undefined
                      ? { scope: "profile", profile: menu.profile.name }
                      : artifactLocation(clipboard.artifact),
                    { scope: "profile", profile: menu.profile.name },
                  ) ||
                  (clipboard?.operation === "move" &&
                    clipboard.artifact.origin === "bundled")
                }
                onSelect={() => {
                  const value = clipboard;
                  const destination: DesktopArtifactLocation = {
                    scope: "profile",
                    profile: menu.profile.name,
                  };
                  setMenu(undefined);
                  if (value !== undefined) void transfer(value, destination);
                }}
              >
                Paste
              </MenuButton>
              <MenuButton
                disabled={
                  busy ||
                  menu.profile.active ||
                  snapshot.switchingDisabledReason !== undefined
                }
                onSelect={() => {
                  setMenu(undefined);
                  if (snapshot.activeSessionId !== undefined) {
                    setSwitchProfile(menu.profile.name);
                    return;
                  }
                  setBusy(true);
                  void window.desktop.profiles
                    .status()
                    .then((status) =>
                      window.desktop.profiles.switch(
                        menu.profile.name,
                        status.revision,
                        false,
                      ),
                    )
                    .catch((caught: unknown) =>
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : "Profile switch failed",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Switch
              </MenuButton>
              <MenuButton
                disabled={busy || menu.profile.active || menu.profile.reserved}
                onSelect={() => {
                  setMenu(undefined);
                  setInputValue(menu.profile.name);
                  setRenameTarget({ kind: "profile", name: menu.profile.name });
                }}
              >
                Rename
              </MenuButton>
              <MenuButton
                disabled={
                  busy ||
                  menu.profile.active ||
                  menu.profile.reserved ||
                  visibleProfiles.length <= 1
                }
                onSelect={() => {
                  setMenu(undefined);
                  setDeleteProfile(menu.profile.name);
                }}
              >
                Delete
              </MenuButton>
            </>
          ) : menu.kind === "artifact" ? (
            <>
              <MenuButton
                disabled={menu.artifact.state === "disabled"}
                onSelect={() => {
                  setClipboard({
                    operation: "copy",
                    artifact: menu.artifact,
                    revision: snapshot.revision,
                  });
                  setMenu(undefined);
                }}
              >
                Copy
              </MenuButton>
              <MenuButton
                disabled={
                  menu.artifact.origin === "bundled" ||
                  menu.artifact.state === "disabled"
                }
                onSelect={() => {
                  setClipboard({
                    operation: "move",
                    artifact: menu.artifact,
                    revision: snapshot.revision,
                  });
                  setMenu(undefined);
                }}
              >
                Cut
              </MenuButton>
              <MenuButton
                disabled={
                  menu.artifact.origin === "bundled" ||
                  menu.artifact.state === "inherited" ||
                  menu.artifact.state === "disabled"
                }
                onSelect={() => {
                  setInputValue(menu.artifact.name);
                  setRenameTarget({
                    kind: "artifact",
                    artifact: menu.artifact,
                  });
                  setMenu(undefined);
                }}
              >
                Rename
              </MenuButton>
              <MenuButton
                disabled={
                  menu.artifact.origin === "bundled" ||
                  menu.artifact.state === "inherited"
                }
                onSelect={() => {
                  setDeleteArtifact(menu.artifact);
                  setMenu(undefined);
                }}
              >
                Delete local
              </MenuButton>
              <MenuButton
                onSelect={() => {
                  const artifact = menu.artifact;
                  setMenu(undefined);
                  void commit(() =>
                    window.desktop.profiles.setArtifactDisabled({
                      kind: artifact.kind,
                      name: artifact.name,
                      location: ownedLocation(artifact),
                      disabled: artifact.state !== "disabled",
                      expectedRevision: snapshot.revision,
                    }),
                  );
                }}
              >
                {menu.artifact.state === "disabled" ? "Restore" : "Disable"}
              </MenuButton>
            </>
          ) : (
            <MenuButton
              disabled={
                clipboard === undefined ||
                clipboard.revision !== snapshot.revision ||
                sameLocation(
                  clipboard === undefined
                    ? menu.destination
                    : artifactLocation(clipboard.artifact),
                  menu.destination,
                ) ||
                (clipboard?.operation === "move" &&
                  clipboard.artifact.origin === "bundled")
              }
              onSelect={() => {
                const value = clipboard;
                setMenu(undefined);
                if (value !== undefined) void transfer(value, menu.destination);
              }}
            >
              Paste
            </MenuButton>
          )}
        </ContextMenu>
      )}

      {renameTarget !== undefined && (
        <div className="profile-conflict-backdrop" role="presentation">
          <form
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-scope-title"
            onSubmit={(event) => {
              event.preventDefault();
              const name = inputValue.trim();
              if (name === "") return;
              const target = renameTarget;
              setRenameTarget(undefined);
              if (target.kind === "profile") {
                void commit(() =>
                  window.desktop.profiles.rename(
                    target.name,
                    name,
                    snapshot.revision,
                  ),
                );
              } else {
                void commit(() =>
                  window.desktop.profiles.renameArtifact({
                    kind: target.artifact.kind,
                    name: target.artifact.name,
                    newName: name,
                    location: ownedLocation(target.artifact),
                    expectedRevision: snapshot.revision,
                  }),
                );
              }
            }}
          >
            <h2 id="rename-scope-title">Rename</h2>
            <input
              autoFocus
              maxLength={128}
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
            />
            <div className="profile-conflict-actions">
              <button type="button" onClick={() => setRenameTarget(undefined)}>
                Cancel
              </button>
              <button disabled={inputValue.trim() === ""}>Rename</button>
            </div>
          </form>
        </div>
      )}

      {switchProfile !== undefined && (
        <div className="profile-conflict-backdrop" role="presentation">
          <section
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-profile-title"
          >
            <h2 id="switch-profile-title">Switch profile?</h2>
            <p>
              {snapshot.activeSessionId === undefined
                ? `Switch to ${switchProfile}?`
                : "The active session will be saved and closed, and can be resumed later."}
            </p>
            <div className="profile-conflict-actions">
              <button type="button" onClick={() => setSwitchProfile(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = switchProfile;
                  setSwitchProfile(undefined);
                  setBusy(true);
                  void window.desktop.profiles
                    .status()
                    .then((status) =>
                      window.desktop.profiles.switch(
                        target,
                        status.revision,
                        status.activeSessionId !== undefined,
                      ),
                    )
                    .catch((caught: unknown) =>
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : "Profile switch failed",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Switch
              </button>
            </div>
          </section>
        </div>
      )}

      {pendingConflict !== undefined && (
        <div className="profile-conflict-backdrop" role="presentation">
          <section
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-conflict-title"
          >
            <h2 id="profile-conflict-title">Artifact already exists</h2>
            <p>
              <strong>{pendingConflict.conflict.name}</strong> differs at the
              destination. Replace the local copy or keep both.
            </p>
            <div className="profile-conflict-actions">
              <button
                type="button"
                onClick={() =>
                  void transfer(
                    pendingConflict,
                    pendingConflict.destination,
                    "replace",
                  )
                }
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() =>
                  void transfer(
                    pendingConflict,
                    pendingConflict.destination,
                    "rename",
                    pendingConflict.conflict.suggestedName,
                  )
                }
              >
                Rename to {pendingConflict.conflict.suggestedName}
              </button>
              <button
                type="button"
                onClick={() => setPendingConflict(undefined)}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {deleteProfile !== undefined && (
        <div className="profile-conflict-backdrop" role="presentation">
          <section
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-profile-title"
          >
            <h2 id="delete-profile-title">Delete profile?</h2>
            <p>
              Permanently delete <strong>{deleteProfile}</strong> and its
              settings, sessions, history, agents, and skills.
            </p>
            <div className="profile-conflict-actions">
              <button type="button" onClick={() => setDeleteProfile(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = deleteProfile;
                  setDeleteProfile(undefined);
                  void commit(() =>
                    window.desktop.profiles.delete(target, snapshot.revision),
                  );
                }}
              >
                Delete profile
              </button>
            </div>
          </section>
        </div>
      )}

      {deleteArtifact !== undefined && (
        <div className="profile-conflict-backdrop" role="presentation">
          <section
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-artifact-title"
          >
            <h2 id="delete-artifact-title">Delete local artifact?</h2>
            <p>
              Delete <strong>{deleteArtifact.name}</strong>. An inherited
              definition with the same name will become visible again.
            </p>
            <div className="profile-conflict-actions">
              <button
                type="button"
                onClick={() => setDeleteArtifact(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = deleteArtifact;
                  setDeleteArtifact(undefined);
                  void commit(() =>
                    window.desktop.profiles.deleteArtifact({
                      kind: target.kind,
                      name: target.name,
                      location: ownedLocation(target),
                      expectedRevision: snapshot.revision,
                    }),
                  );
                }}
              >
                Delete artifact
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
