import { z } from "zod";
import { sanitizePersistedText } from "@ableton-agent/observability";
import {
  listeningOperationParamsSchema,
  listeningOperationResultSchema,
  listeningJobSchema,
  type ListeningOperationParams,
  type ListeningOperationResult,
  type ListeningJobView,
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
  listeningFailureFact as fact,
  recordListeningAttemptFailure,
  type ListeningCoordinatorOptions,
  type ListeningJob,
  type ListeningOwner,
  type ListeningRequest,
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
  ) => Promise<{
    clipReference: string;
    trackReference: string;
    target?: NonNullable<
      Extract<ListeningRequest, { mode: "session" }>["target"]
    >;
  }>;
}

const cursorSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  passId: z.string().min(1).max(256),
});

function schemaRejectionFacts(error: z.ZodError, input: unknown) {
  return [
    fact("schemaIssueCount", error.issues.length, 0),
    ...error.issues.slice(0, 7).flatMap((issue, index) => {
      let actual = input;
      for (const part of issue.path) {
        actual =
          actual !== null &&
          typeof actual === "object" &&
          typeof part !== "symbol" &&
          Object.hasOwn(actual, part)
            ? (actual as Record<string | number, unknown>)[part]
            : undefined;
      }
      const expected =
        issue.code === "too_big"
          ? issue.maximum
          : issue.code === "too_small"
            ? issue.minimum
            : issue.code === "invalid_type"
              ? issue.expected
              : undefined;
      return [
        fact(`issue.${index}.code`, issue.code),
        fact(`issue.${index}.path`, issue.path.map(String).join(".")),
        fact(
          `issue.${index}.value`,
          Array.isArray(actual) ? actual.length : actual,
          typeof expected === "bigint" ? undefined : expected,
          issue.code === "too_big"
            ? "at-most"
            : issue.code === "too_small"
              ? "at-least"
              : "matches",
        ),
      ];
    }),
  ];
}

function publicJob(job: ListeningJob) {
  return {
    passId: job.passId,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    durationMs: job.durationMs,
    contextIds: [...job.contextIds],
    ...(job.metricResults === undefined
      ? {}
      : {
          metricResults: job.metricResults.map((result) =>
            structuredClone(result),
          ),
        }),
    ...(job.session === undefined ? {} : { session: job.session }),
    ...(job.cleanupPolicy === undefined
      ? {}
      : { cleanupPolicy: job.cleanupPolicy }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.failureEvidence === undefined
      ? {}
      : { failureEvidence: job.failureEvidence }),
  };
}

/** One coordinator/transport owner per host, with caller-scoped typed queries. */
export function createListeningHost(options: ListeningHostOptions): Required<
  Pick<CopilotAgentServiceOptions, "executeListeningOperation">
> & {
  waitForListeningPass(
    passId: string,
    context: ListeningExecutionContext,
  ): Promise<ListeningJobView>;
  shutdown(): Promise<void>;
} {
  const jobs = new Map<string, ListeningJob>();
  const coordinator = new ListeningCoordinator({
    ...options,
    onChange: (job) => {
      jobs.set(job.passId, job);
      while (jobs.size > listeningLimits.maxJobs) {
        const oldest = [...jobs].find(([, item]) =>
          [
            "completed",
            "partial",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(item.stage),
        );
        if (oldest === undefined) {
          throw new ListeningFailure(
            "quota_exceeded",
            "Listening job inventory is full",
            {
              checkId: "application.host.inventory-quota",
              facts: [
                fact("jobCount", jobs.size, listeningLimits.maxJobs, "at-most"),
                fact("evictableJobCount", 0, 1, "at-least"),
              ],
            },
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
        {
          checkId: "application.host.pass-owner",
          facts: [
            fact("passExists", job !== undefined, true),
            fact(
              "sessionMatches",
              job?.owner.sessionId === context.sessionId,
              true,
            ),
            fact("agentMatches", job?.owner.agentId === context.agentId, true),
          ],
        },
      );
    }
    return job;
  };
  return {
    executeListeningOperation: async (input, context) => {
      const startedAt = (options.now ?? Date.now)();
      let schemaInput: unknown = input;
      let checkId = "application.host.input-schema";
      let coordinatorAdmission = false;
      try {
        const params = listeningOperationParamsSchema.parse(input);
        checkId = `application.host.${params.action}`;
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
                {
                  checkId: "application.host.cursor-schema",
                  facts: [
                    fact("cursorLength", params.cursor.length, 2048, "at-most"),
                    fact("validCursor", false, true),
                  ],
                },
              );
            }
            if (
              cursor.sessionId !== context.sessionId ||
              cursor.agentId !== context.agentId
            ) {
              throw new ListeningFailure(
                "permission_denied",
                "Listening cursor belongs to another session or agent",
                {
                  checkId: "application.host.cursor-owner",
                  facts: [
                    fact(
                      "sessionMatches",
                      cursor.sessionId === context.sessionId,
                      true,
                    ),
                    fact(
                      "agentMatches",
                      cursor.agentId === context.agentId,
                      true,
                    ),
                  ],
                },
              );
            }
            const index = available.findIndex(
              ({ passId }) => passId === cursor.passId,
            );
            if (index < 0) {
              throw new ListeningFailure(
                "stale_reference",
                "Listening cursor has expired; restart the query",
                {
                  checkId: "application.host.cursor-present",
                  facts: [fact("cursorIndex", index, 0, "at-least")],
                },
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
              {
                checkId: "application.host.initiating-agent",
                facts: [fact("actorKind", context.actorKind, "agent")],
              },
            );
          }
          checkId = "application.host.resolve-owner";
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
              {
                checkId: "application.host.resolved-owner",
                facts: [
                  fact("sessionId", owner.sessionId, context.sessionId),
                  fact("agentId", owner.agentId, context.agentId),
                ],
              },
            );
          }
          // Resolve the Session target before admission, without manufacturing a pass.
          checkId = "application.host.session-target";
          const sessionTarget =
            params.action === "play-session-and-listen"
              ? await awaitListeningBoundary(
                  options.resolveSessionTarget(params.target, context),
                  context.signal,
                )
              : undefined;
          coordinatorAdmission = true;
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
                    ...sessionTarget!,
                    ...(params.durationBeats === undefined
                      ? {}
                      : { durationBeats: params.durationBeats }),
                    maximumDurationMs: params.maximumDurationMs,
                  },
                  owner,
                  context.trace,
                  context.signal,
                );
          result = { action: params.action, job: publicJob(job) };
          coordinatorAdmission = false;
        }
        checkId = "application.host.result-schema";
        schemaInput = result;
        const parsed = listeningOperationResultSchema.parse(result);
        if (parsed.action !== params.action) {
          throw new ListeningFailure(
            "invalid_result",
            "Listening host returned a mismatched action",
            {
              checkId: "application.host.result-action",
              facts: [fact("action", parsed.action, params.action)],
            },
          );
        }
        // Coordinator jobs have already been sanitized, including structured
        // evidence. Inspection is the other service-owned public boundary.
        if (parsed.action !== "inspect-listeners") return parsed;
        const sanitize = (value: unknown): unknown => {
          if (typeof value === "string") return sanitizePersistedText(value);
          if (Array.isArray(value)) return value.map(sanitize);
          if (value !== null && typeof value === "object") {
            return Object.fromEntries(
              Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .map(([key, item]) => [key, sanitize(item)]),
            );
          }
          return value;
        };
        return listeningOperationResultSchema.parse(sanitize(parsed));
      } catch (error) {
        if (!coordinatorAdmission)
          recordListeningAttemptFailure(
            options,
            error,
            context,
            context.trace,
            startedAt,
            {
              checkId,
              facts:
                error instanceof z.ZodError
                  ? schemaRejectionFacts(error, schemaInput)
                  : [],
            },
          );
        throw error;
      }
    },
    waitForListeningPass: async (passId, context) => {
      const startedAt = (options.now ?? Date.now)();
      try {
        const job = owned(passId, context);
        return listeningJobSchema.parse(
          publicJob(await coordinator.wait(passId, job.owner)),
        );
      } catch (error) {
        recordListeningAttemptFailure(
          options,
          error,
          context,
          context.trace,
          startedAt,
        );
        throw error;
      }
    },
    shutdown: () => coordinator.shutdown(),
  };
}
