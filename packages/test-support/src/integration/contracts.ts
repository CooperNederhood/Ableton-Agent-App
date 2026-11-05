import type { SessionListeningPreflightResult } from "@ableton-agent/protocol";
import type { AgentListeningEvidence } from "./agent-listening-result.js";

export type Scalar = string | number | boolean | null;
export type Facts = Readonly<Record<string, Scalar>>;
export interface AssertionReference {
  readonly name: string;
  readonly parameters: Facts;
}
export interface FixtureResource {
  readonly path: string;
  readonly target: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface DependencyInventory {
  readonly schemaVersion: 1;
  /** Production candidate resources; synthetic drivers use explicitly controlled inputs. */
  readonly candidateRoot: string;
  readonly resources: readonly (FixtureResource & { readonly id: string })[];
  /** Bounded provider-generated configuration, never represented as candidate bytes. */
  readonly generatedConfigurations?: readonly {
    readonly id: string;
    readonly target: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly frozenDevices?: readonly {
    readonly id: string;
    readonly sourceTarget: string;
    readonly target: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly preparedProject?: {
    readonly target: "prepared.als";
    readonly sha256: string;
    readonly bytes: number;
  };
}
export interface ListenerBinding {
  /** Exact saved XML identity; no matching by device display name. */
  readonly slot: string;
  readonly sourcePath: string;
  readonly dependency: "machine-listening";
  readonly trackIndex: number;
  readonly deviceIndex: number;
}
export type ClipLaunchQuantization = "global" | "none" | "bar";
export type FixtureSource = {
  readonly id: string;
  readonly trackName: string;
  readonly clipName: string;
  readonly sceneIndex: number;
  readonly clipLaunchQuantization?: ClipLaunchQuantization;
} & (
  | { readonly mediaTarget: string }
  | {
      readonly trackIndex: number;
      readonly listenerBindingSlot: string;
      readonly midi: {
        readonly notesSha256: string;
        readonly instrumentChainSha256: string;
      };
    }
);
export interface FixtureManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly qualification: "synthetic-only" | "reviewed-live";
  readonly provenance: {
    readonly ownership: "authored" | "redistributable" | "user-authorized";
    readonly description: string;
  };
  readonly resources: readonly FixtureResource[];
  readonly dependencies: readonly string[];
  readonly listenerBindings?: readonly ListenerBinding[];
  readonly sources?: readonly FixtureSource[];
  /** Existing licensed Live Builtin content; verified in place, never redistributed. */
  readonly builtinResources?: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  /** Licensed Core Library samples verified in the selected Live installation. */
  readonly coreLibraryResources?: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly baseline: Facts;
}
export interface ScenarioStep {
  readonly id: string;
  readonly message: string;
  readonly timeoutMs: number;
  readonly expectedStatus?: "completed" | "refused";
  readonly sourceId?: string;
  readonly assertions: readonly AssertionReference[];
}
export interface ScenarioPermission {
  readonly tool: string;
  readonly action: string;
  readonly risk: "low" | "medium";
  readonly maxUses: number;
  readonly arguments: Facts;
  readonly stepIds?: readonly string[];
}
export interface ScenarioManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly fixtureId: string;
  readonly requiredCapabilities: readonly string[];
  readonly permissions: readonly ScenarioPermission[];
  readonly budget: {
    readonly runMs: number;
    readonly cleanupMs: number;
    readonly persistenceMs: number;
  };
  readonly steps: readonly ScenarioStep[];
  readonly assertions: readonly AssertionReference[];
}
export interface SessionIdentity {
  readonly appSessionId: string;
  readonly conversationId: string;
  readonly agentId: string;
}
export interface Submission extends SessionIdentity {
  readonly userMessageId: string;
  readonly operationId: string;
}
interface SourceLocation {
  readonly trackId: string;
  readonly clipId: string;
  readonly slotIndex: number;
}
export interface MidiContentIdentity {
  readonly midiNotesSha256: string;
  readonly instrumentChainSha256: string;
}
export type SourceIdentity = SourceLocation &
  ({ readonly mediaSha256: string } | MidiContentIdentity);
export interface CaptureEvidence {
  readonly passId: string;
  readonly operationId: string;
  readonly source: SourceIdentity;
  readonly listenerId: string;
  readonly complete: boolean;
  readonly nonSilent: boolean;
  readonly truncated: boolean;
  readonly missingRecords: number;
  readonly metricFamilies: readonly string[];
  readonly sampleRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly cleanupComplete: boolean;
  readonly failure: string | null;
  readonly native?: {
    readonly generation: string;
    readonly nativeEpoch: number;
    readonly connectionId: string;
    readonly connectionEpoch: string;
  };
  readonly spectralCentroidHz?: number;
}
/** Diagnostic outlet snapshots only: delivery counts are not FFT frame support. */
export interface SpectralShapeSmokeEvidence {
  readonly traceId: string;
  readonly correlationId: string;
  readonly passId: string;
  readonly listenerId: string;
  readonly native: NonNullable<CaptureEvidence["native"]>;
  readonly launchEventId: string;
  readonly launchSequence: number;
  readonly afterOwnedRestart: boolean;
  readonly events: readonly {
    readonly eventId: string;
    readonly causationId: string;
    readonly sequence: number;
    readonly stage:
      "queued" | "started" | "progress" | "completed" | "failed" | "cancelled";
    readonly phase: "capture" | "drain";
    readonly elapsedMs: number;
    readonly durationMs: number;
    readonly reason: string;
    readonly facts: Readonly<
      Record<
        string,
        | { readonly state: "observed"; readonly value: number | string }
        | { readonly state: "unavailable"; readonly reason: "not-reported" }
      >
    >;
  }[];
}
export type FlatnessSmokeEvidence = SpectralShapeSmokeEvidence;
export type SpreadSmokeEvidence = SpectralShapeSmokeEvidence;
export type RolloffSmokeEvidence = SpectralShapeSmokeEvidence;
export interface ContextEvidence {
  readonly contextId: string;
  readonly passId: string;
  readonly source: SourceIdentity;
  readonly contentSha256: string;
  readonly readable: boolean;
  readonly afterOwnedRestart: boolean;
}
export interface BaselineEvidence {
  readonly schemaVersion: 1;
  readonly facts: Facts;
  readonly sources?: Readonly<Record<string, SessionSourceEvidence>>;
  readonly dependencyHashes: Readonly<Record<string, string>>;
}
export interface AudioSourceEvidence {
  readonly loadedMediaPath: string;
  readonly source: SourceLocation & { readonly mediaSha256: string };
  readonly listenerId: string;
  readonly facts: Facts;
}
export interface ListenerPlacement {
  readonly trackIndex: number;
  readonly deviceIndex: number;
  readonly deviceReference: string;
}
export interface MidiSourceEvidence {
  readonly source: SourceLocation & MidiContentIdentity;
  readonly listenerId: string;
  readonly facts: Facts;
  readonly midi: Extract<SessionListeningPreflightResult, { midi: unknown }>;
  readonly listenerPlacement: ListenerPlacement;
}
export type SessionSourceEvidence = AudioSourceEvidence | MidiSourceEvidence;
export interface AudioBaselineEvidence extends BaselineEvidence {
  readonly sources: Readonly<Record<string, AudioSourceEvidence>>;
}
export interface TurnEvidence extends Submission {
  readonly agentListening?: AgentListeningEvidence;
  readonly schemaVersion: 1;
  readonly assistantMessageId: string;
  readonly terminal: true;
  readonly status: "completed" | "refused" | "failed" | "cancelled";
  readonly assistantText: string;
  readonly captures: readonly CaptureEvidence[];
  readonly contexts: readonly ContextEvidence[];
  readonly flatnessSmoke?: readonly FlatnessSmokeEvidence[];
  readonly spreadSmoke?: readonly SpreadSmokeEvidence[];
  readonly rolloffSmoke?: readonly RolloffSmokeEvidence[];
  readonly facts: Facts;
}
export interface RunEvidence {
  readonly agentListening?: readonly AgentListeningEvidence[];
  readonly schemaVersion: 1;
  readonly recoveries?: readonly string[];
  /** Complete run-scoped pass inventory, including owned restart observation. */
  readonly capturePassIds?: readonly string[];
  readonly facts: Facts;
  readonly contexts: readonly ContextEvidence[];
  readonly flatnessSmoke?: readonly FlatnessSmokeEvidence[];
  readonly spreadSmoke?: readonly SpreadSmokeEvidence[];
  readonly rolloffSmoke?: readonly RolloffSmokeEvidence[];
  readonly unchanged: readonly {
    readonly scope: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
  }[];
}
export interface StagedFixture {
  readonly projectPath: string;
  readonly workingDirectory: string;
  readonly resources: readonly FixtureResource[];
  verifySourceUnchanged(): Promise<void>;
}
export interface DriverContext {
  readonly runId: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly scenario: ScenarioManifest;
  readonly fixture: FixtureManifest;
  readonly stagedFixture?: StagedFixture;
  readonly dependencyInventory?: DependencyInventory;
  readonly identity?: SessionIdentity;
}
export interface TurnSubscription {
  /** Resolve only after the attributable terminal response and its owned jobs settle. */
  waitForTurn(
    submission: Submission,
    context: DriverContext,
  ): Promise<TurnEvidence>;
  close(context: DriverContext): Promise<void>;
}
/** All operations must honor signal; cleanup must reclaim partially launched resources. */
export interface AcceptanceDriver {
  readonly schemaVersion: 1;
  readonly capabilities: readonly string[];
  launch(context: DriverContext): Promise<void>;
  ready(context: DriverContext): Promise<SessionIdentity>;
  subscribe(context: DriverContext): Promise<TurnSubscription>;
  readBaseline(context: DriverContext): Promise<BaselineEvidence>;
  submit(step: ScenarioStep, context: DriverContext): Promise<Submission>;
  collect(context: DriverContext): Promise<RunEvidence>;
  cleanup(context: DriverContext): Promise<void>;
}
export interface AssertionInput {
  readonly fixture: FixtureManifest;
  readonly baseline: BaselineEvidence;
  readonly turns: readonly TurnEvidence[];
  readonly turn?: TurnEvidence;
  readonly evidence?: RunEvidence;
}
export interface AssertionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly code: string;
  readonly detail: string;
}
export type Assertion = (
  input: AssertionInput,
  parameters: Facts,
) => Omit<AssertionResult, "name">;
export type RunStatus =
  | "passed"
  | "expected-refusal"
  | "recovered"
  | "blocked"
  | "failed"
  | "cancelled"
  | "finalization-failed";
export interface RunFailure {
  readonly stage: string;
  readonly message: string;
}
export interface RunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly traceId: string;
  readonly scenarioId: string;
  readonly fixtureId: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly selected: readonly string[];
  readonly executed: readonly string[];
  readonly unrun: readonly string[];
  readonly assertions: readonly AssertionResult[];
  readonly turns: readonly TurnEvidence[];
  readonly baseline?: BaselineEvidence;
  readonly dependencyInventory?: DependencyInventory;
  readonly evidence?: RunEvidence;
  readonly primaryFailure?: RunFailure;
  readonly finalizationFailures: readonly RunFailure[];
  readonly cleanupComplete: boolean;
  readonly persisted: boolean;
}
export interface LifecycleEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly stage: string;
  readonly phase:
    "queued" | "started" | "progress" | "completed" | "failed" | "cancelled";
  readonly timestamp: number;
  readonly durationMs: number;
}

/** Original stopped-zero/None fixture defaults, not product capability evidence. */
export const SUPPORTED_AUDIO_BASELINE: Facts = Object.freeze({
  globalQuantization: "none",
  clipLaunchQuantization: "global",
  transportPlaying: false,
  currentSongTime: 0,
  playingSessionClips: 0,
  queuedSessionClips: 0,
  recording: false,
  signatureNumerator: 4,
  signatureDenominator: 4,
  clipWarped: true,
  clipStart: 0,
  loopStart: 0,
  loopEnd: 4,
  activeLengthBeats: 4,
  launchMode: "trigger",
  legato: false,
  followActionsEnabled: false,
  listenerBoundToSource: true,
});
