import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AbletonService } from "@ableton-agent/ableton-contracts";
import {
  ListeningFailure,
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
} from "@ableton-agent/protocol";
import type { SessionSourceLease } from "./session-listening-runtime.js";
import type { SessionSourceOrigin } from "./session-listening-source.js";

const commands = [
  "listening.prepare_session_pass",
  "listening.launch_session_pass",
  "listening.inspect_session_pass",
  "listening.release_session_pass",
  "listening.inspect_session_source",
] as const;

function deny(code: string, detail: string): never {
  throw new ListeningFailure(code, detail);
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
      const invoke = ableton.sessionListeningPass?.bind(ableton);
      const inspect = ableton.inspectSessionListeningSource?.bind(ableton);
      if (!invoke || !inspect)
        deny(
          "session_source_monitor_unavailable",
          "Source monitoring is unavailable.",
        );
      const { pass } = input;
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
        signal.throwIfAborted();
        const result = sessionListeningPassResultSchema.parse(
          await correlated(() => invoke(params, { signal })),
        );
        if (
          result.ownerId !== identity.ownerId ||
          result.passId !== identity.passId ||
          result.durationBeats !== input.durationBeats
        )
          deny(
            "session_source_receipt_mismatch",
            "Source receipt changed ownership or duration.",
          );
        return result;
      };
      const assertCurrent = (result: SessionListeningPassResult): void => {
        if (
          !["prepared", "accepted", "queued", "playing"].includes(
            result.status,
          ) ||
          result.expiresInMs === 0
        )
          deny(
            "session_source_invalid",
            result.reason ??
              `Session source is ${result.status}; playback is left running.`,
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
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(
                    new ListeningFailure(
                      "cleanup_timeout",
                      "Source monitor release was not confirmed; playback is left running.",
                    ),
                  );
                }, listeningLimits.cleanupTimeoutMs);
              }),
            ]);
            if (!["released", "cancelled", "expired"].includes(result.status))
              deny(
                "session_source_release_unconfirmed",
                "Source monitor release was not confirmed.",
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
        assertCurrent(prepared);
        if (prepared.status !== "prepared")
          deny(
            "session_source_prepare_failed",
            "Source monitoring did not enter prepared state.",
          );
      } catch (error) {
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
          deny("session_source_released", "Source monitoring was released.");
        const result = await request(
          { ...identity, action: "inspect" },
          signal,
        );
        signal.throwIfAborted();
        assertCurrent(result);
        if (
          origin &&
          (result.sourceEpoch?.startTimeBeats !== origin.clipStartTimeBeats ||
            result.sourceEpoch.clipReference !== origin.clipReference)
        )
          deny(
            "session_source_epoch_changed",
            "The monitored clip epoch changed.",
          );
        return result;
      };
      return {
        launch(signal, onProgress) {
          return (launchPromise ??= (async () => {
            if (released)
              deny(
                "session_source_released",
                "No launch was dispatched after source release.",
              );
            signal.throwIfAborted();
            onProgress?.({
              state: "requested",
              mutationState: "indeterminate",
            });
            let result = await request(
              { ...identity, action: "launch" },
              signal,
            );
            const deadline = performance.now() + 5_000;
            while (true) {
              signal.throwIfAborted();
              if (released)
                deny(
                  "session_source_released",
                  "Source monitoring was released; an accepted launch may still execute.",
                );
              assertCurrent(result);
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
                  deny(
                    "session_source_epoch_changed",
                    "Playing witness does not match the exact requested clip.",
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
                deny(
                  "session_launch_unverified",
                  "The accepted launch was not observed playing; playback is left unchanged.",
                );
              await delay(50, undefined, { signal });
              result = await check(signal);
            }
          })());
        },
        async assertCurrent(signal) {
          await check(signal);
        },
        async seal(signal) {
          if (!launchPromise)
            deny("session_launch_required", "No source launch was requested.");
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
