import { describe, expect, it } from "vitest";

import {
  abletonOperationDescriptors,
  abletonToolMetadata,
  createAbletonMutationAuthorizer,
  resolveAbletonOperation,
} from "./index.js";

const trackReference = "00000000-0000-4000-8000-000000000001";
const clipReference = "00000000-0000-4000-8000-000000000002";

describe("core domain operation descriptors", () => {
  it("describes every consolidated action with canonical routing metadata", () => {
    const consolidatedActions = {
      ableton_session: ["connection-status", "inspect"],
      ableton_tracks: ["create", "rename"],
      ableton_mixer_routing: ["set-track-mixer"],
      ableton_transport: [
        "set-tempo",
        "set-playing",
        "inspect-arrangement",
        "set-arrangement-loop",
        "create-cue-point",
        "delete-cue-point",
      ],
      ableton_session_clips: [
        "create-midi",
        "replace-notes",
        "launch",
        "duplicate",
        "delete",
        "set-properties",
      ],
      ableton_arrangement: [
        "create-midi-clip",
        "inspect",
        "delete-clip",
        "replace-notes",
        "duplicate-clip",
        "fill-region",
        "set-clip-properties",
      ],
      ableton_devices: [
        "inspect",
        "inspect-parameters",
        "inspect-rack-chains",
        "inspect-rack-chain-devices",
        "inspect-drum-rack-pads",
        "inspect-drum-pad-chains",
        "inspect-drum-pad-chain-devices",
        "inspect-chain-mixer",
        "find-position",
        "move",
        "set-chain-properties",
        "set-chain-mixer",
        "set-enabled",
        "set-parameter",
      ],
      ableton_browser: [
        "roots",
        "children",
        "search",
        "search-external-plugins",
        "load-item",
      ],
    } as const;

    for (const [toolName, actions] of Object.entries(consolidatedActions)) {
      const actionNames: readonly string[] = actions;
      const descriptors = abletonOperationDescriptors.filter(
        (descriptor) =>
          descriptor.toolName === toolName &&
          actionNames.includes(descriptor.action),
      );
      expect(
        descriptors.map(({ action }) => action),
        toolName,
      ).toEqual(actions);
      for (const descriptor of descriptors) {
        expect(descriptor.requiredCapability, descriptor.action).not.toBe("");
        expect(descriptor.protocolCommand, descriptor.action).not.toBe("");
        expect(descriptor.lifecycleEvents, descriptor.action).toMatchObject({
          queued: "agent.operation.queued",
          started: "agent.operation.started",
          progress: "workflow_job.progress",
          completed: "agent.operation.completed",
          failed: "agent.operation.failed",
          cancelled: "agent.operation.cancelled",
        });
      }
    }

    expect(
      resolveAbletonOperation("ableton_transport", {
        action: "set-tempo",
        tempo: 128,
      })?.descriptor,
    ).toMatchObject({
      operationId: "transport.set_tempo",
      requiredCapability: "transport.set_tempo",
      protocolCommand: "transport.set_tempo",
      risk: "reversible",
      duration: "instant",
      mutationTarget: "session",
      editScope: "session",
    });
    expect(
      resolveAbletonOperation("ableton_arrangement", {
        action: "fill-region",
        index: 0,
        expectedReference: trackReference,
        expectedName: "Drums",
        sceneIndex: 0,
        expectedClipReference: clipReference,
        regionStart: 0,
        regionEnd: 16,
      }),
    ).toMatchObject({
      descriptor: {
        operationId: "arrangement.fill_region",
        handlerBinding: "fillArrangementRegion",
        requiredCapability: "arrangement.fill_region",
        protocolCommand: "arrangement.fill_region",
        risk: "reversible",
        duration: "long",
        mutationTarget: "track",
        editScope: "affected-tracks",
      },
      affectedTrackReferences: [trackReference],
      lifecycleIdentity: {
        domain: "arrangement",
        action: "fill-region",
        targetKind: "arrangement-region",
        targetReferences: [trackReference, clipReference],
      },
    });
  });

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
      descriptor: {
        risk: "destructive",
      },
      metadata: {
        risk: "destructive",
      },
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
