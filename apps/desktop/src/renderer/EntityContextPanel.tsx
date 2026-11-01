import { useEffect, useRef, useState } from "react";
import {
  listeningDisagreementMilliseconds,
  storedObservationCoordinates,
  storedObservationIdentity,
  type MetricAudioObservation,
  type StoredAudioObservation,
} from "@ableton-agent/protocol";
import {
  desktopContextDetailSchema,
  desktopContextPageSchema,
  type DesktopContextDetail,
  type DesktopContextPage,
  type DesktopEntityContextApi,
} from "../context-contracts.js";

type PageState =
  | { key: string; status: "loading" }
  | { key: string; status: "loaded"; page: DesktopContextPage }
  | { key: string; status: "failed"; message: string };
type DetailState =
  | { key: string; contextId: string; status: "loading" }
  | {
      key: string;
      contextId: string;
      status: "loaded";
      detail: DesktopContextDetail;
    }
  | { key: string; contextId: string; status: "failed"; message: string };

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Stored context could not be read";
}

export function EntityContextPanel({
  sessionId,
  api,
  contextEpoch = 0,
}: {
  sessionId?: string | undefined;
  api?: DesktopEntityContextApi | undefined;
  contextEpoch?: number | undefined;
}) {
  const [includeHistorical, setIncludeHistorical] = useState(false);
  return (
    <section
      className="entity-context-panel"
      aria-labelledby="entity-context-heading"
    >
      <h3 id="entity-context-heading">Stored listening context</h3>
      <p>
        Processed observations owned by this App session. Unknown freshness is
        not verified current context. Mixed signals do not isolate a clip.
      </p>
      {sessionId === undefined ? (
        <p>No active App session.</p>
      ) : api === undefined ? (
        <p role="status">Context storage is unavailable in this runtime.</p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={includeHistorical}
              onChange={(event) => setIncludeHistorical(event.target.checked)}
            />
            Include historical context
          </label>
          <ContextPage
            key={`${contextEpoch}:${sessionId}:${includeHistorical}`}
            sessionId={sessionId}
            api={api}
            includeHistorical={includeHistorical}
          />
        </>
      )}
    </section>
  );
}

function ContextPage({
  sessionId,
  api,
  includeHistorical,
}: {
  sessionId: string;
  api: DesktopEntityContextApi;
  includeHistorical: boolean;
}) {
  const [cursor, setCursor] = useState<string>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<PageState>({ key: "", status: "loading" });
  const [detail, setDetail] = useState<DetailState>();
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const key = JSON.stringify([sessionId, includeHistorical, cursor]);

  useEffect(() => {
    const current = ++generation.current;
    detailGeneration.current += 1;
    setPage({ key, status: "loading" });
    setDetail(undefined);
    void api
      .list({
        sessionId,
        includeHistorical,
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      .then((result) => {
        const validated = desktopContextPageSchema.parse(result);
        if (generation.current === current) {
          setPage({ key, status: "loaded", page: validated });
        }
      })
      .catch((error: unknown) => {
        if (generation.current === current) {
          setPage({ key, status: "failed", message: message(error) });
        }
      });
    return () => {
      generation.current += 1;
      detailGeneration.current += 1;
    };
  }, [api, sessionId, includeHistorical, cursor, key, revision]);

  const view = async (contextId: string) => {
    const current = ++detailGeneration.current;
    setDetail({ key, contextId, status: "loading" });
    try {
      const result = desktopContextDetailSchema.parse(
        await api.get({
          sessionId,
          contextId,
          includeHistorical,
        }),
      );
      if (result.entry.contextId !== contextId) {
        throw new Error("Context detail belongs to a different observation");
      }
      if (detailGeneration.current === current) {
        setDetail({ key, contextId, status: "loaded", detail: result });
      }
    } catch (error) {
      if (detailGeneration.current === current) {
        setDetail({
          key,
          contextId,
          status: "failed",
          message: message(error),
        });
      }
    }
  };
  if (page.key !== key || page.status === "loading") {
    return <p role="status">Loading stored context...</p>;
  }
  if (page.status === "failed") {
    return (
      <div>
        <p role="alert">{page.message}</p>
        <button onClick={() => setRevision((value) => value + 1)}>
          Retry context query
        </button>
      </div>
    );
  }
  return (
    <div>
      {page.page.entries.length === 0 ? (
        <p>No stored observations in this scope.</p>
      ) : (
        <ul className="entity-context-list">
          {page.page.entries.map((entry) => (
            <li key={entry.contextId}>
              <strong>{entry.freshness}</strong>
              <p>{entry.summary}</p>
              <p>
                Pass {entry.passId} | Listener {entry.listenerId}
              </p>
              <button
                onClick={() => {
                  void view(entry.contextId);
                }}
              >
                View observation {entry.contextId}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <button
          disabled={previous.length === 0}
          onClick={() => {
            setCursor(previous.at(-1));
            setPrevious(previous.slice(0, -1));
          }}
        >
          Previous context page
        </button>
        <button
          disabled={page.page.nextCursor === undefined}
          onClick={() => {
            setPrevious([...previous, cursor].slice(-100));
            setCursor(page.page.nextCursor);
          }}
        >
          Next context page
        </button>
        <button onClick={() => setRevision((value) => value + 1)}>
          Refresh context
        </button>
      </div>
      {previous.length >= 100 && (
        <p> Only the most recent 100 page positions are retained.</p>
      )}
      {detail?.key === key && (
        <section aria-label="Observation detail">
          {detail.status === "loading" ? (
            <p role="status">Loading observation...</p>
          ) : detail.status === "failed" ? (
            <p role="alert">{detail.message}</p>
          ) : (
            <ObservationDetail detail={detail.detail} />
          )}
        </section>
      )}
    </div>
  );
}

function ObservationDetail({ detail }: { detail: DesktopContextDetail }) {
  const value = detail.observation;
  if (value.schema === "metric-audio-observation/v1") {
    return (
      <MetricObservationDetail
        key={detail.entry.contextId}
        detail={detail}
        value={value}
      />
    );
  }
  return (
    <dl>
      <dt>Freshness</dt>
      <dd>{detail.entry.freshness}</dd>
      <dt>Coverage</dt>
      <dd>
        Beats {value.startBeat}-{value.endBeat}; samples {value.startSample}-
        {value.endSample}
      </dd>
      <dt>Peak (linear)</dt>
      <dd>{value.summaries.peak.join(", ")}</dd>
      <dt>RMS (dBFS, not LUFS)</dt>
      <dd>
        {value.summaries.rmsDbfs
          .map((level) =>
            level === null ? "silence/below floor" : level.toFixed(2),
          )
          .join(", ")}
      </dd>
      <dt>Spectral centroid</dt>
      <dd>
        {value.summaries.centroidHz === null
          ? "Not observed"
          : `${value.summaries.centroidHz.toFixed(1)} Hz`}
      </dd>
      <dt>Algorithm</dt>
      <dd>
        {value.algorithm.name} {value.algorithm.version}
      </dd>
      <ObservationAlignment value={value} />
      <dt>Retained detail</dt>
      <dd>
        {value.samples.length} descriptor points; {value.attacks.length}{" "}
        estimated attacks
      </dd>
      <dt>Completeness</dt>
      <dd>
        {value.complete ? "Complete" : "Partial"}
        {value.reduction.truncated ? "; truncated" : ""}
      </dd>
      <dt>Limitations</dt>
      <dd>
        {value.limitations.length === 0
          ? "No declared limitations; this is not a source-identity certificate"
          : value.limitations.join("; ")}
      </dd>
    </dl>
  );
}

function PagedDetail({
  label,
  items,
}: {
  label: string;
  items: Array<{ key: number; text: string }>;
}) {
  const [offset, setOffset] = useState(0);
  return (
    <section
      aria-label={label}
      style={{ overflowWrap: "anywhere", minWidth: 0 }}
    >
      <h5>{label}</h5>
      <p>
        {items.length === 0
          ? "No retained data"
          : `Showing ${offset + 1}-${Math.min(offset + 10, items.length)} of ${items.length}`}
      </p>
      <ul>
        {items.slice(offset, offset + 10).map((item) => (
          <li key={item.key}>{item.text}</li>
        ))}
      </ul>
      {items.length > 10 && (
        <div>
          <button
            aria-label={`Previous ${label}`}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 10))}
          >
            Previous
          </button>
          <button
            aria-label={`Next ${label}`}
            disabled={offset + 10 >= items.length}
            onClick={() => setOffset(offset + 10)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

function linearDb(value: number): string {
  return value === 0
    ? "silence (measured zero)"
    : `${(20 * Math.log10(value)).toFixed(2)} dBFS`;
}

function sampleSupport(support: {
  startSample: number;
  endSample: number;
}): string {
  return `samples [${support.startSample}, ${support.endSample})`;
}

function MetricObservationDetail({
  detail,
  value,
}: {
  detail: DesktopContextDetail;
  value: MetricAudioObservation;
}) {
  const coords = storedObservationCoordinates(value);
  const identity = storedObservationIdentity(value);
  return (
    <div style={{ overflowWrap: "anywhere", minWidth: 0 }}>
      <dl>
        <dt>Freshness</dt>
        <dd>{detail.entry.freshness}</dd>
        <dt>Completeness</dt>
        <dd>
          {value.outcome === "complete" ? "Complete" : "Partial"}; requested
          metrics only
        </dd>
        <dt>Identity</dt>
        <dd>
          Listener {identity.listenerId}; pass {identity.passId}
        </dd>
        <dt>Coverage</dt>
        <dd>
          Beats {coords.startBeat}-{coords.endBeat}; {sampleSupport(coords)} at{" "}
          {coords.sampleRate} Hz
        </dd>
        <dt>Source</dt>
        <dd>
          {value.source.view === "session"
            ? `Session first iteration (0), clip-local beats 0-${coords.endBeat}; global transport beats ${value.source.transport.startBeat}-${value.source.transport.endBeat}; ${value.source.kind}`
            : `Arrangement ${value.source.target.kind}; transport beats ${value.source.transport.startBeat}-${value.source.transport.endBeat}`}
          . Connection-scoped references are not durable source proof.
        </dd>
        <ObservationAlignment value={value} />
        <dt>Limitations</dt>
        <dd>
          {value.limitations.join("; ") ||
            "No declared limitations; not a source-identity certificate"}
        </dd>
        <dt>Report projection</dt>
        <dd>
          {value.rows.length} retained of {value.reduction.originalReportRows}{" "}
          report rows; {value.reduction.mode}. Rows reference authoritative
          timelines, not averaged or duplicated measurements. FFT support can
          extend before its assigned report row; no-frame is not silence. Attack
          windows are independent of report intervals.
        </dd>
      </dl>
      {(["level", "spectral-centroid", "attacks"] as const).map((name) => {
        const metric = value.metrics[name];
        const records = metric.records.map((record) => {
          let measurement: string;
          if ("rms" in record) {
            measurement = `Peak (linear) ${record.peak.join(", ")}; RMS (dBFS, not LUFS) ${record.rms.map(linearDb).join(", ")}`;
          } else if ("centroidHz" in record) {
            measurement =
              record.spectralEnergy === 0
                ? "Silence (measured zero spectral energy); centroid undefined"
                : `Centroid ${record.centroidHz?.toFixed(1)} Hz; spectral energy ${record.spectralEnergy}`;
          } else {
            measurement = `${record.events.length} estimated attacks in validated window`;
          }
          return {
            key: record.index,
            text: `Record ${record.index}: ${sampleSupport(record.support)}; ${measurement}`,
          };
        });
        return (
          <section key={name} aria-label={`${name} metric`}>
            <h4>
              {name}: {metric.status}
            </h4>
            <p>
              {metric.records.length}/{metric.expectedRecords} validated
              records.{" "}
              {metric.status === "failed"
                ? "No trustworthy data available; not silence."
                : metric.status === "not-requested"
                  ? "Not requested; no measurement."
                  : metric.status === "partial"
                    ? "Available data only; missing support is not silence."
                    : "Complete at declared analysis cadence, not continuous support for every metric."}
            </p>
            <p>
              Algorithm:{" "}
              {metric.algorithm
                ? `${metric.algorithm.name} v${metric.algorithm.version}`
                : "Not requested"}
              .{" "}
              {name === "spectral-centroid"
                ? "2048-sample FFT frames retain their actual support; no frame does not mean zero energy."
                : name === "attacks"
                  ? "Independent 100 ms windows; estimated attacks, not isolated physical onsets."
                  : "Linear-amplitude peak and RMS; only measured zero denotes silence."}
            </p>
            <p>{metric.limitations.join("; ")}</p>
            <PagedDetail label={`${name} records`} items={records} />
            <PagedDetail
              label={`${name} gaps`}
              items={metric.gaps.map((gap) => ({
                key: gap.firstIndex,
                text: `Records ${gap.firstIndex}-${gap.firstIndex + gap.count - 1}; ${sampleSupport(gap)}; ${gap.reason}: ${gap.detail}`,
              }))}
            />
          </section>
        );
      })}
      <PagedDetail
        label="Report rows"
        items={value.rows.map((row) => ({
          key: row.index,
          text: `Row ${row.index}: beats [${value.geometry.rows[row.index]!.startBeat}, ${value.geometry.rows[row.index]!.endBeat}); ${sampleSupport(value.geometry.rows[row.index]!)}; ${(["level", "spectral-centroid", "attacks"] as const).map((name) => `${name}: ${row[name].availability}; record indices ${row[name].recordIndices.join(", ") || "none"}`).join("; ")}`,
        }))}
      />
    </div>
  );
}

function ObservationAlignment({ value }: { value: StoredAudioObservation }) {
  if (value.schema === "audio-observation/v1") {
    return (
      <>
        <dt>Timing uncertainty (legacy v1)</dt>
        <dd>
          {value.algorithm.timingUncertaintySamples} samples (legacy reported
          value)
        </dd>
      </>
    );
  }
  const quality = value.alignment;
  const { sampleRate } = storedObservationCoordinates(value);
  const measurement = (samples: number) =>
    `${samples} samples (${listeningDisagreementMilliseconds(samples, sampleRate).toFixed(3)} ms at ${sampleRate} Hz)`;
  return (
    <>
      <dt>Alignment / intended use</dt>
      <dd>Approximate; descriptive-only</dd>
      <dt>
        {quality.policy.mode === "strict"
          ? "Configured acceptance limit"
          : "Advisory timing target"}
      </dt>
      <dd>
        {quality.policy.mode};{" "}
        {measurement(quality.policy.maxClockDisagreementSamples)}
        {quality.policy.mode === "strict"
          ? "; no fallback"
          : "; not a capture limit"}
      </dd>
      <dt>Observed clock disagreement</dt>
      <dd>{measurement(quality.observedClockDisagreementSamples)}</dd>
      <dt>Observed beat disagreement</dt>
      <dd>{measurement(quality.observedBeatDisagreementSamples)}</dd>
      <dt>Estimated absolute timing error</dt>
      <dd>Unknown (not estimated)</dd>
      <dt>Verified absolute error bound</dt>
      <dd>Unknown (not verified)</dd>
      <dt>Tempo scope</dt>
      <dd>
        Constant tempo assumed; stability not independently verified. Tempo
        automation is unsupported.
      </dd>
      <dt>Timing interpretation</dt>
      <dd>
        Observed disagreement is not physical timing uncertainty or an absolute
        accuracy bound, even when zero. This observation retains its pass&apos;s
        starting policy, not the current Settings value.
      </dd>
    </>
  );
}
