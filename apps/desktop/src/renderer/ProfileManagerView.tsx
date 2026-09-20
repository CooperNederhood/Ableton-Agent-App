import { useEffect, useMemo, useState } from "react";

import type {
  DesktopArtifactConflict,
  DesktopArtifactLocation,
  DesktopArtifactMutationResult,
  DesktopArtifactScope,
  DesktopProfileManagerSnapshot,
  DesktopScopedArtifact,
} from "../contracts";

type PendingConflict = {
  operation: "copy" | "move";
  artifact: DesktopScopedArtifact;
  destination: DesktopArtifactScope;
  conflict: DesktopArtifactConflict;
};

const scopes = ["system", "profile", "session"] as const;

function scopeLabel(
  scope: DesktopArtifactScope | DesktopScopedArtifact["origin"],
): string {
  if (scope === "bundled") return "Bundled";
  if (scope === "system") return "System";
  if (scope === "profile") return "Profile";
  return "Session";
}

function destinationLocation(
  scope: DesktopArtifactLocation["scope"],
  snapshot: DesktopProfileManagerSnapshot,
  selectedSessionId?: string,
): DesktopArtifactLocation {
  if (scope === "bundled" || scope === "system") return { scope };
  if (scope === "profile") {
    return { scope, profile: snapshot.selectedProfile };
  }
  if (selectedSessionId === undefined) {
    throw new Error("Select a session before using Session Scope");
  }
  return {
    scope,
    profile: snapshot.selectedProfile,
    sessionId: selectedSessionId,
  };
}

function artifactLocation(
  artifact: DesktopScopedArtifact,
): DesktopArtifactLocation {
  if (artifact.origin === "bundled" || artifact.origin === "system") {
    return { scope: artifact.origin };
  }
  if (artifact.origin === "profile") {
    if (artifact.profile === undefined) {
      throw new Error("Profile artifact is missing its profile");
    }
    return { scope: "profile", profile: artifact.profile };
  }
  if (artifact.profile === undefined || artifact.sessionId === undefined) {
    throw new Error("Session artifact is missing its session");
  }
  return {
    scope: "session",
    profile: artifact.profile,
    sessionId: artifact.sessionId,
  };
}

function ownedLocation(
  artifact: DesktopScopedArtifact,
): DesktopArtifactLocation {
  if (artifact.scope === "system") return { scope: "system" };
  if (artifact.profile === undefined) {
    throw new Error("Scoped artifact is missing its profile");
  }
  if (artifact.scope === "profile") {
    return { scope: "profile", profile: artifact.profile };
  }
  if (artifact.sessionId === undefined) {
    throw new Error("Session artifact is missing its session");
  }
  return {
    scope: "session",
    profile: artifact.profile,
    sessionId: artifact.sessionId,
  };
}

function artifactStatus(artifact: DesktopScopedArtifact): string {
  if (artifact.state === "disabled") return "Disabled";
  if (artifact.origin === "bundled") return "Bundled baseline";
  if (artifact.state === "overridden") return "Local override";
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

function ArtifactGroups({
  artifacts,
  selectedArtifact,
  onSelect,
}: {
  artifacts: DesktopScopedArtifact[];
  selectedArtifact: DesktopScopedArtifact | undefined;
  onSelect: (artifact: DesktopScopedArtifact) => void;
}): React.JSX.Element {
  return (
    <div className="profile-tree-artifacts">
      {(["agent", "skill"] as const).map((kind) => {
        const entries = artifacts.filter((artifact) => artifact.kind === kind);
        return (
          <section className="profile-tree-artifact-group" key={kind}>
            <header>
              <h3>{kind === "agent" ? "Agents" : "Skills"}</h3>
              <span>{entries.length}</span>
            </header>
            {entries.length === 0 ? (
              <p className="muted">None defined at this level.</p>
            ) : (
              <ul className="artifact-list">
                {entries.map((artifact) => (
                  <li key={artifactNodeKey(artifact)}>
                    <button
                      type="button"
                      className={
                        selectedArtifact !== undefined &&
                        artifactNodeKey(selectedArtifact) ===
                          artifactNodeKey(artifact)
                          ? "selected"
                          : ""
                      }
                      onClick={() => onSelect(artifact)}
                    >
                      <span>
                        <strong>{artifact.name}</strong>
                        <small>{artifact.description}</small>
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
                ))}
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
}: {
  activeSessionId?: string;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopProfileManagerSnapshot>();
  const [selectedArtifact, setSelectedArtifact] =
    useState<DesktopScopedArtifact>();
  const [destination, setDestination] =
    useState<DesktopArtifactScope>("profile");
  const [profileName, setProfileName] = useState("");
  const [artifactName, setArtifactName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingConflict, setPendingConflict] = useState<PendingConflict>();
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState(false);
  const [confirmDeleteArtifact, setConfirmDeleteArtifact] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string>();

  const load = async (selectedProfile?: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const next = await window.desktop.profiles.get(selectedProfile);
      setSnapshot(next);
      setSelectedArtifact(undefined);
      setSelectedSessionId(
        next.profiles
          .find(({ name }) => name === next.selectedProfile)
          ?.sessions.find(({ active }) => active)?.id,
      );
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
          {error || "Loading scoped agents and skills…"}
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
  ): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await operation());
      setSelectedArtifact(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (
    operation: "copy" | "move",
    artifact: DesktopScopedArtifact,
    target: DesktopArtifactScope,
    conflictResolution?: "replace" | "rename",
    renamedName?: string,
  ): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const request = {
        kind: artifact.kind,
        name: artifact.name,
        source: artifactLocation(artifact),
        destination: destinationLocation(target, snapshot, selectedSessionId),
        expectedRevision: snapshot.revision,
        ...(conflictResolution === undefined ? {} : { conflictResolution }),
        ...(renamedName === undefined ? {} : { renamedName }),
      };
      const result: DesktopArtifactMutationResult =
        operation === "copy"
          ? await window.desktop.profiles.copyArtifact(request)
          : await window.desktop.profiles.moveArtifact(request);
      if (result.status === "conflict") {
        setPendingConflict({
          operation,
          artifact,
          destination: target,
          conflict: result.conflict,
        });
      } else {
        setSnapshot(result.snapshot);
        setSelectedArtifact(undefined);
        setPendingConflict(undefined);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  const selectedProfile = snapshot.profiles.find(
    ({ name }) => name === snapshot.selectedProfile,
  );
  const canSwitch =
    selectedProfile?.active === false &&
    snapshot.activeSessionId === undefined &&
    snapshot.switchingDisabledReason === undefined;
  const toggleNode = (node: string): void => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  };
  const selectArtifact = (artifact: DesktopScopedArtifact): void => {
    setSelectedArtifact(artifact);
    setArtifactName(artifact.name);
    if (artifact.sessionId !== undefined) {
      setSelectedSessionId(artifact.sessionId);
    }
  };

  return (
    <section className="panel profile-manager" aria-labelledby="profiles-title">
      <div className="profile-manager-heading">
        <div>
          <h1 id="profiles-title">Profiles</h1>
          <p className="muted">
            Agents and skills resolve from Session, Profile, System, then the
            bundled fallback.
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>

      {error !== "" && <p className="status-error">{error}</p>}
      {snapshot.switchingDisabledReason !== undefined && (
        <p className="profile-manager-notice">
          {snapshot.switchingDisabledReason}
        </p>
      )}

      <div className="profile-controls">
        <div className="selected-profile-summary">
          <span>Selected profile</span>
          <strong>{snapshot.selectedProfile}</strong>
          {selectedProfile?.active === true && <small>Active</small>}
        </div>
        <label>
          Profile name
          <input
            value={profileName}
            maxLength={64}
            placeholder="ambient"
            onChange={(event) => setProfileName(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || profileName.trim() === ""}
          onClick={() =>
            void commit(() =>
              window.desktop.profiles.create(
                profileName.trim(),
                snapshot.revision,
              ),
            ).then(() => setProfileName(""))
          }
        >
          Create
        </button>
        <button
          type="button"
          disabled={
            busy ||
            selectedProfile?.active === true ||
            selectedProfile?.reserved === true ||
            profileName.trim() === ""
          }
          onClick={() =>
            void commit(() =>
              window.desktop.profiles.rename(
                snapshot.selectedProfile,
                profileName.trim(),
                snapshot.revision,
              ),
            ).then(() => setProfileName(""))
          }
        >
          Rename
        </button>
        <button
          type="button"
          disabled={busy || !canSwitch}
          onClick={() =>
            void window.desktop.profiles
              .switch(snapshot.selectedProfile, snapshot.revision)
              .catch((caught: unknown) =>
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Profile switch failed",
                ),
              )
          }
        >
          Switch
        </button>
        <button
          type="button"
          disabled={
            busy ||
            selectedProfile?.active === true ||
            selectedProfile?.reserved === true
          }
          onClick={() => setConfirmDeleteProfile(true)}
        >
          Delete
        </button>
        <button
          type="button"
          disabled={busy || snapshot.activeSessionId === undefined}
          onClick={() =>
            void window.desktop.agent
              .closeSession()
              .then(() => load(snapshot.selectedProfile))
              .catch((caught: unknown) =>
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Session could not be closed",
                ),
              )
          }
        >
          Close active session
        </button>
      </div>

      <div className="profile-tree" aria-label="Profile scope hierarchy">
        <section className="profile-tree-node system-node">
          <header className="profile-tree-row">
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
            <div>
              <h2>System</h2>
              <small>Shared by every profile and session</small>
            </div>
            <span className="profile-tree-count">
              {systemArtifacts.length} defined
            </span>
          </header>
          {expandedNodes.has("system") && (
            <ArtifactGroups
              artifacts={systemArtifacts}
              selectedArtifact={selectedArtifact}
              onSelect={selectArtifact}
            />
          )}

          <div className="profile-tree-children">
            {snapshot.profiles
              .filter(({ reserved }) => !reserved)
              .map((profile) => {
                const profileNode = `profile:${profile.name}`;
                const profileExpanded = expandedNodes.has(profileNode);
                const isSelected = profile.name === snapshot.selectedProfile;
                const ownedProfileArtifacts = isSelected
                  ? profileArtifacts
                  : [];
                return (
                  <section
                    className={`profile-tree-node profile-node ${
                      isSelected ? "selected-scope" : ""
                    }`}
                    key={profile.name}
                  >
                    <header className="profile-tree-row">
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
                        <strong>{profile.name}</strong>
                        <small>
                          Profile
                          {profile.active ? " · active" : ""}
                        </small>
                      </button>
                      <span className="profile-tree-count">
                        {profile.sessions.length} session
                        {profile.sessions.length === 1 ? "" : "s"}
                      </span>
                    </header>
                    {profileExpanded && isSelected && (
                      <>
                        <ArtifactGroups
                          artifacts={ownedProfileArtifacts}
                          selectedArtifact={selectedArtifact}
                          onSelect={selectArtifact}
                        />
                        <div className="profile-tree-children">
                          {profile.sessions.length === 0 ? (
                            <p className="profile-tree-empty muted">
                              No sessions in this profile.
                            </p>
                          ) : (
                            profile.sessions.map((session) => {
                              const sessionNode = `session:${profile.name}:${session.id}`;
                              const sessionExpanded =
                                expandedNodes.has(sessionNode);
                              const ownedSessionArtifacts =
                                sessionArtifacts.filter(
                                  (artifact) =>
                                    artifact.sessionId === session.id,
                                );
                              return (
                                <section
                                  className="profile-tree-node session-node"
                                  key={session.id}
                                >
                                  <header className="profile-tree-row">
                                    <button
                                      type="button"
                                      className="profile-tree-toggle"
                                      aria-label={
                                        sessionExpanded
                                          ? `Collapse ${session.title} session`
                                          : `Expand ${session.title} session`
                                      }
                                      aria-expanded={sessionExpanded}
                                      onClick={() => {
                                        toggleNode(sessionNode);
                                        setSelectedSessionId(session.id);
                                      }}
                                    >
                                      {sessionExpanded ? "^" : "v"}
                                    </button>
                                    <button
                                      type="button"
                                      className="profile-tree-label"
                                      onClick={() =>
                                        setSelectedSessionId(session.id)
                                      }
                                    >
                                      <strong>{session.title}</strong>
                                      <small>
                                        Session · {session.id}
                                        {session.active ? " · active" : ""}
                                      </small>
                                    </button>
                                    <span className="profile-tree-count">
                                      {ownedSessionArtifacts.length} defined
                                    </span>
                                  </header>
                                  {sessionExpanded && (
                                    <ArtifactGroups
                                      artifacts={ownedSessionArtifacts}
                                      selectedArtifact={selectedArtifact}
                                      onSelect={selectArtifact}
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

      <fieldset className="artifact-actions" disabled={busy}>
        <legend>Selected artifact</legend>
        {selectedArtifact === undefined ? (
          <p className="muted">
            Select an agent or skill to copy, move, rename, delete, or disable.
          </p>
        ) : (
          <>
            <p>
              <strong>{selectedArtifact.name}</strong>{" "}
              <span className="muted">
                {selectedArtifact.kind} · {artifactStatus(selectedArtifact)}
              </span>
            </p>
            <label>
              Destination
              <select
                value={destination}
                onChange={(event) =>
                  setDestination(event.target.value as DesktopArtifactScope)
                }
              >
                {scopes.map((scope) => (
                  <option
                    key={scope}
                    value={scope}
                    disabled={
                      (scope === "session" &&
                        selectedSessionId === undefined) ||
                      (scope === "system" &&
                        selectedArtifact.origin === "system") ||
                      (scope === "profile" &&
                        selectedArtifact.scope === "profile" &&
                        selectedArtifact.profile ===
                          snapshot.selectedProfile) ||
                      (scope === "session" &&
                        selectedArtifact.scope === "session" &&
                        selectedArtifact.profile === snapshot.selectedProfile &&
                        selectedArtifact.sessionId === selectedSessionId)
                    }
                  >
                    {scopeLabel(scope)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={selectedArtifact.state === "disabled"}
              onClick={() => void mutate("copy", selectedArtifact, destination)}
            >
              Copy
            </button>
            <button
              type="button"
              disabled={
                selectedArtifact.origin === "bundled" ||
                selectedArtifact.state === "disabled"
              }
              onClick={() => void mutate("move", selectedArtifact, destination)}
            >
              Move
            </button>
            <label>
              New name
              <input
                value={artifactName}
                maxLength={128}
                onChange={(event) => setArtifactName(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={
                selectedArtifact.state === "inherited" ||
                selectedArtifact.origin === "bundled" ||
                artifactName.trim() === "" ||
                artifactName.trim() === selectedArtifact.name
              }
              onClick={() =>
                void commit(() =>
                  window.desktop.profiles.renameArtifact({
                    kind: selectedArtifact.kind,
                    name: selectedArtifact.name,
                    newName: artifactName.trim(),
                    location: ownedLocation(selectedArtifact),
                    expectedRevision: snapshot.revision,
                  }),
                )
              }
            >
              Rename
            </button>
            <button
              type="button"
              disabled={
                selectedArtifact.state === "inherited" ||
                selectedArtifact.origin === "bundled"
              }
              onClick={() => setConfirmDeleteArtifact(true)}
            >
              Delete local
            </button>
            <button
              type="button"
              onClick={() =>
                void commit(() =>
                  window.desktop.profiles.setArtifactDisabled({
                    kind: selectedArtifact.kind,
                    name: selectedArtifact.name,
                    location: ownedLocation(selectedArtifact),
                    disabled: selectedArtifact.state !== "disabled",
                    expectedRevision: snapshot.revision,
                  }),
                )
              }
            >
              {selectedArtifact.state === "disabled" ? "Restore" : "Disable"}
            </button>
          </>
        )}
      </fieldset>

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
              destination. Replacing overwrites that local copy; renaming keeps
              both.
            </p>
            <dl>
              <dt>Source</dt>
              <dd>{pendingConflict.conflict.sourceDescription}</dd>
              <dt>Destination</dt>
              <dd>{pendingConflict.conflict.destinationDescription}</dd>
            </dl>
            <div className="profile-conflict-actions">
              <button
                type="button"
                onClick={() =>
                  void mutate(
                    pendingConflict.operation,
                    pendingConflict.artifact,
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
                  void mutate(
                    pendingConflict.operation,
                    pendingConflict.artifact,
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
      {confirmDeleteProfile && (
        <div className="profile-conflict-backdrop" role="presentation">
          <section
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-profile-title"
          >
            <h2 id="delete-profile-title">Delete profile?</h2>
            <p>
              This permanently deletes the{" "}
              <strong>{snapshot.selectedProfile}</strong> profile and all of its
              settings, sessions, history, agents, and skills.
            </p>
            <div className="profile-conflict-actions">
              <button
                type="button"
                onClick={() => setConfirmDeleteProfile(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDeleteProfile(false);
                  void commit(() =>
                    window.desktop.profiles.delete(
                      snapshot.selectedProfile,
                      snapshot.revision,
                    ),
                  );
                }}
              >
                Delete profile
              </button>
            </div>
          </section>
        </div>
      )}
      {confirmDeleteArtifact && selectedArtifact !== undefined && (
        <div className="profile-conflict-backdrop" role="presentation">
          <section
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-artifact-title"
          >
            <h2 id="delete-artifact-title">Delete local artifact?</h2>
            <p>
              Delete the local <strong>{selectedArtifact.name}</strong>{" "}
              {selectedArtifact.kind}. Any inherited definition with the same
              name will become visible again.
            </p>
            <div className="profile-conflict-actions">
              <button
                type="button"
                onClick={() => setConfirmDeleteArtifact(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDeleteArtifact(false);
                  void commit(() =>
                    window.desktop.profiles.deleteArtifact({
                      kind: selectedArtifact.kind,
                      name: selectedArtifact.name,
                      location: ownedLocation(selectedArtifact),
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
