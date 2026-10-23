import { useEffect, useRef, useState } from "react";
import type { DesktopApi, DesktopAppEvent } from "../contracts.js";
import {
  desktopListeningPageSchema,
  listeningTerminal,
  type DesktopListeningJob,
} from "../listening-contracts.js";

export interface ListeningUiApi {
  listening: DesktopApi["listening"];
  agents: Pick<DesktopApi["agents"], "cancel">;
  events: Pick<DesktopApi["events"], "subscribe">;
}
type Inventory =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "loaded"; jobs: DesktopListeningJob[] };
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : "Listening inventory failed").slice(
    0,
    2048,
  );

export function ListeningPassPanel({
  sessionId,
  agentId,
  api,
  contextEpoch = 0,
}: {
  sessionId?: string | undefined;
  agentId?: string | undefined;
  api?: ListeningUiApi | undefined;
  contextEpoch?: number | undefined;
}) {
  return (
    <section
      className="listening-pass-panel"
      aria-labelledby="listening-pass-heading"
    >
      <h3 id="listening-pass-heading">Listening passes</h3>
      <p>
        Bounded Arrangement capture leaves Live playback running on completion,
        cancellation, failure and timeout. Cancel capture does not stop
        transport. Session capture is unsupported. Production timing
        certification is not available; lifecycle status is not proof of
        measured audio or accurate timing.
      </p>
      {sessionId === undefined || agentId === undefined ? (
        <p>Select an App session and agent to see owned listening passes.</p>
      ) : api === undefined || api.listening === undefined ? (
        <p role="alert">Listening lifecycle is unavailable in this runtime.</p>
      ) : (
        <ListeningInventory
          key={`${contextEpoch}:${sessionId}:${agentId}`}
          sessionId={sessionId}
          agentId={agentId}
          api={api}
        />
      )}
    </section>
  );
}

function ListeningInventory({
  sessionId,
  agentId,
  api,
}: {
  sessionId: string;
  agentId: string;
  api: ListeningUiApi;
}) {
  const [inventory, setInventory] = useState<Inventory>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<{
    outcome: "requested" | "empty" | "failed";
    message: string;
  }>();
  const generation = useRef(0);
  const revision = useRef(-1);
  useEffect(() => {
    const current = ++generation.current;
    const accept = (raw: unknown) => {
      const page = desktopListeningPageSchema.parse(raw);
      if (
        page.sessionId !== sessionId ||
        page.jobs.some((job) => job.sessionId !== sessionId)
      )
        throw new Error(
          "Listening inventory belongs to another App session. Refresh.",
        );
      if (current !== generation.current || page.revision < revision.current)
        return;
      revision.current = page.revision;
      setInventory({
        status: "loaded",
        jobs: page.jobs.filter((job) => job.agentId === agentId).slice(0, 100),
      });
    };
    const failed = (error: unknown) => {
      if (current === generation.current)
        setInventory({ status: "failed", message: errorMessage(error) });
    };
    const unsubscribe = api.events.subscribe((event: DesktopAppEvent) => {
      if (
        event.type === "listening.changed" &&
        event.page.sessionId === sessionId
      ) {
        try {
          accept(event.page);
        } catch (error) {
          failed(error);
        }
      } else if (event.type === "listening.reset") {
        generation.current++;
        revision.current = -1;
        setCancelNotice(undefined);
        setCancelling(false);
        if (event.reason === "shutdown")
          setInventory({
            status: "failed",
            message:
              "Listening runtime stopped. Restart the app before retrying.",
          });
        else {
          setInventory({ status: "loading" });
          setRefresh((value) => value + 1);
        }
      }
    });
    setInventory({ status: "loading" });
    const requestedRevision = revision.current;
    void api.listening
      .list({ sessionId, agentId, limit: 100 })
      .then(accept)
      .catch((error: unknown) => {
        if (revision.current === requestedRevision) failed(error);
      });
    return () => {
      generation.current++;
      unsubscribe();
    };
  }, [api, sessionId, agentId, refresh]);

  const cancel = async () => {
    const current = generation.current;
    setCancelling(true);
    setCancelNotice(undefined);
    try {
      const result = await api.agents.cancel(agentId, { sessionId });
      if (current === generation.current) {
        setCancelNotice({
          outcome: result.cancelled ? "requested" : "empty",
          message: result.cancelled
            ? "Cancellation requested for this agent's turn and owned captures. Await terminal status; cancellation does not stop Live transport."
            : "No cancellable work remains for this agent. Refresh listening passes.",
        });
      }
    } catch (error) {
      if (current === generation.current)
        setCancelNotice({ outcome: "failed", message: errorMessage(error) });
    } finally {
      if (current === generation.current) setCancelling(false);
    }
  };
  const active =
    inventory.status === "loaded" &&
    inventory.jobs.some((job) => !listeningTerminal(job.stage));
  return (
    <div>
      <button
        disabled={cancelling}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh listening passes
      </button>
      <button disabled={!active || cancelling} onClick={() => void cancel()}>
        {cancelling
          ? "Requesting cancellation…"
          : "Cancel owned capture (not transport)"}
      </button>
      <p>
        Cancellation also aborts this agent's active turn and all its owned
        captures—not another agent's work.
      </p>
      {cancelNotice !== undefined && (
        <p role={cancelNotice.outcome === "failed" ? "alert" : "status"}>
          {cancelNotice.message}
        </p>
      )}
      {inventory.status === "loading" ? (
        <p role="status">Loading listening passes…</p>
      ) : inventory.status === "failed" ? (
        <p role="alert">{inventory.message}</p>
      ) : inventory.jobs.length === 0 ? (
        <p>No listening passes for this agent in this App session.</p>
      ) : (
        <ul aria-label="Owned listening passes">
          {inventory.jobs.map((job) => (
            <li key={job.passId} data-listening-stage={job.stage}>
              <strong>{job.stage}</strong> —{" "}
              {(job.durationMs / 1000).toFixed(2)} seconds
              <p>
                Pass {job.passId} | Agent {job.agentId}
              </p>
              <p>
                Playback policy: leave running. {job.contextIds.length} stored
                observation references.
              </p>
              {job.error !== undefined && (
                <p role="alert">
                  {job.error} Review the reported failure; retry only after
                  resolving the failure.
                </p>
              )}
              {job.stage === "completed" && (
                <p>
                  Lifecycle completed; inspect stored context for coverage and
                  limitations. This is not a DSP certificate.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
