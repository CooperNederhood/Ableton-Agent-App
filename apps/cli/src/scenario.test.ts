import { describe, expect, it } from "vitest";

import type { HeadlessApplication } from "@ableton-agent/application";
import type { SessionSnapshot } from "@ableton-agent/protocol";
import { abletonToolMetadata } from "@ableton-agent/tools";
import type { ToolApprovalRequest } from "@ableton-agent/tools";

import {
  createScenarioRunContext,
  loadScenarioManifest,
  sanitizeTraceValue,
  scenarioManifestSchema,
  scenarioPrompt,
  verifyScenario,
} from "./scenario.js";

function request(
  name: string,
  risk: ToolApprovalRequest["metadata"]["risk"],
  arguments_: Record<string, unknown>,
): ToolApprovalRequest {
  const metadata = abletonToolMetadata.find((entry) => entry.name === name);
  if (!metadata) {
    throw new Error(`Unknown tool metadata: ${name}`);
  }
  if (metadata.risk !== risk) {
    throw new Error(`Unexpected risk for ${name}`);
  }
  return {
    metadata,
    arguments: arguments_,
  };
}

describe("integration scenarios", () => {
  it("loads reviewed manifests and injects unique artifact names", async () => {
    const manifest = await loadScenarioManifest("808-track");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(context.trackNames).toHaveLength(1);
    expect(context.trackNames[0]).toMatch(/^AA_SMOKE_808_/);
    expect(prompt).toContain(context.trackNames[0]);
  });

  it("loads every read-only inspection manifest", async () => {
    for (const id of [
      "connection-and-session",
      "transport-inspection",
      "browser-bounds",
      "capability-surface",
    ]) {
      const manifest = await loadScenarioManifest(id);
      expect(manifest.group).toBe("inspection");
      expect(manifest.maxMutations).toBe(0);
    }
  });

  it("states the exact reviewed MIDI pattern and identity fields", async () => {
    const manifest = await loadScenarioManifest("four-on-floor");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(prompt).toContain("exactly 4 notes and no others");
    expect(prompt).toContain("pitch 36, starts 0, 1, 2, 3");
    expect(prompt).toContain(
      `expectedName is the track name "${context.trackNames[0]}"`,
    );
  });

  it("enforces ordering, names, item identity, and budgets", async () => {
    const manifest = await loadScenarioManifest("808-track");
    const context = createScenarioRunContext(manifest);
    const trackName = context.trackNames[0]!;

    expect(
      await context.approvals.request(
        request("ableton_tracks_create", "reversible", {
          kind: "midi",
          name: trackName,
        }),
      ),
    ).toBe(false);
    expect(
      await context.approvals.request(
        request("ableton_browser_search", "read", { query: "808" }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_tracks_create", "reversible", {
          kind: "midi",
          name: trackName,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_browser_load_item", "reversible", {
          index: 0,
          expectedName: trackName,
          expectedItemName: "Not the reviewed preset.adg",
        }),
      ),
    ).toBe(false);
  });

  it("binds reviewed Browser fixtures to their intended tracks", async () => {
    const manifest = await loadScenarioManifest("piano-and-string-bass");
    const context = createScenarioRunContext(manifest);
    const prompt = scenarioPrompt(manifest.prompt, context);

    expect(prompt).toContain('Browser item "Childhood Home Piano.adg"');
    expect(prompt).toContain('Browser item "Upright Bass.adv"');
    expect(
      await context.approvals.request(
        request("ableton_browser_search", "read", { query: "piano" }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_tracks_create", "reversible", {
          kind: "midi",
          name: context.trackNames[0],
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_browser_load_item", "reversible", {
          expectedName: context.trackNames[1],
          expectedItemName: "Childhood Home Piano.adg",
        }),
      ),
    ).toBe(false);
    expect(
      await context.approvals.request(
        request("ableton_browser_load_item", "reversible", {
          expectedName: context.trackNames[0],
          expectedItemName: "Childhood Home Piano.adg",
        }),
      ),
    ).toBe(true);
  });

  it("guards and verifies exact Arrangement MIDI patterns", async () => {
    const manifest = scenarioManifestSchema.parse({
      formatVersion: 1,
      id: "arrangement-pattern",
      group: "arrangement",
      prompt: "Create an Arrangement pattern",
      artifactPrefix: "AA_SMOKE_ARR_",
      allowedTools: [
        "ableton_arrangement_create_midi_clip",
        "ableton_arrangement_replace_notes",
      ],
      allowedRisks: ["reversible", "destructive"],
      maxToolCalls: 4,
      maxMutations: 2,
      timeoutMs: 60_000,
      trackNameSuffixes: ["Drums"],
      clipNameSuffixes: ["Beat"],
      assertions: [
        {
          type: "arrangement-midi-pattern",
          trackNameSuffix: "Drums",
          clipNameSuffix: "Beat",
          startTime: 8,
          length: 4,
          pitch: 36,
          starts: [0, 1, 2, 3],
          duration: 0.25,
          velocity: 110,
        },
      ],
    });
    const context = createScenarioRunContext(manifest);
    const trackName = context.trackNames[0]!;
    const clipName = context.clipNames[0]!;
    const notes = [0, 1, 2, 3].map((startTime) => ({
      pitch: 36,
      startTime,
      duration: 0.25,
      velocity: 110,
      mute: false,
    }));

    expect(
      await context.approvals.request(
        request("ableton_arrangement_replace_notes", "destructive", {
          expectedName: trackName,
          notes,
        }),
      ),
    ).toBe(true);
    expect(
      await context.approvals.request(
        request("ableton_arrangement_replace_notes", "destructive", {
          expectedName: trackName,
          notes: [...notes, { ...notes[0]!, startTime: 3.5 }],
        }),
      ),
    ).toBe(false);

    const trackReference = "00000000-0000-4000-8000-000000000001";
    const clipReference = "00000000-0000-4000-8000-000000000002";
    const baseline: SessionSnapshot = {
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 0,
      tracks: [],
      clips: [],
    };
    const snapshot: SessionSnapshot = {
      ...baseline,
      trackCount: 1,
      tracks: [
        {
          index: 0,
          reference: trackReference,
          name: trackName,
          kind: "midi",
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.85,
          pan: 0,
        },
      ],
    };
    const application = {
      inspectSession: async () => snapshot,
      inspectArrangement: async () => ({
        clips: [
          {
            reference: clipReference,
            trackReference,
            trackIndex: 0,
            name: clipName,
            kind: "midi" as const,
            startTime: 8,
            endTime: 12,
            length: 4,
            noteCount: 4,
          },
        ],
        total: 1,
        offset: 0,
        limit: 512,
      }),
      inspectArrangementMidiNotes: async () => ({
        clip: {
          reference: clipReference,
          trackReference,
          trackIndex: 0,
          name: clipName,
          kind: "midi" as const,
          startTime: 8,
          endTime: 12,
          length: 4,
          noteCount: 4,
        },
        notes,
        totalNotes: 4,
        offset: 0,
        limit: 2048,
        truncated: false,
      }),
    } as unknown as HeadlessApplication;

    await expect(
      verifyScenario(application, context, baseline),
    ).resolves.toEqual([
      expect.objectContaining({
        assertion: "arrangement-midi-pattern",
        passed: true,
      }),
    ]);
  });

  it("verifies read-only capability and tool-call scenarios", async () => {
    const manifest = scenarioManifestSchema.parse({
      formatVersion: 1,
      id: "inspection",
      group: "inspection",
      prompt: "Inspect Live",
      artifactPrefix: "AA_SMOKE_INSPECT_",
      allowedTools: ["ableton_connection_status", "ableton_session_inspect"],
      allowedRisks: ["read"],
      maxToolCalls: 2,
      maxMutations: 0,
      timeoutMs: 60_000,
      assertions: [
        {
          type: "connection-capabilities",
          requiredCapabilities: ["session.inspect"],
        },
        { type: "session-unchanged" },
        {
          type: "tool-calls",
          required: [
            { toolName: "ableton_connection_status", min: 1, max: 1 },
            { toolName: "ableton_session_inspect", min: 1, max: 1 },
          ],
        },
      ],
    });
    const context = createScenarioRunContext(manifest);
    await context.approvals.request(
      request("ableton_connection_status", "read", {}),
    );
    await context.approvals.request(
      request("ableton_session_inspect", "read", {}),
    );
    const snapshot: SessionSnapshot = {
      tempo: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 0,
      tracks: [],
      clips: [],
    };
    const application = {
      inspectSession: async () => snapshot,
      getStatus: async () => ({
        state: "connected" as const,
        liveVersion: "11.3.43",
        remoteScriptVersion: "0.4.1",
        projectId: "project",
      }),
      getCapabilities: async () => ({
        capabilities: { "session.inspect": true },
      }),
    } as unknown as HeadlessApplication;

    const results = await verifyScenario(
      application,
      context,
      structuredClone(snapshot),
    );
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("redacts secrets, paths, and non-generated project names", () => {
    expect(
      sanitizeTraceValue({
        token: "secret",
        filePath: "/Users/example/project.als",
        name: "User Bass",
        generatedName: "AA_SMOKE_808_run_808 Drums",
        result: JSON.stringify({ name: "User Drums", noteCount: 4 }),
      }),
    ).toEqual({
      token: "[redacted]",
      filePath: "[path-redacted]",
      name: "[name-redacted]",
      generatedName: "AA_SMOKE_808_run_808 Drums",
      result: { name: "[name-redacted]", noteCount: 4 },
    });
  });
});
