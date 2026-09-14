import { describe, expect, it } from "vitest";

import {
  abletonToolMetadata,
  createAbletonMutationAuthorizer,
  resolveAbletonOperation,
} from "./index.js";

const trackReference = "00000000-0000-4000-8000-000000000001";
const clipReference = "00000000-0000-4000-8000-000000000002";

describe("core domain operation descriptors", () => {
  it("resolves risk and scope from each discriminated action", () => {
    expect(
      resolveAbletonOperation("ableton_scenes", { action: "list" }),
    ).toMatchObject({
      descriptor: {
        operationId: "scenes.list",
        risk: "read",
        mutationTarget: "read",
      },
    });
    const deleteScene = resolveAbletonOperation("ableton_scenes", {
      action: "delete",
      target: {
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000010",
        expectedName: "Verse",
      },
    });

    expect(deleteScene).toMatchObject({
      descriptor: {
        operationId: "scenes.delete",
        risk: "destructive",
        mutationTarget: "session",
      },
    });
    expect(
      deleteScene?.descriptor.resultSchema.safeParse({
        action: "rename",
        scene: {
          ref: { type: "scene", id: "scene-1" },
          index: 0,
          name: "Verse",
          colorIndex: 1,
          tempo: null,
          timeSignatureNumerator: null,
          timeSignatureDenominator: null,
          isTriggered: false,
        },
        previousName: "Intro",
      }).success,
    ).toBe(false);
  });

  it("extracts exact affected track and clip identities", () => {
    const operation = resolveAbletonOperation("ableton_midi_notes", {
      action: "remove",
      target: {
        view: "session",
        track: {
          kind: "regular",
          index: 0,
          expectedReference: trackReference,
          expectedName: "Drums",
        },
        sceneIndex: 0,
        expectedClipReference: clipReference,
        expectedClipName: "Beat",
      },
      noteIds: [1, 2],
    });

    expect(operation).toMatchObject({
      affectedTrackReferences: [trackReference],
      lifecycleIdentity: {
        domain: "midi_notes",
        action: "remove",
        targetKind: "session-clip",
        targetReferences: [trackReference, clipReference],
      },
    });
  });

  it("authorizes read and mutation variants of the same tool independently", () => {
    const authorizer = createAbletonMutationAuthorizer(abletonToolMetadata);
    const context = {
      activeAgentConfig: {
        resolvedTools: [
          "ableton_midi_notes",
          "ableton_tracks",
          "ableton_mixer_routing",
        ],
        editScope: [{ track: { name: "Drums", occurrence: 0 } }],
      },
      editScopeBindings: [
        {
          selector: { track: { name: "Drums", occurrence: 0 } },
          projectId: "project",
          trackReference,
          trackIndex: 0,
          expectedName: "Drums",
        },
      ],
    } as const;
    const target = {
      view: "session" as const,
      track: {
        kind: "regular" as const,
        index: 0,
        expectedReference: trackReference,
        expectedName: "Drums",
      },
      sceneIndex: 0,
      expectedClipReference: clipReference,
      expectedClipName: "Beat",
    };

    expect(
      authorizer.authorize(context, {
        toolName: "ableton_midi_notes",
        args: { action: "query", target },
      }),
    ).toMatchObject({ kind: "allow", mutationTarget: "read" });
    expect(
      authorizer.authorize(context, {
        toolName: "ableton_midi_notes",
        args: { action: "remove", target, noteIds: [1] },
      }),
    ).toMatchObject({
      kind: "allow",
      mutationTarget: "tracks",
      trackReferences: [trackReference],
    });
    expect(
      authorizer.authorize(context, {
        toolName: "ableton_tracks",
        args: {
          action: "set-color",
          target: target.track,
          colorIndex: 12,
        },
      }),
    ).toMatchObject({
      kind: "allow",
      mutationTarget: "tracks",
      trackReferences: [trackReference],
    });
    expect(
      authorizer.authorize(context, {
        toolName: "ableton_mixer_routing",
        args: {
          action: "set-activator",
          target: target.track,
          active: false,
        },
      }),
    ).toMatchObject({
      kind: "allow",
      mutationTarget: "tracks",
      trackReferences: [trackReference],
    });
    expect(
      resolveAbletonOperation("ableton_mixer_routing", {
        action: "set-volume",
        value: {
          target: target.track,
          expectedParameterReference: "00000000-0000-4000-8000-000000000004",
          expectedParameterName: "Track Volume",
          normalizedValue: 0.75,
        },
      })?.lifecycleIdentity,
    ).toMatchObject({
      targetKind: "regular",
      targetReferences: [
        trackReference,
        "00000000-0000-4000-8000-000000000004",
      ],
    });
    expect(
      authorizer.authorize(context, {
        toolName: "ableton_tracks",
        args: {
          action: "set-color",
          target: {
            kind: "return",
            index: 0,
            expectedReference: "00000000-0000-4000-8000-000000000003",
            expectedName: "Return A",
          },
          colorIndex: 12,
        },
      }),
    ).toMatchObject({ kind: "deny", code: "track_scope_required" });
  });
});
