import { useState, type ReactNode } from "react";
import type {
  PitchEstimateState,
  PitchTimeline,
  SpectralShapeTimeline,
} from "@ableton-agent/protocol";

const pitchState: Record<PitchEstimateState, string> = {
  "accepted-estimate": "Accepted estimate (not verified pitch)",
  silence: "Measured silence; no pitch estimate",
  undefined: "Undefined estimate",
  "low-confidence": "Low confidence estimate",
  "outside-qualified-range": "Estimate outside output gate",
  invalid: "Invalid analyzer output",
};
const number = (value: number | null) =>
  value === null ? "Unavailable" : String(Number(value.toPrecision(8)));

type AnalyzerDetailProps = {
  contextId: string;
  timeline: PitchTimeline | SpectralShapeTimeline;
  gapDetails: ReactNode;
};

export function AnalyzerTimelineDetail({
  contextId,
  ...props
}: AnalyzerDetailProps) {
  return (
    <AnalyzerTimelineFrames
      key={`${contextId}:${props.timeline.schema}`}
      {...props}
    />
  );
}

function AnalyzerTimelineFrames({
  timeline,
  gapDetails,
}: Omit<AnalyzerDetailProps, "contextId">) {
  const [position, setPosition] = useState(0);
  const label =
    timeline.schema === "pitch-timeline/v1" ? "pitch" : "spectral-shape";
  const pitch =
    timeline.schema === "pitch-timeline/v1"
      ? timeline.frames[position]
      : undefined;
  const shape =
    timeline.schema === "spectral-shape-timeline/v1"
      ? timeline.frames[position]
      : undefined;
  const frame = pitch ?? shape;
  const missing = timeline.gaps.reduce((sum, gap) => sum + gap.count, 0);
  return (
    <section aria-label={`${label} metric`}>
      <h4>
        {label}: {timeline.status}
      </h4>
      <p>
        {timeline.frames.length}/{timeline.expectedRecords} validated
        acquisition frames; {missing} missing. Acquisition completeness does not
        imply usable descriptors. Missing frames are not measured silence.
      </p>
      <p>
        Independent left/right channels; {timeline.sampleRate} Hz sample rate;{" "}
        {timeline.profile.windowSamples}-sample periodic Hann window and{" "}
        {timeline.profile.hopSamples}-sample hop. Actual source samples [
        {timeline.sourceSupport.startSample}, {timeline.sourceSupport.endSample}
        ).
      </p>
      <p>
        {timeline.trailingSupport === null
          ? "No unmeasured trailing samples."
          : `Unmeasured tail samples [${timeline.trailingSupport.startSample}, ${timeline.trailingSupport.endSample}); no padding or measured-zero claim.`}
      </p>
      {timeline.schema === "pitch-timeline/v1" ? (
        <p>
          YinFFT estimates, not transcription. Confidence is an
          algorithm-specific score, not probability. The output gate (
          {number(timeline.profile.outputMinimumHz)}-
          {number(timeline.profile.outputMaximumHz)} Hz; score at least{" "}
          {timeline.profile.confidenceThreshold}) cannot prove input class or
          accuracy. A known 2000 Hz sine can produce a high-confidence estimate
          near 1000 Hz.
        </p>
      ) : (
        <p>
          Flatness is in dB; spread and 95-percent rolloff are in Hz. Magnitude
          weighting, linear frequency; Nyquist bin excluded. Silence and
          undefined descriptors remain unavailable, not zero-valued
          measurements. These values do not identify a source or prescribe a
          filter cutoff.
        </p>
      )}
      <details>
        <summary>{label} profile and qualification</summary>
        <p>
          {timeline.profile.schema}; pinned core{" "}
          {timeline.profile.sourcePins.core}. Numerical qualification: offline
          controlled inputs on{" "}
          {timeline.profile.qualificationBuild.executedArchitecture}. This is
          not a guarantee for arbitrary audio or physical timing.
        </p>
        {timeline.schema === "pitch-timeline/v1" && (
          <p>
            Tested sine frequencies: {timeline.profile.testedInputHz.join(", ")}{" "}
            Hz; {timeline.profile.testedMaximumErrorCents}-cent error bound for
            the declared test cases.
          </p>
        )}
      </details>
      {frame === undefined ? (
        <p>No retained {label} frames; descriptors unavailable.</p>
      ) : (
        <>
          <p aria-live="polite">
            Frame {frame.index}: source samples [{frame.support.startSample},{" "}
            {frame.support.endSample}).
          </p>
          <button
            aria-label={`Previous ${label} frame`}
            disabled={position === 0}
            onClick={() => setPosition((value) => Math.max(0, value - 1))}
          >
            Previous {label} frame
          </button>
          <button
            aria-label={`Next ${label} frame`}
            disabled={position >= timeline.frames.length - 1}
            onClick={() =>
              setPosition((value) =>
                Math.min(timeline.frames.length - 1, value + 1),
              )
            }
          >
            Next {label} frame
          </button>
          {pitch !== undefined && (
            <table aria-label="Pitch estimates and confidence">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>State</th>
                  <th>Estimate (Hz)</th>
                  <th>Confidence score</th>
                </tr>
              </thead>
              <tbody>
                {pitch.channels.map((channel, index) => (
                  <tr key={index}>
                    <th>{index === 0 ? "Left" : "Right"}</th>
                    <td>{pitchState[channel.state]}</td>
                    <td>
                      {channel.hz === 0
                        ? "0 (undefined sentinel)"
                        : number(channel.hz)}
                    </td>
                    <td>{number(channel.confidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shape !== undefined && (
            <table aria-label="Spectral shape measurements">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>State</th>
                  <th>Flatness (dB)</th>
                  <th>Spread (Hz)</th>
                  <th>Rolloff 95% (Hz)</th>
                </tr>
              </thead>
              <tbody>
                {shape.channels.map((channel, index) => (
                  <tr key={index}>
                    <th>{index === 0 ? "Left" : "Right"}</th>
                    <td>{channel.state}</td>
                    <td>{number(channel.flatnessDb)}</td>
                    <td>{number(channel.spreadHz)}</td>
                    <td>{number(channel.rolloffHz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {gapDetails}
    </section>
  );
}
