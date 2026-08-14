import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { HeadlessApplication } from "@ableton-agent/application";
import type { SessionSnapshot } from "@ableton-agent/protocol";
import type { ToolApprovalRequest, ToolRisk } from "@ableton-agent/tools";
import { z } from "zod";

const riskSchema = z.enum(["read", "reversible", "destructive", "broad"]);
const orderingSchema = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
});
const trackDeviceAssertionSchema = z.object({
  type: z.literal("track-device"),
  trackNameSuffix: z.string().min(1),
  trackKind: z.enum(["midi", "audio"]),
  deviceName: z.string().min(1),
});
const midiPatternFields = {
  trackNameSuffix: z.string().min(1),
  clipNameSuffix: z.string().min(1),
  pitch: z.number().int().min(0).max(127),
  starts: z.array(z.number().nonnegative()).min(1).max(128),
  duration: z.number().positive(),
  velocity: z.number().int().min(1).max(127),
} as const;
const sessionMidiPatternAssertionSchema = z.object({
  type: z.literal("session-midi-pattern"),
  ...midiPatternFields,
  sceneIndex: z.number().int().nonnegative(),
});
const arrangementMidiPatternAssertionSchema = z.object({
  type: z.literal("arrangement-midi-pattern"),
  ...midiPatternFields,
  startTime: z.number().nonnegative(),
  length: z.number().positive(),
});
const connectionCapabilitiesAssertionSchema = z.object({
  type: z.literal("connection-capabilities"),
  requiredCapabilities: z.array(z.string().min(1)).min(1).max(128),
});
const sessionUnchangedAssertionSchema = z.object({
  type: z.literal("session-unchanged"),
});
const toolCallsAssertionSchema = z.object({
  type: z.literal("tool-calls"),
  required: z
    .array(
      z.object({
        toolName: z.string().min(1),
        min: z.number().int().nonnegative().default(1),
        max: z.number().int().positive().default(1),
      }),
    )
    .min(1)
    .max(64),
});
const trackLifecycleAssertionSchema = z.object({
  type: z.literal("track-lifecycle"),
  initialNameSuffix: z.string().min(1),
  finalNameSuffix: z.string().min(1),
  trackKind: z.enum(["midi", "audio"]),
  mixer: z
    .object({
      isMuted: z.boolean(),
      isSoloed: z.boolean(),
      isArmed: z.boolean(),
      volume: z.number().min(0).max(1),
      pan: z.number().min(-1).max(1),
    })
    .strict(),
});
const sessionClipLifecycleAssertionSchema = z.object({
  type: z.literal("session-clip-lifecycle"),
  trackNameSuffix: z.string().min(1),
  initialClipNameSuffix: z.string().min(1),
  finalClipNameSuffix: z.string().min(1),
  sourceSceneIndex: z.number().int().nonnegative(),
  destinationSceneIndex: z.number().int().nonnegative(),
  length: z.number().positive(),
  properties: z
    .object({
      muted: z.boolean(),
      looping: z.boolean(),
    })
    .strict(),
});

export const scenarioManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    group: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    prompt: z.string().min(1),
    artifactPrefix: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(32),
    allowedTools: z.array(z.string().min(1)).min(1),
    allowedRisks: z.array(riskSchema).min(1),
    maxToolCalls: z.number().int().positive().max(64),
    maxMutations: z.number().int().nonnegative().max(32),
    timeoutMs: z.number().int().min(10_000).max(600_000),
    expectedOutcome: z.enum(["pass", "expected-denial"]).default("pass"),
    unsupportedCapabilities: z.array(z.string().min(1)).max(32).default([]),
    ordering: z.array(orderingSchema).default([]),
    trackNameSuffixes: z.array(z.string().min(1)).max(8).default([]),
    clipNameSuffixes: z.array(z.string().min(1)).max(8).default([]),
    browserItemNames: z.array(z.string().min(1)).max(16).default([]),
    browserLoadTargets: z
      .array(
        z
          .object({
            trackNameSuffix: z.string().min(1),
            itemName: z.string().min(1),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    assertions: z
      .array(
        z.discriminatedUnion("type", [
          trackDeviceAssertionSchema,
          sessionMidiPatternAssertionSchema,
          arrangementMidiPatternAssertionSchema,
          connectionCapabilitiesAssertionSchema,
          sessionUnchangedAssertionSchema,
          toolCallsAssertionSchema,
          trackLifecycleAssertionSchema,
          sessionClipLifecycleAssertionSchema,
        ]),
      )
      .min(1),
  })
  .strict();

export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;

export interface ApprovalDecision {
  sequence: number;
  toolName: string;
  risk: ToolRisk;
  approved: boolean;
  reason: string;
  arguments: unknown;
}

export interface ScenarioAssertionResult {
  assertion: string;
  passed: boolean;
  message: string;
  evidence?: unknown;
}

export interface ScenarioRunContext {
  manifest: ScenarioManifest;
  artifactPrefix: string;
  trackNames: readonly string[];
  clipNames: readonly string[];
  approvals: ScenarioApprovalController;
}

export async function loadScenarioManifest(
  id: string,
  baseDirectory = process.cwd(),
): Promise<ScenarioManifest> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid scenario ID: ${id}`);
  }
  const path = resolve(
    baseDirectory,
    "integration",
    "live-scenarios",
    `${id}.json`,
  );
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const manifest = scenarioManifestSchema.parse(parsed);
  if (manifest.id !== id) {
    throw new Error(`Scenario file '${id}' declares ID '${manifest.id}'`);
  }
  validateManifestSafety(manifest);
  return manifest;
}

function validateManifestSafety(manifest: ScenarioManifest): void {
  const allowedTools = new Set(manifest.allowedTools);
  for (const constraint of manifest.ordering) {
    if (
      !allowedTools.has(constraint.before) ||
      !allowedTools.has(constraint.after)
    ) {
      throw new Error(
        `Scenario '${manifest.id}' ordering references a non-allowlisted tool`,
      );
    }
  }
  if (
    manifest.allowedRisks.includes("broad") ||
    manifest.allowedTools.some((tool) => !tool.startsWith("ableton_"))
  ) {
    throw new Error(
      `Scenario '${manifest.id}' contains an unsafe broad or non-Ableton permission`,
    );
  }
}

export function createScenarioRunContext(
  manifest: ScenarioManifest,
): ScenarioRunContext {
  const runToken = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const artifactPrefix = `${manifest.artifactPrefix}${runToken}_`;
  const trackNames = manifest.trackNameSuffixes.map(
    (suffix) => `${artifactPrefix}${suffix}`,
  );
  const clipNames = manifest.clipNameSuffixes.map(
    (suffix) => `${artifactPrefix}${suffix}`,
  );
  const context = {
    manifest,
    artifactPrefix,
    trackNames,
    clipNames,
  };
  return {
    ...context,
    approvals: new ScenarioApprovalController(context),
  };
}

export function scenarioPrompt(
  prompt: string,
  context: ScenarioRunContext,
): string {
  const naming = [
    ...context.trackNames.map((name) => `track "${name}"`),
    ...context.clipNames.map((name) => `clip "${name}"`),
  ].join(", ");
  const assertionInstructions = context.manifest.assertions.flatMap(
    (assertion) => {
      if (
        assertion.type !== "session-midi-pattern" &&
        assertion.type !== "arrangement-midi-pattern" &&
        assertion.type !== "track-lifecycle" &&
        assertion.type !== "session-clip-lifecycle"
      ) {
        return [];
      }
      if (assertion.type === "track-lifecycle") {
        const initialName = `${context.artifactPrefix}${assertion.initialNameSuffix}`;
        const finalName = `${context.artifactPrefix}${assertion.finalNameSuffix}`;
        return [
          `Create exactly one ${assertion.trackKind} track named "${initialName}", rename that same track to "${finalName}", set its mixer to ${JSON.stringify(assertion.mixer)}, verify the result, then delete that same generated track.`,
          "Do not delete or modify any pre-existing track.",
        ];
      }
      if (assertion.type === "session-clip-lifecycle") {
        const trackName = `${context.artifactPrefix}${assertion.trackNameSuffix}`;
        const initialClipName = `${context.artifactPrefix}${assertion.initialClipNameSuffix}`;
        const finalClipName = `${context.artifactPrefix}${assertion.finalClipNameSuffix}`;
        return [
          `Create exactly one MIDI track "${trackName}" and one ${assertion.length}-beat Session MIDI clip "${initialClipName}" in scene ${assertion.sourceSceneIndex}.`,
          `Launch the active source clip once, verify it triggered or started, stop transport with ableton_transport_set_playing, then rename it to "${finalClipName}", set muted ${assertion.properties.muted} and looping ${assertion.properties.looping}, duplicate it on the same track to scene ${assertion.destinationSceneIndex}, then delete both generated clips and the generated track.`,
          "Use the returned identity references for every dependent operation and inspect when needed; do not touch pre-existing clips or tracks.",
        ];
      }
      const trackName = `${context.artifactPrefix}${assertion.trackNameSuffix}`;
      const clipName = `${context.artifactPrefix}${assertion.clipNameSuffix}`;
      const toolName =
        assertion.type === "session-midi-pattern"
          ? "ableton_clips_replace_notes"
          : "ableton_arrangement_replace_notes";
      return [
        `The MIDI clip must contain exactly ${assertion.starts.length} notes and no others: pitch ${assertion.pitch}, starts ${assertion.starts.join(", ")}, duration ${assertion.duration}, velocity ${assertion.velocity}, mute false.`,
        `For ${toolName}, expectedName is the track name "${trackName}", while expectedClipReference identifies clip "${clipName}".`,
      ];
    },
  );
  const browserLoadInstructions = context.manifest.browserLoadTargets.map(
    (target) =>
      `Resolve and load Browser item "${target.itemName}" onto track "${context.artifactPrefix}${target.trackNameSuffix}".`,
  );
  return [
    prompt,
    "",
    `[Integration scenario ${context.manifest.id}]`,
    ...(naming.length > 0
      ? [`Use these exact generated artifact names: ${naming}.`]
      : []),
    "Do not create, rename, mutate, or delete any other user artifacts.",
    "Run dependent tools sequentially: wait for each completed tool result before requesting the next dependent operation.",
    ...browserLoadInstructions,
    ...assertionInstructions,
    "Inspect after uncertain outcomes; never repeat an unchanged mutation.",
  ].join("\n");
}

export class ScenarioApprovalController {
  readonly decisions: ApprovalDecision[] = [];
  readonly #approvedTools: string[] = [];
  readonly #trackNames: ReadonlySet<string>;
  readonly #clipNames: ReadonlySet<string>;

  public constructor(
    private readonly context: Omit<ScenarioRunContext, "approvals">,
  ) {
    this.#trackNames = new Set(context.trackNames);
    this.#clipNames = new Set(context.clipNames);
  }

  public request = async (request: ToolApprovalRequest): Promise<boolean> => {
    const reason = this.#decisionReason(request);
    const approved = reason === "approved";
    this.decisions.push({
      sequence: this.decisions.length + 1,
      toolName: request.metadata.name,
      risk: request.metadata.risk,
      approved,
      reason,
      arguments: sanitizeTraceValue(request.arguments),
    });
    if (approved) this.#approvedTools.push(request.metadata.name);
    return approved;
  };

  #decisionReason(request: ToolApprovalRequest): string {
    const { manifest } = this.context;
    const toolName = request.metadata.name;
    if (!manifest.allowedTools.includes(toolName))
      return "tool_not_allowlisted";
    if (!manifest.allowedRisks.includes(request.metadata.risk)) {
      return "risk_not_allowlisted";
    }
    if (this.decisions.length >= manifest.maxToolCalls) {
      return "tool_budget_exhausted";
    }
    const mutationCount = this.decisions.filter(
      (decision) => decision.approved && decision.risk !== "read",
    ).length;
    if (
      request.metadata.risk !== "read" &&
      mutationCount >= manifest.maxMutations
    ) {
      return "mutation_budget_exhausted";
    }
    for (const constraint of manifest.ordering) {
      if (
        constraint.after === toolName &&
        !this.#approvedTools.includes(constraint.before)
      ) {
        return `ordering_requires_${constraint.before}`;
      }
    }
    return this.#argumentsAllowed(toolName, request.arguments)
      ? "approved"
      : "argument_guard_rejected";
  }

  #argumentsAllowed(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): boolean {
    const lifecycle = this.context.manifest.assertions.find(
      (assertion) => assertion.type === "track-lifecycle",
    );
    if (lifecycle) {
      const initialName = `${this.context.artifactPrefix}${lifecycle.initialNameSuffix}`;
      const finalName = `${this.context.artifactPrefix}${lifecycle.finalNameSuffix}`;
      if (
        toolName === "ableton_tracks_create" &&
        (args.name !== initialName || args.kind !== lifecycle.trackKind)
      ) {
        return false;
      }
      if (
        toolName === "ableton_tracks_rename" &&
        (args.expectedName !== initialName || args.name !== finalName)
      ) {
        return false;
      }
      if (
        toolName === "ableton_tracks_set_mixer" &&
        (args.expectedName !== finalName ||
          Object.entries(lifecycle.mixer).some(
            ([key, value]) => args[key] !== value,
          ))
      ) {
        return false;
      }
      if (
        toolName === "ableton_tracks_delete" &&
        (args.expectedName !== finalName ||
          args.expectedKind !== lifecycle.trackKind)
      ) {
        return false;
      }
    }
    const sessionLifecycle = this.context.manifest.assertions.find(
      (assertion) => assertion.type === "session-clip-lifecycle",
    );
    if (sessionLifecycle) {
      const trackName = `${this.context.artifactPrefix}${sessionLifecycle.trackNameSuffix}`;
      const initialClipName = `${this.context.artifactPrefix}${sessionLifecycle.initialClipNameSuffix}`;
      const finalClipName = `${this.context.artifactPrefix}${sessionLifecycle.finalClipNameSuffix}`;
      if (
        toolName === "ableton_tracks_create" &&
        (args.name !== trackName || args.kind !== "midi")
      ) {
        return false;
      }
      if (
        toolName === "ableton_clips_create_midi" &&
        (args.expectedName !== trackName ||
          args.name !== initialClipName ||
          args.sceneIndex !== sessionLifecycle.sourceSceneIndex ||
          args.length !== sessionLifecycle.length)
      ) {
        return false;
      }
      if (
        toolName === "ableton_transport_set_playing" &&
        args.isPlaying !== false
      ) {
        return false;
      }
      if (
        toolName === "ableton_clips_set_properties" &&
        (args.expectedName !== trackName ||
          args.sceneIndex !== sessionLifecycle.sourceSceneIndex ||
          args.name !== finalClipName ||
          args.muted !== sessionLifecycle.properties.muted ||
          args.looping !== sessionLifecycle.properties.looping)
      ) {
        return false;
      }
      if (
        toolName === "ableton_clips_duplicate" &&
        (args.expectedName !== trackName ||
          args.sceneIndex !== sessionLifecycle.sourceSceneIndex ||
          args.expectedDestinationTrackName !== trackName ||
          args.destinationSceneIndex !== sessionLifecycle.destinationSceneIndex)
      ) {
        return false;
      }
      if (
        toolName === "ableton_clips_launch" &&
        (args.expectedName !== trackName ||
          args.sceneIndex !== sessionLifecycle.sourceSceneIndex)
      ) {
        return false;
      }
      if (
        toolName === "ableton_clips_delete" &&
        (args.expectedName !== trackName ||
          (args.sceneIndex !== sessionLifecycle.sourceSceneIndex &&
            args.sceneIndex !== sessionLifecycle.destinationSceneIndex))
      ) {
        return false;
      }
      if (
        toolName === "ableton_tracks_delete" &&
        (args.expectedName !== trackName || args.expectedKind !== "midi")
      ) {
        return false;
      }
    }
    const exactName = args.name;
    if (
      toolName === "ableton_tracks_create" &&
      (typeof exactName !== "string" || !this.#trackNames.has(exactName))
    ) {
      return false;
    }
    if (
      toolName === "ableton_clips_create_midi" &&
      (typeof exactName !== "string" || !this.#clipNames.has(exactName))
    ) {
      return false;
    }
    for (const key of [
      "expectedName",
      "expectedDestinationTrackName",
    ] as const) {
      const value = args[key];
      if (
        value !== undefined &&
        (typeof value !== "string" || !this.#trackNames.has(value))
      ) {
        return false;
      }
    }
    if (toolName === "ableton_browser_load_item") {
      const expectedItemName = args.expectedItemName;
      if (
        typeof expectedItemName !== "string" ||
        !this.context.manifest.browserItemNames.includes(expectedItemName)
      ) {
        return false;
      }
      const target = this.context.manifest.browserLoadTargets.find(
        (candidate) => candidate.itemName === expectedItemName,
      );
      if (
        target !== undefined &&
        args.expectedName !==
          `${this.context.artifactPrefix}${target.trackNameSuffix}`
      ) {
        return false;
      }
    }
    if (
      toolName === "ableton_clips_replace_notes" ||
      toolName === "ableton_arrangement_replace_notes"
    ) {
      const assertion =
        toolName === "ableton_clips_replace_notes"
          ? this.context.manifest.assertions.find(
              (candidate) => candidate.type === "session-midi-pattern",
            )
          : this.context.manifest.assertions.find(
              (candidate) => candidate.type === "arrangement-midi-pattern",
            );
      if (!assertion || !matchesExpectedNotes(args.notes, assertion)) {
        return false;
      }
    }
    return true;
  }
}

function matchesExpectedNotes(
  value: unknown,
  assertion:
    | z.infer<typeof sessionMidiPatternAssertionSchema>
    | z.infer<typeof arrangementMidiPatternAssertionSchema>,
): boolean {
  if (!Array.isArray(value) || value.length !== assertion.starts.length) {
    return false;
  }
  const actual = value
    .map((note) => note as Record<string, unknown>)
    .sort((left, right) => Number(left.startTime) - Number(right.startTime));
  return actual.every(
    (note, index) =>
      note.pitch === assertion.pitch &&
      note.startTime === assertion.starts[index] &&
      note.duration === assertion.duration &&
      note.velocity === assertion.velocity &&
      (note.mute === false || note.mute === undefined),
  );
}

export async function captureScenarioBaseline(
  application: HeadlessApplication,
): Promise<SessionSnapshot> {
  return application.inspectSession();
}

export async function verifyScenario(
  application: HeadlessApplication,
  context: ScenarioRunContext,
  baseline: SessionSnapshot,
): Promise<ScenarioAssertionResult[]> {
  const snapshot = await application.inspectSession();
  const baselineReferences = new Set(
    baseline.tracks.map((track) => track.reference),
  );
  const generatedTracks = snapshot.tracks.filter(
    (track) =>
      !baselineReferences.has(track.reference) &&
      track.name.startsWith(context.artifactPrefix),
  );
  const results: ScenarioAssertionResult[] = [];

  for (const assertion of context.manifest.assertions) {
    if (assertion.type === "track-lifecycle") {
      const initialName = `${context.artifactPrefix}${assertion.initialNameSuffix}`;
      const finalName = `${context.artifactPrefix}${assertion.finalNameSuffix}`;
      const expectedCalls = [
        [
          "ableton_tracks_create",
          { name: initialName, kind: assertion.trackKind },
        ],
        [
          "ableton_tracks_rename",
          { expectedName: initialName, name: finalName },
        ],
        [
          "ableton_tracks_set_mixer",
          { expectedName: finalName, ...assertion.mixer },
        ],
        [
          "ableton_tracks_delete",
          { expectedName: finalName, expectedKind: assertion.trackKind },
        ],
      ] as const;
      const callEvidence = expectedCalls.map(([toolName, expected]) => {
        const matches = context.approvals.decisions.filter(
          (decision) =>
            decision.approved &&
            decision.toolName === toolName &&
            Object.entries(expected).every(
              ([key, value]) =>
                (decision.arguments as Record<string, unknown>)[key] === value,
            ),
        );
        return { toolName, matches: matches.length };
      });
      const restored =
        snapshot.trackCount === baseline.trackCount &&
        JSON.stringify(snapshot.tracks) === JSON.stringify(baseline.tracks) &&
        !snapshot.tracks.some(
          (track) =>
            track.name === initialName ||
            track.name === finalName ||
            track.name.startsWith(context.artifactPrefix),
        );
      const passed =
        restored && callEvidence.every((entry) => entry.matches === 1);
      results.push({
        assertion: assertion.type,
        passed,
        message: passed
          ? "Verified exact track lifecycle and baseline restoration"
          : "Track lifecycle calls or final baseline restoration did not match",
        evidence: sanitizeTraceValue({ restored, callEvidence }),
      });
      continue;
    }
    if (assertion.type === "session-clip-lifecycle") {
      const trackName = `${context.artifactPrefix}${assertion.trackNameSuffix}`;
      const initialClipName = `${context.artifactPrefix}${assertion.initialClipNameSuffix}`;
      const finalClipName = `${context.artifactPrefix}${assertion.finalClipNameSuffix}`;
      const expectedCalls = [
        ["ableton_tracks_create", 1],
        ["ableton_clips_create_midi", 1],
        ["ableton_clips_set_properties", 1],
        ["ableton_clips_duplicate", 1],
        ["ableton_clips_launch", 1],
        ["ableton_transport_set_playing", 1],
        ["ableton_clips_delete", 2],
        ["ableton_tracks_delete", 1],
      ] as const;
      const callEvidence = expectedCalls.map(([toolName, count]) => ({
        toolName,
        expected: count,
        actual: context.approvals.decisions.filter(
          (decision) => decision.approved && decision.toolName === toolName,
        ).length,
      }));
      const restored =
        JSON.stringify(snapshot) === JSON.stringify(baseline) &&
        !snapshot.tracks.some((track) => track.name === trackName) &&
        !(snapshot.clips ?? []).some(
          (clip) =>
            clip.name === initialClipName || clip.name === finalClipName,
        );
      const passed =
        restored &&
        callEvidence.every((entry) => entry.actual === entry.expected);
      results.push({
        assertion: assertion.type,
        passed,
        message: passed
          ? "Verified Session clip lifecycle and baseline restoration"
          : "Session clip lifecycle calls or final baseline restoration did not match",
        evidence: sanitizeTraceValue({ restored, callEvidence }),
      });
      continue;
    }
    if (assertion.type === "connection-capabilities") {
      const [status, capabilities] = await Promise.all([
        application.getStatus(),
        application.getCapabilities(),
      ]);
      const missing = assertion.requiredCapabilities.filter(
        (capability) => capabilities.capabilities[capability] !== true,
      );
      const passed = status.state === "connected" && missing.length === 0;
      results.push({
        assertion: assertion.type,
        passed,
        message: passed
          ? `Connected with ${assertion.requiredCapabilities.length} required capabilities`
          : `Connection or capability check failed; missing ${missing.join(", ") || "none"}`,
        evidence: sanitizeTraceValue({
          status,
          requiredCapabilities: assertion.requiredCapabilities,
          missing,
        }),
      });
      continue;
    }
    if (assertion.type === "session-unchanged") {
      const passed = JSON.stringify(snapshot) === JSON.stringify(baseline);
      results.push({
        assertion: assertion.type,
        passed,
        message: passed
          ? "Session state is unchanged"
          : "Session state changed during a read-only scenario",
        evidence: passed
          ? undefined
          : sanitizeTraceValue({ baseline, snapshot }),
      });
      continue;
    }
    if (assertion.type === "tool-calls") {
      const counts = new Map<string, number>();
      for (const decision of context.approvals.decisions) {
        if (!decision.approved) continue;
        counts.set(decision.toolName, (counts.get(decision.toolName) ?? 0) + 1);
      }
      const mismatches = assertion.required.flatMap((requirement) => {
        const count = counts.get(requirement.toolName) ?? 0;
        return count >= requirement.min && count <= requirement.max
          ? []
          : [{ ...requirement, count }];
      });
      results.push({
        assertion: assertion.type,
        passed: mismatches.length === 0,
        message:
          mismatches.length === 0
            ? "Required tool call counts matched"
            : `${mismatches.length} required tool call count(s) did not match`,
        evidence: sanitizeTraceValue({
          counts: Object.fromEntries(counts),
          mismatches,
        }),
      });
      continue;
    }
    const trackName = `${context.artifactPrefix}${assertion.trackNameSuffix}`;
    const matches = generatedTracks.filter(
      (track) =>
        track.name === trackName &&
        ("trackKind" in assertion ? track.kind === assertion.trackKind : true),
    );
    if (matches.length !== 1) {
      results.push({
        assertion: assertion.type,
        passed: false,
        message: `Expected exactly one generated track '${trackName}', found ${matches.length}`,
      });
      continue;
    }
    const track = matches[0]!;
    if (assertion.type === "track-device") {
      const devices = await application.inspectDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        offset: 0,
        limit: 32,
      });
      const matchingDevices = devices.devices.filter(
        (device) => device.name === assertion.deviceName,
      );
      const passed = matchingDevices.length === 1 && devices.total === 1;
      results.push({
        assertion: assertion.type,
        passed,
        message: passed
          ? `Found '${assertion.deviceName}' on '${track.name}'`
          : `Expected only one '${assertion.deviceName}' device; found ${matchingDevices.length} matching of ${devices.total} total`,
        evidence: sanitizeTraceValue(devices.devices),
      });
      continue;
    }

    const clipName = `${context.artifactPrefix}${assertion.clipNameSuffix}`;
    if (assertion.type === "arrangement-midi-pattern") {
      const arrangement = await application.inspectArrangement({
        offset: 0,
        limit: 512,
      });
      const clips = arrangement.clips.filter(
        (clip) =>
          clip.trackReference === track.reference &&
          clip.name === clipName &&
          clip.kind === "midi" &&
          clip.startTime === assertion.startTime &&
          clip.length === assertion.length,
      );
      if (clips.length !== 1) {
        results.push({
          assertion: assertion.type,
          passed: false,
          message: `Expected exactly one generated Arrangement clip '${clipName}', found ${clips.length}`,
          evidence: sanitizeTraceValue(arrangement.clips),
        });
        continue;
      }
      const inspected = await application.inspectArrangementMidiNotes({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        expectedClipReference: clips[0]!.reference,
        expectedStartTime: assertion.startTime,
        offset: 0,
        limit: 2048,
      });
      results.push(
        midiPatternResult(
          assertion,
          clipName,
          inspected.notes,
          inspected.totalNotes,
          inspected,
        ),
      );
      continue;
    }
    const clips = (snapshot.clips ?? []).filter(
      (clip) =>
        clip.trackReference === track.reference &&
        clip.sceneIndex === assertion.sceneIndex &&
        clip.name === clipName,
    );
    if (clips.length !== 1) {
      results.push({
        assertion: assertion.type,
        passed: false,
        message: `Expected exactly one generated clip '${clipName}', found ${clips.length}`,
      });
      continue;
    }
    const inspected = await application.inspectMidiNotes({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      sceneIndex: assertion.sceneIndex,
      expectedClipReference: clips[0]!.reference,
      offset: 0,
      limit: 128,
    });
    results.push(
      midiPatternResult(
        assertion,
        clipName,
        inspected.notes,
        inspected.totalNotes,
        inspected,
      ),
    );
  }

  const unexpectedGenerated = generatedTracks.filter(
    (track) => !context.trackNames.includes(track.name),
  );
  if (unexpectedGenerated.length > 0) {
    results.push({
      assertion: "unexpected-generated-tracks",
      passed: false,
      message: `Found ${unexpectedGenerated.length} unexpected generated track(s)`,
      evidence: sanitizeTraceValue(unexpectedGenerated),
    });
  }
  return results;
}

function midiPatternResult(
  assertion:
    | z.infer<typeof sessionMidiPatternAssertionSchema>
    | z.infer<typeof arrangementMidiPatternAssertionSchema>,
  clipName: string,
  notes: unknown,
  totalNotes: number,
  evidence: unknown,
): ScenarioAssertionResult {
  const expected = assertion.starts.map((startTime) => ({
    pitch: assertion.pitch,
    startTime,
    duration: assertion.duration,
    velocity: assertion.velocity,
    mute: false,
  }));
  const passed =
    totalNotes === expected.length &&
    Array.isArray(notes) &&
    JSON.stringify(notes) === JSON.stringify(expected);
  return {
    assertion: assertion.type,
    passed,
    message: passed
      ? `Verified ${expected.length} MIDI notes in '${clipName}'`
      : `MIDI notes in '${clipName}' did not match the scenario`,
    evidence: sanitizeTraceValue(evidence),
  };
}

export function sanitizeTraceValue(
  value: unknown,
  depth = 0,
  key = "",
): unknown {
  if (depth > 6) return "[depth-limited]";
  if (typeof value === "string") {
    if (
      /name/i.test(key) &&
      !value.startsWith("AA_SMOKE_") &&
      !key.toLowerCase().includes("toolname")
    ) {
      return "[name-redacted]";
    }
    if (
      depth < 6 &&
      value.length <= 100_000 &&
      (/^\s*\{/.test(value) || /^\s*\[/.test(value))
    ) {
      try {
        return sanitizeTraceValue(JSON.parse(value), depth + 1, key);
      } catch {
        // Some model-facing tool strings begin with JSON punctuation.
      }
    }
    return value.length > 2048 ? `${value.slice(0, 2048)}…` : value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((item) => sanitizeTraceValue(item, depth + 1, key));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      if (/token|secret|credential|authorization/i.test(key)) {
        output[key] = "[redacted]";
      } else if (/filePath|projectPath|baseDirectory/i.test(key)) {
        output[key] = "[path-redacted]";
      } else {
        output[key] = sanitizeTraceValue(entry, depth + 1, key);
      }
    }
    return output;
  }
  return `[unsupported:${typeof value}]`;
}
