import {
  configurationSnapshotSchema,
  telemetryEventEnvelopeSchema,
  type ConfigurationSnapshot,
  type TelemetryEventEnvelope,
} from "./contracts.js";
import { sanitizeTelemetryAttributes } from "./sanitizer.js";

/** Minimal injectable contract for event-only producers. */
export interface TelemetryEventRecorder {
  enqueue(event: TelemetryEventEnvelope): void | Promise<void>;
}

/** Persistence-facing contract including configuration snapshots. */
export interface ObservabilitySink extends TelemetryEventRecorder {
  enqueueConfigurationSnapshot(
    snapshot: ConfigurationSnapshot,
  ): void | Promise<void>;
}

/**
 * Stable producer-facing surface. Calls return immediately; persistence
 * failures are delivered out-of-band and can never fail the instrumented path.
 */
export interface NonBlockingObservabilityRecorder {
  enqueue(event: TelemetryEventEnvelope): void;
  enqueueConfigurationSnapshot(snapshot: ConfigurationSnapshot): void;
}

export interface ObservabilityRecorderFailure {
  readonly operation: "event" | "configuration_snapshot";
  readonly error: unknown;
}

export interface NonBlockingObservabilityRecorderOptions {
  readonly onFailure?: (failure: ObservabilityRecorderFailure) => void;
}

export function createNonBlockingObservabilityRecorder(
  sink: ObservabilitySink,
  options: NonBlockingObservabilityRecorderOptions = {},
): NonBlockingObservabilityRecorder {
  const report = (failure: ObservabilityRecorderFailure): void => {
    queueMicrotask(() => {
      try {
        options.onFailure?.(failure);
      } catch {
        // Observability diagnostics must not fail the instrumented operation.
      }
    });
  };

  const dispatch = (
    operation: ObservabilityRecorderFailure["operation"],
    write: () => void | Promise<void>,
  ): void => {
    queueMicrotask(() => {
      try {
        const pending = write();
        if (pending !== undefined) {
          void Promise.resolve(pending).catch((error: unknown) => {
            report({ operation, error });
          });
        }
      } catch (error) {
        report({ operation, error });
      }
    });
  };

  return {
    enqueue: (event) => {
      dispatch("event", () =>
        sink.enqueue(
          telemetryEventEnvelopeSchema.parse({
            ...event,
            attributes: sanitizeTelemetryAttributes(event.attributes),
          }),
        ),
      );
    },
    enqueueConfigurationSnapshot: (snapshot) => {
      dispatch("configuration_snapshot", () =>
        sink.enqueueConfigurationSnapshot(
          configurationSnapshotSchema.parse({
            ...snapshot,
            values: sanitizeTelemetryAttributes(snapshot.values),
          }),
        ),
      );
    },
  };
}
