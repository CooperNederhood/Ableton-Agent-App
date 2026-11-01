import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  listeningLimits,
  type ListeningPassContext,
} from "@ableton-agent/application";
import { withCorrelation } from "@ableton-agent/correlation";
import {
  sessionListeningPassResultSchema,
  type InspectSessionListeningSourceParams,
  type PrepareSessionListeningPassParams,
  type SessionListeningPassParams,
  type SessionListeningPassResult,
  type ListeningFailureFact,
  type ListeningFailureEvidence,
} from "@ableton-agent/protocol";
import type { SessionSourceLease } from "./session-listening-runtime.js";
import type { SessionSourceOrigin } from "./session-listening-source.js";
import {
  assertSessionSignal,
  attributeSessionRejection,
  validateSessionEvidence,
} from "./session-listening-source.js";
import { failureFact, ListeningRuntimeRejection } from "./listening-failure.js";

const commands = [
  "listening.prepare_session_pass",
  "listening.launch_session_pass",
  "listening.inspect_session_pass",
  "listening.release_session_pass",
  "listening.inspect_session_source",
] as const;

function deny(
  code: string,
  detail: string,
  facts: readonly ListeningFailureFact[],
): never {
  const error = new ListeningRuntimeRejection(code, undefined, facts);
  error.message = detail;
  throw error;
}

export function createSessionSourceDriver(
  ableton: Pick<
    AbletonService,
    "getCapabilities" | "sessionListeningPass" | "inspectSessionListeningSource"
  >,
) {
  return {
    async assertAvailable(): Promise<void> {
      const capabilities = await ableton.getCapabilities();
      if (
        !ableton.sessionListeningPass ||
        !ableton.inspectSessionListeningSource ||
        !/^11(?:\.|$)/u.test(capabilities.liveVersion) ||
        commands.some((command) => capabilities.capabilities[command] !== true)
      )
        deny(
          "session_source_monitor_unavailable",
          "Session listening requires Live 11 and all guarded source-monitor capabilities.",
          [
            failureFact(
              "driver.sessionListeningPass.available",
              Boolean(ableton.sessionListeningPass),
              true,
            ),
            failureFact(
              "driver.inspectSessionListeningSource.available",
              Boolean(ableton.inspectSessionListeningSource),
              true,
            ),
            failureFact("driver.liveVersion", capabilities.liveVersion, "11.x"),
            ...commands.map((command) =>
              failureFact(
                `capability.${command}`,
                capabilities.capabilities[command],
                true,
              ),
            ),
          ],
        );
    },

    async prepare(input: {
      pass: ListeningPassContext & { signal: AbortSignal };
      target: InspectSessionListeningSourceParams["target"];
      durationBeats: number;
      expectedProjectRevision: number;
      binding: PrepareSessionListeningPassParams["listener"];
      startBeat: number;
    }): Promise<SessionSourceLease> {
      const { pass } = input;
      const checkSignal = (signal: AbortSignal, check: string) => {
        try {
          assertSessionSignal(signal, check);
        } catch (error) {
          attributeSessionRejection(
            error,
            pass,
            check.includes("launch")
              ? "launch"
              : check.includes("prepare")
                ? "preparation"
                : "capture",
            signal,
          );
          throw error;
        }
      };
      const reject: (
        code: string,
        detail: string,
        facts: readonly ListeningFailureFact[],
        phase?: ListeningFailureEvidence["phase"],
      ) => never = (code, detail, facts, failedPhase) => {
        const error = new ListeningRuntimeRejection(code, undefined, facts);
        error.message = detail;
        const phase =
          code.startsWith("session_source_release") ||
          code === "cleanup_timeout"
            ? "cleanup"
            : code === "session_source_prepare_failed"
              ? "preparation"
              : code === "session_launch_unverified" ||
                  code === "session_launch_required"
                ? "launch"
                : "capture";
        attributeSessionRejection(error, pass, failedPhase ?? phase);
        throw error;
      };
      const invoke = ableton.sessionListeningPass?.bind(ableton);
      const inspect = ableton.inspectSessionListeningSource?.bind(ableton);
      if (!invoke || !inspect)
        reject(
          "session_source_monitor_unavailable",
          "Source monitoring is unavailable.",
          [
            failureFact(
              "driver.sessionListeningPass.available",
              Boolean(invoke),
              true,
            ),
            failureFact(
              "driver.inspectSessionListeningSource.available",
              Boolean(inspect),
              true,
            ),
          ],
        );
      const identity = {
        schemaVersion: 1 as const,
        ownerId: randomUUID(),
        passId: pass.passId,
      };
      const correlated = <T>(operation: () => T) =>
        withCorrelation(
          {
            ...pass.trace,
            sessionId: pass.owner.sessionId,
            liveSetId: pass.owner.liveSetId,
            activeAgentId: pass.owner.agentId,
          },
          operation,
        );
      const request = async (
        params: SessionListeningPassParams,
        signal: AbortSignal,
      ) => {
        checkSignal(signal, `driver.${params.action}.before-request`);
        const raw = await correlated(() => invoke(params, { signal }));
        let result: SessionListeningPassResult;
        try {
          result = validateSessionEvidence(
            "session.driver.receipt.schema",
            () => sessionListeningPassResultSchema.parse(raw),
            raw,
          );
        } catch (error) {
          attributeSessionRejection(
            error,
            pass,
            params.action === "release"
              ? "cleanup"
              : params.action === "prepare"
                ? "preparation"
                : "capture",
          );
          throw error;
        }
        if (
          result.ownerId !== identity.ownerId ||
          result.passId !== identity.passId ||
          result.durationBeats !== input.durationBeats
        )
          reject(
            "session_source_receipt_mismatch",
            "Source receipt changed ownership or duration.",
            [
              failureFact("receipt.action", params.action),
              failureFact("receipt.ownerId", result.ownerId, identity.ownerId),
              failureFact("receipt.passId", result.passId, identity.passId),
              failureFact(
                "receipt.durationBeats",
                result.durationBeats,
                input.durationBeats,
                { unit: "beats" },
              ),
            ],
            params.action === "release"
              ? "cleanup"
              : params.action === "prepare"
                ? "preparation"
                : "capture",
          );
        return result;
      };
      const assertCurrent = (
        result: SessionListeningPassResult,
        phase: ListeningFailureEvidence["phase"] = "capture",
      ): void => {
        if (
          !["prepared", "accepted", "queued", "playing", "covered"].includes(
            result.status,
          ) ||
          result.expiresInMs === 0
        )
          reject(
            "session_source_invalid",
            result.reason ??
              `Session source is ${result.status}; playback is left running.`,
            [
              failureFact(
                "receipt.status",
                result.status,
                "prepared|accepted|queued|playing|covered",
              ),
              failureFact(
                "receipt.expiresInMs",
                result.expiresInMs,
                "nonzero",
                { unit: "ms" },
              ),
              failureFact("receipt.reason", result.reason),
              failureFact("receipt.mutationState", result.mutationState),
            ],
            phase,
          );
      };
      let releasePromise: Promise<void> | undefined;
      let released = false;
      let launchPromise: Promise<SessionSourceOrigin> | undefined;
      let origin: SessionSourceOrigin | undefined;
      const release = () =>
        (releasePromise ??= (async () => {
          released = true;
          const controller = new AbortController();
          const releaseStarted = performance.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              request(
                {
                  ...identity,
                  action: "release",
                  reason: pass.signal.aborted ? "cancelled" : "completed",
                },
                controller.signal,
              ),
              new Promise<never>((_resolve, rejectTimeout) => {
                timer = setTimeout(() => {
                  try {
                    // Latch the timeout operands before cancellation changes the request.
                    reject(
                      "cleanup_timeout",
                      "Source monitor release was not confirmed; playback is left running.",
                      [
                        failureFact(
                          "cleanup.elapsedMs",
                          performance.now() - releaseStarted,
                          listeningLimits.cleanupTimeoutMs,
                          { comparison: "at-most", unit: "ms" },
                        ),
                        failureFact("cleanup.cancelled", pass.signal.aborted),
                      ],
                    );
                  } catch (error) {
                    rejectTimeout(
                      error instanceof Error
                        ? error
                        : new Error("Source monitor cleanup failed"),
                    );
                  } finally {
                    controller.abort();
                  }
                }, listeningLimits.cleanupTimeoutMs);
              }),
            ]);
            if (!["released", "cancelled", "expired"].includes(result.status))
              reject(
                "session_source_release_unconfirmed",
                "Source monitor release was not confirmed.",
                [
                  failureFact(
                    "receipt.status",
                    result.status,
                    "released|cancelled|expired",
                  ),
                  failureFact(
                    "cleanup.elapsedMs",
                    performance.now() - releaseStarted,
                    undefined,
                    { unit: "ms" },
                  ),
                ],
              );
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        })());
      try {
        const prepared = await request(
          {
            ...identity,
            action: "prepare",
            expectedLiveSetId: pass.owner.liveSetId,
            expectedProjectRevision: input.expectedProjectRevision,
            target: input.target,
            listener: input.binding,
            durationBeats: input.durationBeats,
            timingAnchor: { globalBeat: input.startBeat },
          },
          pass.signal,
        );
        assertCurrent(prepared, "preparation");
        if (prepared.status !== "prepared")
          reject(
            "session_source_prepare_failed",
            "Source monitoring did not enter prepared state.",
            [failureFact("receipt.status", prepared.status, "prepared")],
          );
      } catch (error) {
        attributeSessionRejection(error, pass, "preparation", pass.signal);
        try {
          await release();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Source preparation and cleanup failed.",
          );
        }
        throw error;
      }
      const check = async (signal: AbortSignal) => {
        if (released)
          reject("session_source_released", "Source monitoring was released.", [
            failureFact("source.released", released, false),
          ]);
        const result = await request(
          { ...identity, action: "inspect" },
          signal,
        );
        checkSignal(signal, "driver.inspect.after-receipt");
        assertCurrent(result);
        if (
          origin &&
          (result.sourceEpoch?.startTimeBeats !== origin.clipStartTimeBeats ||
            result.sourceEpoch.clipReference !== origin.clipReference)
        )
          reject(
            "session_source_epoch_changed",
            "The monitored clip epoch changed.",
            [
              failureFact(
                "receipt.sourceEpoch.startTimeBeats",
                result.sourceEpoch?.startTimeBeats,
                origin.clipStartTimeBeats,
                { unit: "beats" },
              ),
              failureFact(
                "receipt.sourceEpoch.clipReference",
                result.sourceEpoch?.clipReference,
                origin.clipReference,
              ),
            ],
          );
        return result;
      };
      return {
        launch(signal, onProgress) {
          return (launchPromise ??= (async () => {
            if (released)
              reject(
                "session_source_released",
                "No launch was dispatched after source release.",
                [
                  failureFact("source.released", released, false),
                  failureFact("launch.dispatched", false),
                ],
              );
            checkSignal(signal, "driver.launch.before-dispatch");
            onProgress?.({
              state: "requested",
              mutationState: "indeterminate",
            });
            let result = await request(
              { ...identity, action: "launch" },
              signal,
            );
            const started = performance.now();
            const deadline = started + 5_000;
            while (true) {
              checkSignal(signal, "driver.launch.await-playing");
              if (released)
                reject(
                  "session_source_released",
                  "Source monitoring was released; an accepted launch may still execute.",
                  [
                    failureFact("source.released", released, false),
                    failureFact("launch.dispatched", true),
                  ],
                );
              assertCurrent(result, "launch");
              if (result.status === "playing" && result.sourceEpoch) {
                const witness = result.lastObservedSource;
                if (
                  result.sourceEpoch.clipReference !==
                    input.target.expectedClipReference ||
                  witness.selectedClipReference !==
                    input.target.expectedClipReference ||
                  witness.playingSlotIndex !== input.target.sceneIndex ||
                  witness.targetPlaying !== true ||
                  witness.targetRecording !== false
                )
                  reject(
                    "session_source_epoch_changed",
                    "Playing witness does not match the exact requested clip.",
                    [
                      failureFact(
                        "receipt.sourceEpoch.clipReference",
                        result.sourceEpoch.clipReference,
                        input.target.expectedClipReference,
                      ),
                      failureFact(
                        "receipt.witness.selectedClipReference",
                        witness.selectedClipReference,
                        input.target.expectedClipReference,
                      ),
                      failureFact(
                        "receipt.witness.playingSlotIndex",
                        witness.playingSlotIndex,
                        input.target.sceneIndex,
                      ),
                      failureFact(
                        "receipt.witness.targetPlaying",
                        witness.targetPlaying,
                        true,
                      ),
                      failureFact(
                        "receipt.witness.targetRecording",
                        witness.targetRecording,
                        false,
                      ),
                    ],
                  );
                origin = {
                  clipReference: result.sourceEpoch.clipReference,
                  playingSlotIndex: witness.playingSlotIndex,
                  clipStartTimeBeats: result.sourceEpoch.startTimeBeats,
                  observedAtGlobalBeat: result.sourceEpoch.observedGlobalBeat,
                };
                onProgress?.({
                  state: "observed",
                  mutationState: "observed-playing",
                });
                return origin;
              }
              onProgress?.({
                state: "queued",
                mutationState: result.mutationState,
              });
              if (performance.now() >= deadline)
                reject(
                  "session_launch_unverified",
                  "The accepted launch was not observed playing; playback is left unchanged.",
                  [
                    failureFact(
                      "launch.elapsedMs",
                      performance.now() - started,
                      5_000,
                      { comparison: "at-most", unit: "ms" },
                    ),
                    failureFact("receipt.status", result.status, "playing"),
                    failureFact(
                      "receipt.sourceEpoch.present",
                      Boolean(result.sourceEpoch),
                      true,
                    ),
                    failureFact("receipt.mutationState", result.mutationState),
                  ],
                );
              await delay(50, undefined, { signal });
              result = await check(signal);
            }
          })().catch((error: unknown) => {
            attributeSessionRejection(error, pass, "launch", signal);
            throw error;
          }));
        },
        async assertCurrent(signal) {
          await check(signal);
        },
        async seal(signal) {
          if (!launchPromise)
            reject(
              "session_launch_required",
              "No source launch was requested.",
              [failureFact("launch.requested", Boolean(launchPromise), true)],
            );
          const actualOrigin = await launchPromise;
          await check(signal);
          const source = await correlated(() =>
            inspect(
              { schemaVersion: 1, queryId: randomUUID(), target: input.target },
              { signal },
            ),
          );
          await check(signal);
          return { origin: actualOrigin, source };
        },
        release,
      };
    },
  };
}
