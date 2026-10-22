import { z } from "zod";
import {
  listeningOperationParamsSchema,
  listeningOperationResultSchema,
  type ListeningOperationParams,
  type ListeningOperationResult,
} from "@ableton-agent/tools";
import type {
  CopilotAgentServiceOptions,
  ListeningExecutionContext,
} from "./index.js";
import {
  ListeningCoordinator,
  ListeningFailure,
  awaitListeningBoundary,
  listeningLimits,
  type ListeningCoordinatorOptions,
  type ListeningJob,
  type ListeningOwner,
} from "./listening-coordinator.js";

type ListenerViews = Extract<
  ListeningOperationResult,
  { action: "inspect-listeners" }
>;
type SessionTarget = Extract<
  ListeningOperationParams,
  { action: "play-session-and-listen" }
>["target"];

export interface ListeningHostOptions extends Pick<
  ListeningCoordinatorOptions,
  "services" | "telemetry" | "now" | "createId" | "onChange"
> {
  readonly resolveOwner: (
    context: ListeningExecutionContext,
  ) => Promise<ListeningOwner>;
  readonly inspectListeners: (
    context: ListeningExecutionContext,
  ) => Promise<ListenerViews>;
  readonly resolveSessionTarget: (
    target: SessionTarget,
    context: ListeningExecutionContext,
  ) => Promise<{ clipReference: string; trackReference: string }>;
}

const cursorSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  passId: z.string().min(1).max(256),
});

function publicJob(job: ListeningJob) {
  return {
    passId: job.passId,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    durationMs: job.durationMs,
    contextIds: [...job.contextIds],
    ...(job.cleanupPolicy === undefined
      ? {}
      : { cleanupPolicy: job.cleanupPolicy }),
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}

/** One coordinator/transport owner per host, with caller-scoped typed queries. */
export function createListeningHost(
  options: ListeningHostOptions,
): Required<
  Pick<
    CopilotAgentServiceOptions,
    "executeListeningOperation" | "waitForListeningPass"
  >
> & { shutdown(): Promise<void> } {
  const jobs = new Map<string, ListeningJob>();
  const coordinator = new ListeningCoordinator({
    ...options,
    onChange: (job) => {
      jobs.set(job.passId, job);
      while (jobs.size > listeningLimits.maxJobs) {
        const oldest = [...jobs].find(([, item]) =>
          ["completed", "failed", "cancelled", "interrupted"].includes(
            item.stage,
          ),
        );
        if (oldest === undefined) {
          throw new ListeningFailure(
            "quota_exceeded",
            "Listening job inventory is full",
          );
        }
        jobs.delete(oldest[0]);
      }
      options.onChange?.(structuredClone(job));
    },
  });
  const owned = (passId: string, context: ListeningExecutionContext) => {
    const job = jobs.get(passId);
    if (
      job === undefined ||
      job.owner.sessionId !== context.sessionId ||
      job.owner.agentId !== context.agentId
    ) {
      throw new ListeningFailure(
        "permission_denied",
        "No listening pass belongs to the invoking App session and agent",
      );
    }
    return job;
  };
  return {
    executeListeningOperation: async (input, context) => {
      const params = listeningOperationParamsSchema.parse(input);
      let result: ListeningOperationResult;
      if (params.action === "inspect-listeners") {
        result = await options.inspectListeners(context);
      } else if (params.action === "list-passes") {
        const available = [...jobs.values()]
          .filter(
            ({ owner }) =>
              owner.sessionId === context.sessionId &&
              owner.agentId === context.agentId,
          )
          .reverse();
        let offset = 0;
        if (params.cursor !== undefined) {
          let cursor: z.infer<typeof cursorSchema>;
          try {
            if (!/^[A-Za-z0-9_-]+$/.test(params.cursor)) {
              throw new Error("Invalid cursor encoding");
            }
            cursor = cursorSchema.parse(
              JSON.parse(
                Buffer.from(params.cursor, "base64url").toString("utf8"),
              ),
            );
          } catch (cause) {
            throw new ListeningFailure(
              "invalid_params",
              `Invalid listening cursor: ${cause instanceof Error ? cause.name : "invalid value"}`,
            );
          }
          if (
            cursor.sessionId !== context.sessionId ||
            cursor.agentId !== context.agentId
          ) {
            throw new ListeningFailure(
              "permission_denied",
              "Listening cursor belongs to another session or agent",
            );
          }
          const index = available.findIndex(
            ({ passId }) => passId === cursor.passId,
          );
          if (index < 0) {
            throw new ListeningFailure(
              "stale_reference",
              "Listening cursor has expired; restart the query",
            );
          }
          offset = index + 1;
        }
        const page = available.slice(offset, offset + params.limit);
        const last = page.at(-1);
        result = {
          action: params.action,
          jobs: page.map(publicJob),
          ...(last === undefined || offset + page.length >= available.length
            ? {}
            : {
                nextCursor: Buffer.from(
                  JSON.stringify({
                    sessionId: context.sessionId,
                    agentId: context.agentId,
                    passId: last.passId,
                  }),
                ).toString("base64url"),
              }),
        };
      } else if (params.action === "get-pass" || params.action === "cancel") {
        const job = owned(params.passId, context);
        result = {
          action: params.action,
          job: publicJob(
            params.action === "cancel"
              ? await coordinator.cancel(params.passId, job.owner)
              : coordinator.get(params.passId, job.owner),
          ),
        };
      } else {
        if (context.signal?.aborted) {
          const error = new Error("Listening invocation was cancelled");
          error.name = "AbortError";
          throw error;
        }
        if (context.actorKind === "application") {
          throw new ListeningFailure(
            "permission_denied",
            "Playback listening requires an initiating agent owner",
          );
        }
        const owner = await awaitListeningBoundary(
          options.resolveOwner(context),
          context.signal,
        );
        if (context.signal?.aborted) {
          const error = new Error("Listening invocation was cancelled");
          error.name = "AbortError";
          throw error;
        }
        if (
          owner.sessionId !== context.sessionId ||
          owner.agentId !== context.agentId
        ) {
          throw new ListeningFailure(
            "permission_denied",
            "Listening owner differs from the invoking session and agent",
          );
        }
        const job =
          params.action === "play-arrangement-and-listen"
            ? coordinator.start(
                {
                  mode: "arrangement",
                  listenerIds: params.listenerIds,
                  startBeat: params.startBeat,
                  endBeat: params.endBeat,
                  maximumDurationMs: params.maximumDurationMs,
                },
                owner,
                context.trace,
                context.signal,
              )
            : coordinator.start(
                {
                  mode: "session",
                  listenerIds: params.listenerIds,
                  ...(await awaitListeningBoundary(
                    options.resolveSessionTarget(params.target, context),
                    context.signal,
                  )),
                  durationBeats: params.durationBeats,
                  maximumDurationMs: params.maximumDurationMs,
                },
                owner,
                context.trace,
                context.signal,
              );
        result = { action: params.action, job: publicJob(job) };
      }
      const parsed = listeningOperationResultSchema.parse(result);
      if (parsed.action !== params.action) {
        throw new ListeningFailure(
          "invalid_result",
          "Listening host returned a mismatched action",
        );
      }
      return parsed;
    },
    waitForListeningPass: async (passId, context) => {
      const job = owned(passId, context);
      return coordinator.wait(passId, job.owner);
    },
    shutdown: () => coordinator.shutdown(),
  };
}
