import type { BoundTrackScope } from "@ableton-agent/agent-config";
import { describe, expect, it, vi } from "vitest";

import {
  abletonToolMetadata,
  AbletonMutationAuthorizationError,
  createAbletonMutationAuthorizer,
  createAbletonMutationLockManager,
  runAuthorizedAbletonMutation,
  type AbletonMutationAuthorizationContext,
} from "./index.js";

const drumsReference = "00000000-0000-4000-8000-000000000001";
const bassReference = "00000000-0000-4000-8000-000000000002";
const leadReference = "00000000-0000-4000-8000-000000000003";

function trackBinding(
  name: string,
  occurrence: number,
  trackReference: string,
  trackIndex: number,
): BoundTrackScope {
  return {
    selector: {
      track: {
        name,
        occurrence,
      },
    },
    projectId: "project-test",
    trackReference,
    trackIndex,
    expectedName: name,
  };
}

function sessionContext(
  resolvedTools: readonly string[],
): AbletonMutationAuthorizationContext {
  return {
    activeAgentConfig: {
      resolvedTools: [...resolvedTools],
      editScope: ["session"],
    },
    editScopeBindings: [],
  };
}

function trackContext(
  resolvedTools: readonly string[],
  bindings: readonly BoundTrackScope[],
): AbletonMutationAuthorizationContext {
  return {
    activeAgentConfig: {
      resolvedTools: [...resolvedTools],
      editScope: bindings.map((binding) => binding.selector),
    },
    editScopeBindings: [...bindings],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("Ableton mutation policy", () => {
  it("classifies every tool and leaves unknown tools unresolved", () => {
    expect(
      abletonToolMetadata.map((metadata) => metadata.mutationTarget),
    ).toEqual([
      "read",
      "read",
      "session",
      "session",
      "read",
      "session",
      "session",
      "session",
      "session",
      "track",
      "track",
      "track",
      "track",
      "track",
      "track",
      "tracks",
      "track",
      "track",
      "track",
      "read",
      "track",
      "track",
      "track",
      "track",
      "read",
      "read",
      "read",
      "read",
      "read",
      "read",
      "read",
      "track",
      "track",
      "read",
      "read",
      "read",
      "read",
      "track",
    ]);

    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    expect(authorizer.resolveMutationTarget("ableton_tracks_create")).toBe(
      "session",
    );
    expect(authorizer.resolveMutationTarget("made_up_tool")).toBeUndefined();
  });

  it("denies tools outside the resolvedTools allowlist", () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const result = authorizer.authorize(
      sessionContext(["ableton_tracks_create"]),
      {
        toolName: "ableton_session_inspect",
        args: {},
      },
    );

    expect(result).toEqual({
      kind: "deny",
      code: "tool_not_allowed",
      message:
        "Ableton tool ableton_session_inspect is not present in the agent's resolvedTools allowlist",
    });
  });

  it("requires session scope for global mutations", () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const trackScoped = trackContext(
      ["ableton_tracks_create"],
      [trackBinding("Drums", 0, drumsReference, 0)],
    );

    expect(
      authorizer.authorize(trackScoped, {
        toolName: "ableton_tracks_create",
        args: { kind: "midi" },
      }),
    ).toEqual({
      kind: "deny",
      code: "session_scope_required",
      message:
        "Ableton session edit scope is required for ableton_tracks_create",
    });

    expect(
      authorizer.authorize(sessionContext(["ableton_tracks_create"]), {
        toolName: "ableton_tracks_create",
        args: { kind: "midi" },
      }),
    ).toMatchObject({
      kind: "allow",
      mutationTarget: "session",
      lockScope: { kind: "session" },
    });
  });

  it("authorizes both source and destination track references", () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const bindings = [
      trackBinding("Drums", 0, drumsReference, 0),
      trackBinding("Bass", 0, bassReference, 1),
    ];
    const invocation = {
      toolName: "ableton_clips_duplicate",
      args: {
        index: 0,
        expectedReference: drumsReference,
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000010",
        destinationTrackIndex: 1,
        expectedDestinationTrackReference: bassReference,
        expectedDestinationTrackName: "Bass",
        destinationSceneIndex: 1,
      },
    } as const;

    expect(
      authorizer.authorize(
        trackContext([invocation.toolName], bindings),
        invocation,
      ),
    ).toEqual(
      expect.objectContaining({
        kind: "allow",
        mutationTarget: "tracks",
        trackReferences: [drumsReference, bassReference],
        lockScope: {
          kind: "tracks",
          trackReferences: [drumsReference, bassReference],
        },
      }),
    );

    expect(
      authorizer.authorize(
        trackContext(
          [invocation.toolName],
          [trackBinding("Drums", 0, drumsReference, 0)],
        ),
        invocation,
      ),
    ).toEqual(
      expect.objectContaining({
        kind: "deny",
        code: "track_scope_required",
      }),
    );
  });

  it("denies unknown mutations by default", () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    expect(
      authorizer.authorize(sessionContext([]), {
        toolName: "made_up_tool",
        args: {},
      }),
    ).toEqual({
      kind: "deny",
      code: "unknown_tool",
      message: "Unknown Ableton tool: made_up_tool",
    });
  });

  it("runs reads and disjoint track mutations in parallel", async () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const lockManager = createAbletonMutationLockManager();
    const gate = deferred();
    const started: string[] = [];
    const context = trackContext(
      [
        "ableton_session_inspect",
        "ableton_tracks_rename",
        "ableton_clips_launch",
      ],
      [
        trackBinding("Drums", 0, drumsReference, 0),
        trackBinding("Bass", 0, bassReference, 1),
      ],
    );

    const run = (
      label: string,
      invocation: { toolName: string; args: unknown },
    ) =>
      runAuthorizedAbletonMutation({
        authorizer,
        lockManager,
        getContext: async () => context,
        invocation,
        handler: async () => {
          started.push(label);
          await gate.promise;
          return label;
        },
      });

    const read = run("read", {
      toolName: "ableton_session_inspect",
      args: {},
    });
    const drums = run("drums", {
      toolName: "ableton_tracks_rename",
      args: {
        index: 0,
        expectedReference: drumsReference,
        expectedName: "Drums",
        name: "Drums 2",
      },
    });
    const bass = run("bass", {
      toolName: "ableton_tracks_rename",
      args: {
        index: 1,
        expectedReference: bassReference,
        expectedName: "Bass",
        name: "Bass 2",
      },
    });

    await flushMicrotasks();
    expect(started).toHaveLength(3);
    expect(new Set(started)).toEqual(new Set(["read", "drums", "bass"]));

    gate.resolve();
    await expect(Promise.all([read, drums, bass])).resolves.toEqual([
      "read",
      "drums",
      "bass",
    ]);
  });

  it("serializes overlapping track sets", async () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const lockManager = createAbletonMutationLockManager();
    const gate = deferred();
    const started: string[] = [];
    const context = trackContext(
      ["ableton_clips_duplicate", "ableton_tracks_rename"],
      [
        trackBinding("Drums", 0, drumsReference, 0),
        trackBinding("Bass", 0, bassReference, 1),
      ],
    );

    const first = runAuthorizedAbletonMutation({
      authorizer,
      lockManager,
      getContext: async () => context,
      invocation: {
        toolName: "ableton_clips_duplicate",
        args: {
          index: 0,
          expectedReference: drumsReference,
          expectedName: "Drums",
          sceneIndex: 0,
          expectedClipReference: "00000000-0000-4000-8000-000000000010",
          destinationTrackIndex: 1,
          expectedDestinationTrackReference: bassReference,
          expectedDestinationTrackName: "Bass",
          destinationSceneIndex: 1,
        },
      },
      handler: async () => {
        started.push("duplicate");
        await gate.promise;
        return "duplicate";
      },
    });

    const second = runAuthorizedAbletonMutation({
      authorizer,
      lockManager,
      getContext: async () => context,
      invocation: {
        toolName: "ableton_tracks_rename",
        args: {
          index: 1,
          expectedReference: bassReference,
          expectedName: "Bass",
          name: "Bass 2",
        },
      },
      handler: async () => {
        started.push("rename");
        return "rename";
      },
    });

    await flushMicrotasks();
    expect(started).toEqual(["duplicate"]);

    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "duplicate",
      "rename",
    ]);
  });

  it("serializes session locks against track mutations", async () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const lockManager = createAbletonMutationLockManager();
    const gate = deferred();
    const started: string[] = [];
    const context = sessionContext([
      "ableton_tracks_create",
      "ableton_tracks_rename",
    ]);

    const session = runAuthorizedAbletonMutation({
      authorizer,
      lockManager,
      getContext: async () => context,
      invocation: {
        toolName: "ableton_tracks_create",
        args: { kind: "midi" },
      },
      handler: async () => {
        started.push("session");
        await gate.promise;
        return "session";
      },
    });

    const track = runAuthorizedAbletonMutation({
      authorizer,
      lockManager,
      getContext: async () => context,
      invocation: {
        toolName: "ableton_tracks_rename",
        args: {
          index: 0,
          expectedReference: drumsReference,
          expectedName: "Drums",
          name: "Drums 2",
        },
      },
      handler: async () => {
        started.push("track");
        return "track";
      },
    });

    await flushMicrotasks();
    expect(started).toEqual(["session"]);

    gate.resolve();
    await expect(Promise.all([session, track])).resolves.toEqual([
      "session",
      "track",
    ]);
  });

  it("revalidates after lock acquisition before executing a mutation", async () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const lockManager = createAbletonMutationLockManager();
    const handler = vi.fn(async () => "ok");
    const getContext = vi
      .fn<() => Promise<AbletonMutationAuthorizationContext>>()
      .mockResolvedValueOnce(
        trackContext(
          ["ableton_tracks_rename"],
          [trackBinding("Drums", 0, drumsReference, 0)],
        ),
      )
      .mockResolvedValueOnce(
        trackContext([], [trackBinding("Drums", 0, drumsReference, 0)]),
      );

    await expect(
      runAuthorizedAbletonMutation({
        authorizer,
        lockManager,
        getContext,
        invocation: {
          toolName: "ableton_tracks_rename",
          args: {
            index: 0,
            expectedReference: drumsReference,
            expectedName: "Drums",
            name: "Drums 2",
          },
        },
        handler,
      }),
    ).rejects.toMatchObject({
      code: "scope_changed",
      name: AbletonMutationAuthorizationError.name,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(getContext).toHaveBeenCalledTimes(2);
  });

  it("keeps disjoint track locks concurrent", async () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const lockManager = createAbletonMutationLockManager();
    const gate = deferred();
    const started: string[] = [];
    const context = trackContext(
      ["ableton_tracks_rename"],
      [
        trackBinding("Drums", 0, drumsReference, 0),
        trackBinding("Bass", 0, bassReference, 1),
        trackBinding("Lead", 0, leadReference, 2),
      ],
    );

    const left = runAuthorizedAbletonMutation({
      authorizer,
      lockManager,
      getContext: async () => context,
      invocation: {
        toolName: "ableton_tracks_rename",
        args: {
          index: 0,
          expectedReference: drumsReference,
          expectedName: "Drums",
          name: "Drums 2",
        },
      },
      handler: async () => {
        started.push("left");
        await gate.promise;
        return "left";
      },
    });

    const right = runAuthorizedAbletonMutation({
      authorizer,
      lockManager,
      getContext: async () => context,
      invocation: {
        toolName: "ableton_tracks_rename",
        args: {
          index: 2,
          expectedReference: leadReference,
          expectedName: "Lead",
          name: "Lead 2",
        },
      },
      handler: async () => {
        started.push("right");
        await gate.promise;
        return "right";
      },
    });

    await flushMicrotasks();
    expect(started).toHaveLength(2);
    expect(new Set(started)).toEqual(new Set(["left", "right"]));

    gate.resolve();
    await expect(Promise.all([left, right])).resolves.toEqual([
      "left",
      "right",
    ]);
  });

  it("does not starve a queued session lock behind newer track requests", async () => {
    const lockManager = createAbletonMutationLockManager();
    const initialTrack = await lockManager.acquire({
      kind: "tracks",
      trackReferences: [drumsReference],
    });
    const sessionGate = deferred();
    const sessionStarted = deferred();
    const started: string[] = [];

    const session = lockManager.withLock({ kind: "session" }, async () => {
      started.push("session");
      sessionStarted.resolve();
      await sessionGate.promise;
    });
    const trackStream = Array.from({ length: 100 }, (_, index) =>
      lockManager.withLock(
        {
          kind: "tracks",
          trackReferences: [index % 2 === 0 ? bassReference : leadReference],
        },
        async () => {
          started.push(`track-${index}`);
        },
      ),
    );

    await flushMicrotasks();
    expect(started).toEqual([]);

    initialTrack.release();
    await sessionStarted.promise;
    expect(started).toEqual(["session"]);

    sessionGate.resolve();
    await expect(Promise.all([session, ...trackStream])).resolves.toBeDefined();
    expect(started).toHaveLength(101);
  });

  it("grants safely concurrent track requests queued before a session lock", async () => {
    const lockManager = createAbletonMutationLockManager();
    const activeDrums = await lockManager.acquire({
      kind: "tracks",
      trackReferences: [drumsReference],
    });
    const activeBass = await lockManager.acquire({
      kind: "tracks",
      trackReferences: [bassReference],
    });
    const acquired: string[] = [];

    const queuedDrums = lockManager
      .acquire({
        kind: "tracks",
        trackReferences: [drumsReference],
      })
      .then((handle) => {
        acquired.push("drums");
        return handle;
      });
    const queuedBass = lockManager
      .acquire({
        kind: "tracks",
        trackReferences: [bassReference],
      })
      .then((handle) => {
        acquired.push("bass");
        return handle;
      });
    const session = lockManager.acquire({ kind: "session" }).then((handle) => {
      acquired.push("session");
      return handle;
    });

    activeDrums.release();
    activeBass.release();
    const [drumsHandle, bassHandle] = await Promise.all([
      queuedDrums,
      queuedBass,
    ]);
    expect(new Set(acquired)).toEqual(new Set(["drums", "bass"]));

    drumsHandle.release();
    bassHandle.release();
    const sessionHandle = await session;
    expect(acquired.at(-1)).toBe("session");
    sessionHandle.release();
  });

  it("keeps FIFO order between overlapping track requests", async () => {
    const lockManager = createAbletonMutationLockManager();
    const activeDrums = await lockManager.acquire({
      kind: "tracks",
      trackReferences: [drumsReference],
    });
    const acquired: string[] = [];

    const older = lockManager
      .acquire({
        kind: "tracks",
        trackReferences: [drumsReference, bassReference],
      })
      .then((handle) => {
        acquired.push("older");
        return handle;
      });
    const newer = lockManager
      .acquire({
        kind: "tracks",
        trackReferences: [bassReference],
      })
      .then((handle) => {
        acquired.push("newer");
        return handle;
      });

    await flushMicrotasks();
    expect(acquired).toEqual([]);

    activeDrums.release();
    const olderHandle = await older;
    expect(acquired).toEqual(["older"]);

    olderHandle.release();
    const newerHandle = await newer;
    expect(acquired).toEqual(["older", "newer"]);
    newerHandle.release();
  });

  it("releases a track lock when a mutation callback rejects", async () => {
    const lockManager = createAbletonMutationLockManager();
    const failure = new Error("mutation failed");

    await expect(
      lockManager.withLock(
        {
          kind: "tracks",
          trackReferences: [drumsReference],
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    const handle = await lockManager.acquire({
      kind: "tracks",
      trackReferences: [drumsReference],
    });
    handle.release();
  });
});
