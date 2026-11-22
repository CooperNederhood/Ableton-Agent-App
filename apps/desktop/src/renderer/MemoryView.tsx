import { useEffect, useState } from "react";

import type {
  DesktopMemoryDocument,
  DesktopScopedArtifact,
} from "../contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
  contextArtifacts,
  ownedLocation,
  ScopeActions,
  ScopeChip,
  ScopeFilterBar,
  useProfileSnapshot,
} from "./scope-library";
import type { LibraryScope } from "./state";

const UPDATE_MEMORY_COMMAND = "/update-memory ";

/** Tiles of remembered topics on the left, the selected topic on the right. */
export function MemoryView({
  libraryScope,
  onLibraryScope,
  onAskAgent,
  onProfilesChanged,
  profileRefreshToken = 0,
}: {
  libraryScope: LibraryScope;
  onLibraryScope: (scope: LibraryScope) => void;
  onAskAgent: (command: string) => void;
  onProfilesChanged?: (() => void) | undefined;
  profileRefreshToken?: number;
}): React.JSX.Element {
  const profiles = useProfileSnapshot(profileRefreshToken);
  const { snapshot } = profiles;
  const memories =
    snapshot === undefined ? [] : contextArtifacts(snapshot, "memory");
  const visible = memories.filter(
    ({ scope }) => libraryScope === "all" || scope === libraryScope,
  );
  const counts: Partial<Record<DesktopScopedArtifact["scope"], number>> = {};
  for (const { scope } of memories) counts[scope] = (counts[scope] ?? 0) + 1;

  const [selectedKey, setSelectedKey] = useState<string>();
  const selected =
    visible.find((memory) => memoryKey(memory) === selectedKey) ?? visible[0];
  const [document, setDocument] = useState<DesktopMemoryDocument>();
  const [readError, setReadError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedLocationKey =
    selected === undefined ? undefined : memoryKey(selected);
  useEffect(() => {
    setDocument(undefined);
    setReadError("");
    setConfirmDelete(false);
    if (selected === undefined) return;
    let cancelled = false;
    void window.desktop.profiles
      .readMemory({ name: selected.name, location: ownedLocation(selected) })
      .then((loaded) => {
        if (!cancelled) setDocument(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReadError(
            error instanceof Error ? error.message : "Memory could not load",
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // The key captures every field of `selected` that the read depends on.
  }, [selectedLocationKey, selected?.fingerprint]);

  const remove = async (memory: DesktopScopedArtifact): Promise<void> => {
    if (snapshot === undefined) return;
    setBusy(true);
    try {
      profiles.setSnapshot(
        await window.desktop.profiles.deleteArtifact({
          kind: "memory",
          name: memory.name,
          location: ownedLocation(memory),
          expectedRevision: snapshot.revision,
        }),
      );
      onProfilesChanged?.();
    } catch (error) {
      setReadError(
        error instanceof Error ? error.message : "Memory could not be deleted",
      );
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <section
      className="agents-view memory-view"
      aria-labelledby="memory-heading"
    >
      <div className="library-bar">
        <h2 className="library-title" id="memory-heading">
          Memory
        </h2>
        <ScopeFilterBar
          value={libraryScope}
          counts={counts}
          onChange={onLibraryScope}
        />
        <span className="spacer" />
        <button type="button" onClick={() => onAskAgent(UPDATE_MEMORY_COMMAND)}>
          Remember something
        </button>
      </div>
      {profiles.error !== "" && (
        <div className="notice" role="alert">
          {profiles.error}
        </div>
      )}
      <div className="agents-workspace memory-workspace">
        <div className="memory-tiles" role="list" aria-label="Memory topics">
          {visible.map((memory) => {
            const key = memoryKey(memory);
            const active =
              selected !== undefined && memoryKey(selected) === key;
            return (
              <button
                key={key}
                type="button"
                role="listitem"
                className={`memory-tile ${active ? "active" : ""}`}
                data-scope={memory.scope}
                aria-current={active ? "true" : undefined}
                onClick={() => setSelectedKey(key)}
              >
                <span className="memory-tile-top" title={memory.name}>
                  {memory.name}
                </span>
                <span className="memory-tile-text">
                  {memory.description || "No summary yet."}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="listitem"
            className="memory-tile new"
            onClick={() => onAskAgent(UPDATE_MEMORY_COMMAND)}
          >
            + Remember something…
          </button>
        </div>
        <div className="agent-detail-workspace">
          {selected === undefined ? (
            <div className="empty-state">
              <strong>Nothing remembered here yet</strong>
              <p>
                Memory is what the agent keeps between sessions, like your
                favorite sounds or this song&apos;s key. Ask it to remember
                something and you&apos;ll review the note before it&apos;s
                saved.
              </p>
            </div>
          ) : (
            <article className="agent-detail">
              <header className="agent-detail-header">
                <div className="agent-title-line">
                  <ScopeChip origin={selected.origin} />
                  <h3>{selected.name}</h3>
                  {snapshot !== undefined && (
                    <ScopeActions
                      snapshot={snapshot}
                      artifact={selected}
                      onSnapshot={profiles.setSnapshot}
                      onChanged={onProfilesChanged}
                    />
                  )}
                </div>
                <div className="agent-header-actions">
                  <button
                    type="button"
                    onClick={() =>
                      onAskAgent(
                        `${UPDATE_MEMORY_COMMAND}Update the ${selected.name} memory: `,
                      )
                    }
                  >
                    Edit in chat
                  </button>
                  {selected.origin !== "bundled" &&
                    (confirmDelete ? (
                      <>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() => void remove(selected)}
                        >
                          Delete {selected.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(false)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="danger"
                        aria-label={`Delete ${selected.name} memory`}
                        title="Delete this memory"
                        onClick={() => setConfirmDelete(true)}
                      >
                        ✕
                      </button>
                    ))}
                </div>
              </header>
              <div className="agent-detail-content memory-reader">
                {readError !== "" ? (
                  <div className="notice" role="alert">
                    {readError}
                  </div>
                ) : document === undefined ? (
                  <p role="status">Loading memory…</p>
                ) : (
                  <AssistantMarkdown content={document.content} />
                )}
              </div>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}

function memoryKey(memory: DesktopScopedArtifact): string {
  return [
    memory.scope,
    memory.profile,
    memory.liveProjectId,
    memory.sessionId,
    memory.name,
  ].join("\u0000");
}
