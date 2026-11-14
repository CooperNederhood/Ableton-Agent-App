import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { arrangementTestEvidence } from "./arrangement-test-support.js";
import { runAcceptance } from "./coordinator.js";
import { stageFixture, dependencyInventoryHashes } from "./staging.js";
import type * as Staging from "./staging.js";
import type {
  AcceptanceDriver,
  BaselineEvidence,
  DependencyInventory,
  RunResult,
  ScenarioManifest,
  TurnEvidence,
  SetupAction,
  SetupEvidence,
  ScenarioStep,
  DriverContext,
  LifecycleEvent,
} from "./contracts.js";

// Candidate binding is covered separately; these synthetic inputs exercise admission and receipts.
vi.mock("./staging.js", async (original) => {
  const actual = await original<typeof Staging>();
  return { ...actual, verifyDependencyInventory: vi.fn(async () => undefined) };
});

describe("Arrangement coordinator admission and bounded receipts (synthetic only)", () => {
  it.each([
    "success",
    "missing-source",
    "saved-range",
    "global-record",
    "media",
    "cleanup",
    "redacted-owner",
    "back-success",
    "back-idempotent",
    "back-undeclared",
    "back-missing-evidence",
    "back-wrong-owner",
    "back-wrong-trace",
    "back-failed",
    "back-cancelled",
    "back-postcondition-failed",
  ] as const)(
    "preserves independent evidence and terminal cleanup (%s)",
    async (mode) => {
      const root = resolve(
        ".test-artifacts",
        `arrangement-coordinator-${randomUUID()}`,
      );
      const catalogRoot = join(root, "catalog"),
        candidateRoot = join(root, "candidate"),
        workingRoot = join(root, "working");
      const inputs = arrangementTestEvidence();
      const backCase = mode.startsWith("back-");
      const backDeclared = backCase && mode !== "back-undeclared";
      const controller = new AbortController();
      const calls: string[] = [];
      const events: LifecycleEvent[] = [];
      let backToArrangement = backCase && mode !== "back-idempotent";
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const projectSha256 = digest("synthetic-set"),
        mediaSha256 = digest("synthetic-audio");
      const fixture = {
        ...inputs.fixture,
        resources: [
          {
            path: "input.als",
            target: "project.als",
            sha256: projectSha256,
            bytes: 13,
          },
          {
            path: "input.aif",
            target: "media/resource-001.aif",
            sha256: mediaSha256,
            bytes: 15,
          },
        ],
      };
      const inventory: DependencyInventory = {
        schemaVersion: 1,
        candidateRoot,
        resources: [
          {
            id: "machine-listening",
            path: "listener.amxd",
            target: "dependencies/listener.amxd",
            sha256: digest("synthetic-listener"),
            bytes: 18,
          },
        ],
      };
      const assertion = {
        name: "arrangement-listening",
        parameters: {
          sourceId: "arrangement-source",
          hostSampleRate: 48_000,
          playbackAfterCapture: "stopped",
          "records.level": 1800,
          "records.spectral": 9000,
        },
      };
      const scenario: ScenarioManifest = {
        schemaVersion: 1,
        id: "synthetic-arrangement-case",
        fixtureId: fixture.id,
        requiredCapabilities: ["arrangement-audio"],
        permissions: [],
        budget: { runMs: 5000, cleanupMs: 1000, persistenceMs: 1000 },
        steps: [
          {
            id: "listen",
            message: "Listen to the range.",
            sourceId: "arrangement-source",
            timeoutMs: 1000,
            ...(backDeclared
              ? { setupActions: ["back-to-arrangement" as const] }
              : {}),
            assertions: [assertion],
          },
        ],
        assertions: [assertion],
      };
      const identity = {
        appSessionId: "app-1",
        conversationId: "conversation-1",
        agentId: "agent-1",
      };
      const capture = structuredClone(inputs.capture);
      capture.source.clips.forEach((clip) =>
        Object.assign(clip, { mediaSha256 }),
      );
      capture.metrics.forEach((metric) =>
        metric.source.clips.forEach((clip) =>
          Object.assign(clip, { mediaSha256 }),
        ),
      );
      const observed = structuredClone(inputs.baseline);
      Object.assign(observed, {
        savedProjectSha256: projectSha256,
        loadedProjectSha256: projectSha256,
      });
      observed.source.clips.forEach((clip) =>
        Object.assign(clip, { mediaSha256 }),
      );
      Object.assign(observed.media[0]!, { sha256: mediaSha256 });
      const close = vi.fn(async () => undefined),
        cleanup = vi.fn(async (context: DriverContext) => {
          expect(context.signal.aborted).toBe(false);
        }),
        submit = vi.fn(async () => ({
          ...identity,
          userMessageId: "message-1",
          operationId: "operation-1",
        }));
      let persisted: RunResult | undefined;
      const setup = vi.fn(
        async (
          action: SetupAction,
          step: ScenarioStep,
          context: DriverContext,
        ): Promise<SetupEvidence> => {
          calls.push("setup");
          expect(action).toBe("back-to-arrangement");
          if (mode === "back-failed") throw new Error("Handoff failed");
          if (mode === "back-cancelled") {
            controller.abort(new Error("Handoff cancelled"));
            context.signal.throwIfAborted();
          }
          const before = backToArrangement;
          backToArrangement = false;
          const evidence: SetupEvidence = {
            ...identity,
            action,
            stepId: step.id,
            completed: true,
            traceId: context.traceId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            arrangementSource: {
              command: "transport.back_to_arrangement",
              dispatchedCount: 1,
              beforeBackToArrangement: before,
              afterBackToArrangement: false,
              transportStopped: true,
              verified: true,
            },
          };
          if (mode === "back-missing-evidence")
            Reflect.deleteProperty(evidence, "arrangementSource");
          if (mode === "back-wrong-owner")
            Object.assign(evidence, { agentId: "foreign-agent" });
          if (mode === "back-wrong-trace")
            Object.assign(evidence, { traceId: "foreign-trace" });
          return evidence;
        },
      );
      const driver: AcceptanceDriver = {
        schemaVersion: 1,
        capabilities: ["arrangement-audio"],
        launch: async () => undefined,
        ready: async () => {
          calls.push("ready");
          return identity;
        },
        setup,
        submit,
        subscribe: async () => {
          calls.push("subscribe");
          return {
            close,
            waitForTurn: async (submission) =>
              ({
                schemaVersion: 1,
                ...submission,
                assistantMessageId: "assistant-1",
                terminal: true,
                status: "completed",
                assistantText: "Observed",
                captures: [],
                contexts: [],
                arrangementCaptures: [capture],
                facts: {
                  sdkTurnId: "trace-1",
                  "arrangement.captureCausationId": capture.causationId,
                },
              }) satisfies TurnEvidence,
          };
        },
        readBaseline: async (context) => {
          calls.push("baseline");
          if (backToArrangement)
            throw new Error("Arrangement source was not handed off");
          const path = join(
            context.stagedFixture!.workingDirectory,
            "media/resource-001.aif",
          );
          Object.assign(observed.media[0]!, {
            loadedPath: path,
            ownedPath: path,
          });
          if (mode === "saved-range" || mode === "back-postcondition-failed")
            Object.assign(observed.savedClips[0]!, { endBeat: 15 });
          if (mode === "global-record")
            Reflect.deleteProperty(observed.after, "sessionRecord");
          if (mode === "media")
            Object.assign(observed.media[0]!, {
              loadedPath: "/foreign/audio.aif",
              ownedPath: "/foreign/audio.aif",
            });
          const baseline: BaselineEvidence = {
            schemaVersion: 1,
            facts: fixture.baseline,
            dependencyHashes: dependencyInventoryHashes(inventory),
            arrangementSources:
              mode === "missing-source"
                ? {}
                : { "arrangement-source": observed },
          };
          return baseline;
        },
        collect: async () => ({
          schemaVersion: 1,
          capturePassIds: ["pass-1"],
          facts: {},
          contexts: [],
          unchanged: [],
        }),
        cleanup,
      };
      if (mode === "cleanup")
        Object.assign(capture.cleanup, { captureReleased: false });
      if (mode === "redacted-owner")
        Object.assign(capture, { traceId: "api_key=secret-value" });
      try {
        await mkdir(catalogRoot, { recursive: true });
        await mkdir(candidateRoot);
        await mkdir(workingRoot);
        await writeFile(join(catalogRoot, "input.als"), "synthetic-set");
        await writeFile(join(catalogRoot, "input.aif"), "synthetic-audio");
        await writeFile(
          join(candidateRoot, "listener.amxd"),
          "synthetic-listener",
        );
        const result = await runAcceptance({
          fixture,
          scenario,
          driver,
          signal: controller.signal,
          event: (event) => events.push(event),
          stage: (context) =>
            stageFixture({
              fixture,
              catalogRoot,
              workingRoot,
              runId: context.runId,
              allowSynthetic: true,
              signal: context.signal,
            }),
          provision: async (context) => {
            await mkdir(
              join(context.stagedFixture!.workingDirectory, "dependencies"),
            );
            await writeFile(
              join(
                context.stagedFixture!.workingDirectory,
                "dependencies/listener.amxd",
              ),
              "synthetic-listener",
            );
            return inventory;
          },
          persist: async (receipt) => {
            persisted = receipt;
          },
        });
        expect(cleanup).toHaveBeenCalledOnce();
        expect(
          close,
          JSON.stringify(result.primaryFailure),
        ).toHaveBeenCalledOnce();
        expect(result.cleanupComplete).toBe(true);
        expect(result.persisted).toBe(true);
        expect(persisted).toBeDefined();
        if (
          mode === "success" ||
          mode === "back-success" ||
          mode === "back-idempotent"
        ) {
          expect(
            result,
            JSON.stringify(
              result.primaryFailure ?? result.finalizationFailures,
            ),
          ).toMatchObject({ status: "passed" });
          expect(result.turns[0]!.arrangementCaptures).toEqual([capture]);
          expect(
            result.baseline!.arrangementSources!["arrangement-source"],
          ).toEqual(observed);
        } else {
          expect(result.status).not.toBe("passed");
          if (
            [
              "missing-source",
              "saved-range",
              "global-record",
              "media",
            ].includes(mode)
          )
            expect(submit).not.toHaveBeenCalled();
          if (mode === "redacted-owner")
            expect(JSON.stringify(persisted)).not.toContain("secret-value");
        }
        if (backDeclared) {
          expect(setup).toHaveBeenCalledOnce();
          expect(calls.slice(0, 3)).toEqual(["ready", "subscribe", "setup"]);
          const lifecycle = events.filter(
            (event) => event.stage === "setup.listen.back-to-arrangement",
          );
          expect(lifecycle.map((event) => event.phase)).toEqual([
            "queued",
            "started",
            mode === "back-cancelled"
              ? "cancelled"
              : [
                    "back-failed",
                    "back-missing-evidence",
                    "back-wrong-owner",
                    "back-wrong-trace",
                  ].includes(mode)
                ? "failed"
                : "completed",
          ]);
          expect(
            new Set(lifecycle.map((event) => event.causationId)).size,
          ).toBe(1);
          expect(
            lifecycle.every(
              (event) =>
                event.traceId === result.traceId &&
                event.correlationId === result.runId &&
                event.durationMs >= 0,
            ),
          ).toBe(true);
          if (
            [
              "back-success",
              "back-idempotent",
              "back-postcondition-failed",
            ].includes(mode)
          ) {
            expect(calls[3]).toBe("baseline");
            expect(persisted?.evidence?.setupActions).toHaveLength(1);
            expect(
              persisted?.evidence?.setupActions?.[0]?.arrangementSource,
            ).toMatchObject({
              beforeBackToArrangement: mode !== "back-idempotent",
              afterBackToArrangement: false,
              transportStopped: true,
              verified: true,
              dispatchedCount: 1,
            });
          } else {
            expect(calls).not.toContain("baseline");
            expect(submit).not.toHaveBeenCalled();
            expect(result.primaryFailure?.stage).toBe(
              "setup.listen.back-to-arrangement",
            );
          }
          if (mode === "back-cancelled")
            expect(result.status).toBe("cancelled");
        } else expect(setup).not.toHaveBeenCalled();
        if (mode === "back-undeclared") {
          expect(result.status).toBe("blocked");
          expect(submit).not.toHaveBeenCalled();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
