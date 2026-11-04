import { SUPPORTED_AUDIO_BASELINE } from "./contracts.js";
import { midiContentIdentity } from "./sources.js";
import { validateFlatnessSmoke } from "./flatness-smoke.js";
import type {
  AcceptanceDriver,
  AssertionResult,
  AudioBaselineEvidence,
  SessionSourceEvidence,
  ListenerPlacement,
  BaselineEvidence,
  DependencyInventory,
  Facts,
  FixtureManifest,
  FixtureResource,
  RunEvidence,
  RunResult,
  ScenarioManifest,
  ScenarioPermission,
  SessionIdentity,
  Submission,
  TurnEvidence,
} from "./contracts.js";

export function requireCondition(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
export function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
  };
  freeze(copy);
  return copy;
}
function object(value: unknown): asserts value is Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected object",
  );
}
export function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  requireCondition(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown schema field",
  );
}
function text(value: unknown, max = 256): asserts value is string {
  requireCondition(
    typeof value === "string" && value.length > 0 && value.length <= max,
    "Invalid bounded string",
  );
}
export function identifier(value: unknown): asserts value is string {
  text(value, 128);
  requireCondition(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value),
    "Invalid identifier",
  );
}
function listenerIdentifier(value: unknown): asserts value is string {
  text(value, 128);
  requireCondition(
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value),
    "Invalid listener identifier",
  );
}
export function hash(value: unknown): asserts value is string {
  requireCondition(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "Invalid SHA-256",
  );
}
function integer(
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  requireCondition(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    "Invalid bounded integer",
  );
}
function list(value: unknown, max = 128): asserts value is unknown[] {
  requireCondition(
    Array.isArray(value) && value.length <= max,
    "Invalid bounded list",
  );
}
function identifiers(value: unknown, max = 128): asserts value is string[] {
  list(value, max);
  value.forEach(identifier);
  unique(value);
}
function unique(values: readonly unknown[]): void {
  requireCondition(
    new Set(values).size === values.length,
    "Duplicate identifier or resource",
  );
}
export function validateFacts(value: unknown): asserts value is Facts {
  object(value);
  requireCondition(Object.keys(value).length <= 128, "Too many facts");
  for (const [key, fact] of Object.entries(value)) {
    identifier(key);
    requireCondition(
      fact === null ||
        typeof fact === "boolean" ||
        (typeof fact === "number" && Number.isFinite(fact)) ||
        (typeof fact === "string" && fact.length <= 8192),
      "Invalid scalar fact",
    );
  }
}
export function safeRelativePath(value: unknown): asserts value is string {
  text(value, 240);
  requireCondition(
    !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (part) =>
            /^[a-zA-Z0-9_][a-zA-Z0-9._ ~-]*$/.test(part) &&
            part !== "." &&
            part !== "..",
        ),
    "Unsafe resource path",
  );
}
function assertions(value: unknown, names?: ReadonlySet<string>): void {
  list(value);
  for (const ref of value) {
    object(ref);
    rejectUnknownFields(ref, ["name", "parameters"]);
    identifier(ref.name);
    validateFacts(ref.parameters);
    if (names)
      requireCondition(names.has(ref.name), `Unknown assertion: ${ref.name}`);
  }
}
function resource(value: unknown): asserts value is FixtureResource {
  object(value);
  safeRelativePath(value.path);
  safeRelativePath(value.target);
  hash(value.sha256);
  integer(value.bytes, 1, 64 * 1024 * 1024);
}
export function validateSupportedAudioBaseline(
  value: unknown,
): asserts value is Facts {
  validateFacts(value);
  for (const [key, expected] of Object.entries(SUPPORTED_AUDIO_BASELINE)) {
    const actual = value[key];
    const supported =
      key === "globalQuantization"
        ? actual === "none" || actual === "bar"
        : key === "currentSongTime"
          ? typeof actual === "number" && actual >= 0 && actual <= 1_576_800
          : key === "playingSessionClips"
            ? actual === (value.rememberedSessionClips ?? 0)
            : actual === expected;
    requireCondition(supported, `Unsupported audio baseline: ${key}`);
  }
  if (value.rememberedSessionClips !== undefined)
    integer(value.rememberedSessionClips, 0, 100_000);
}
export function validateSupportedSessionBaseline(
  value: unknown,
  kind: "audio" | "midi",
): asserts value is Facts {
  validateFacts(value);
  if (value.clipLaunchQuantization !== undefined)
    requireCondition(
      ["global", "none", "bar"].includes(String(value.clipLaunchQuantization)),
      `Unsupported ${kind} baseline: clipLaunchQuantization`,
    );
  const remembered =
    value.rememberedSessionClips === undefined
      ? value.playingSessionClips
      : value.rememberedSessionClips;
  const common = {
    ...value,
    clipLaunchQuantization: "global",
    ...(remembered === undefined ? {} : { rememberedSessionClips: remembered }),
  };
  if (kind === "audio")
    return validateSupportedAudioBaseline({
      ...common,
      clipWarped: value.clipWarped === undefined ? true : value.clipWarped,
    });
  requireCondition(
    value.clipWarped === undefined || value.clipWarped === false,
    "MIDI cannot be warped audio",
  );
  validateSupportedAudioBaseline({ ...common, clipWarped: true });
}
export function validateAudioBaselineEvidence(
  value: unknown,
): asserts value is AudioBaselineEvidence {
  object(value);
  validateBaseline(value);
  object(value.sources);
  requireCondition(
    Object.keys(value.sources).length > 0,
    "Missing audio sources",
  );
  for (const entry of Object.values(value.sources)) {
    object(entry);
    requireCondition("loadedMediaPath" in entry, "Expected audio source");
    validateSupportedAudioBaseline(entry.facts);
  }
  validateSupportedAudioBaseline(value.facts);
}
export function isFixtureMediaTarget(path: string): boolean {
  return /^(?:media|Samples(?:\/[A-Za-z0-9_-]+)*)\/resource-\d{3}\.(wav|aif|aiff)$/.test(
    path,
  );
}

export function validateFixture(
  value: unknown,
): asserts value is FixtureManifest {
  object(value);
  rejectUnknownFields(value, [
    "schemaVersion",
    "id",
    "qualification",
    "provenance",
    "resources",
    "dependencies",
    "listenerBindings",
    "sources",
    "builtinResources",
    "coreLibraryResources",
    "baseline",
  ]);
  requireCondition(value.schemaVersion === 1, "Unsupported fixture version");
  identifier(value.id);
  requireCondition(
    value.qualification === "synthetic-only" ||
      value.qualification === "reviewed-live",
    "Invalid fixture qualification",
  );
  object(value.provenance);
  rejectUnknownFields(value.provenance, ["ownership", "description"]);
  requireCondition(
    value.provenance.ownership === "authored" ||
      value.provenance.ownership === "redistributable" ||
      value.provenance.ownership === "user-authorized",
    "Missing source ownership",
  );
  text(value.provenance.description, 4096);
  list(value.resources, 64);
  requireCondition(value.resources.length > 0, "Empty resource inventory");
  const resources = value.resources.map((entry) => {
    object(entry);
    rejectUnknownFields(entry, ["path", "target", "sha256", "bytes"]);
    resource(entry);
    requireCondition(
      entry.target === "project.als" || isFixtureMediaTarget(entry.target),
      "Resource target must be neutral",
    );
    return entry;
  });
  const total = resources.reduce((sum, entry) => sum + entry.bytes, 0);
  requireCondition(total <= 128 * 1024 * 1024, "Fixture exceeds byte budget");
  unique(resources.map((r) => r.path.toLowerCase()));
  unique(resources.map((r) => r.target.toLowerCase()));
  requireCondition(
    resources.filter((r) => r.target === "project.als").length === 1,
    "Exactly one project required",
  );
  list(value.dependencies, 32);
  value.dependencies.forEach(identifier);
  unique(value.dependencies);
  if (value.listenerBindings !== undefined) {
    list(value.listenerBindings, 32);
    const slots: string[] = [];
    for (const binding of value.listenerBindings) {
      object(binding);
      rejectUnknownFields(binding, [
        "slot",
        "sourcePath",
        "dependency",
        "trackIndex",
        "deviceIndex",
      ]);
      text(binding.slot, 1024);
      requireCondition(
        /^(Audio|Midi)Track:\d+\/DeviceChain\/DeviceChain\/Devices\/MxDeviceAudioEffect:\d+$/u.test(
          binding.slot,
        ),
        "Unsupported listener slot",
      );
      safeRelativePath(binding.sourcePath);
      requireCondition(
        binding.dependency === "machine-listening" &&
          value.dependencies.includes(binding.dependency),
        "Undeclared listener dependency",
      );
      integer(binding.trackIndex, 0, 1023);
      integer(binding.deviceIndex, 0, 1023);
      slots.push(binding.slot);
    }
    unique(slots);
  }
  validateFacts(value.baseline);
  if (value.sources !== undefined) {
    list(value.sources, 16);
    requireCondition(value.sources.length > 0, "Empty source inventory");
    const ids: string[] = [];
    const selectors: string[] = [];
    for (const entry of value.sources) {
      object(entry);
      rejectUnknownFields(entry, [
        "id",
        "trackName",
        "clipName",
        "sceneIndex",
        "clipLaunchQuantization",
        "mediaTarget",
        "trackIndex",
        "listenerBindingSlot",
        "midi",
      ]);
      identifier(entry.id);
      text(entry.trackName);
      text(entry.clipName);
      integer(entry.sceneIndex, 0, 100_000);
      if (entry.clipLaunchQuantization !== undefined)
        requireCondition(
          typeof entry.clipLaunchQuantization === "string" &&
            ["global", "none", "bar"].includes(entry.clipLaunchQuantization),
          "Unsupported declared clip quantization",
        );
      if ("mediaTarget" in entry) {
        requireCondition(
          !("midi" in entry) &&
            !("listenerBindingSlot" in entry) &&
            !("trackIndex" in entry),
          "Mixed source kinds",
        );
        safeRelativePath(entry.mediaTarget);
        requireCondition(
          isFixtureMediaTarget(entry.mediaTarget) &&
            resources.some((resource) => resource.target === entry.mediaTarget),
          "Source references undeclared media",
        );
      } else {
        integer(entry.trackIndex, 0, 255);
        integer(entry.sceneIndex, 0, 255);
        text(entry.listenerBindingSlot);
        object(entry.midi);
        rejectUnknownFields(entry.midi, [
          "notesSha256",
          "instrumentChainSha256",
        ]);
        hash(entry.midi.notesSha256);
        hash(entry.midi.instrumentChainSha256);
        requireCondition(
          Array.isArray(value.listenerBindings) &&
            value.listenerBindings.some((binding: unknown) => {
              object(binding);
              return (
                binding.slot === entry.listenerBindingSlot &&
                binding.trackIndex === entry.trackIndex &&
                typeof binding.deviceIndex === "number" &&
                binding.deviceIndex < 8
              );
            }),
          "MIDI source requires an exact declared listener binding",
        );
      }
      ids.push(entry.id);
      selectors.push(JSON.stringify([entry.trackName, entry.sceneIndex]));
    }
    unique(ids);
    unique(selectors);
  }
  for (const library of ["builtinResources", "coreLibraryResources"] as const) {
    const resources = value[library];
    if (resources === undefined) continue;
    list(resources, library === "builtinResources" ? 32 : 128);
    let total = 0;
    const paths: string[] = [];
    for (const entry of resources) {
      object(entry);
      rejectUnknownFields(entry, ["path", "sha256", "bytes"]);
      safeRelativePath(entry.path);
      hash(entry.sha256);
      integer(entry.bytes, 1, 16 * 1024 * 1024);
      total += Number(entry.bytes);
      paths.push(entry.path.toLowerCase());
    }
    unique(paths);
    requireCondition(
      total <= 64 * 1024 * 1024,
      "Installed Live resources exceed byte budget",
    );
  }
}
export function validatePermission(
  value: unknown,
): asserts value is ScenarioPermission {
  object(value);
  rejectUnknownFields(value, [
    "tool",
    "action",
    "risk",
    "maxUses",
    "arguments",
    "stepIds",
  ]);
  identifier(value.tool);
  identifier(value.action);
  requireCondition(
    value.risk === "low" || value.risk === "medium",
    "Only low/medium scoped permissions are supported",
  );
  integer(value.maxUses, 1, 16);
  validateFacts(value.arguments);
  if (value.stepIds !== undefined) {
    identifiers(value.stepIds, 32);
    requireCondition(value.stepIds.length > 0, "Empty permission step scope");
  }
  const keys = Object.keys(value.arguments);
  for (const [key, argument] of Object.entries(value.arguments)) {
    requireCondition(
      key
        .split(".")
        .every(
          (part) =>
            /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(part) &&
            !["__proto__", "prototype", "constructor"].includes(part),
        ),
      "Invalid dotted permission argument path",
    );
    requireCondition(
      !keys.some((other) => other.startsWith(`${key}.`)),
      "Colliding permission argument paths",
    );
    if (typeof argument === "string" && argument.startsWith("$source"))
      requireCondition(
        [
          "$source.trackId",
          "$source.clipId",
          "$source.slotIndex",
          "$source.listenerId",
        ].includes(argument),
        "Unknown source permission reference",
      );
  }
}
export function resolvePermissionArguments(
  permission: ScenarioPermission,
  actualSource?: SessionSourceEvidence,
): Facts {
  validatePermission(permission);
  const resolved: Record<string, Facts[string]> = {};
  for (const [key, value] of Object.entries(permission.arguments)) {
    if (typeof value === "string" && value.startsWith("$source")) {
      requireCondition(
        actualSource,
        "Source permission reference has no actual source binding",
      );
      source(actualSource.source);
      listenerIdentifier(actualSource.listenerId);
      if (value === "$source.trackId")
        resolved[key] = actualSource.source.trackId;
      else if (value === "$source.clipId")
        resolved[key] = actualSource.source.clipId;
      else if (value === "$source.listenerId")
        resolved[key] = actualSource.listenerId;
      else resolved[key] = actualSource.source.slotIndex;
    } else resolved[key] = value;
  }
  return Object.freeze(resolved);
}
export function validateScenario(
  value: unknown,
  fixture: FixtureManifest,
  names?: ReadonlySet<string>,
  capabilities?: readonly string[],
): asserts value is ScenarioManifest {
  validateFixture(fixture);
  object(value);
  rejectUnknownFields(value, [
    "schemaVersion",
    "id",
    "fixtureId",
    "requiredCapabilities",
    "permissions",
    "budget",
    "steps",
    "assertions",
  ]);
  requireCondition(value.schemaVersion === 1, "Unsupported scenario version");
  identifier(value.id);
  identifier(value.fixtureId);
  requireCondition(value.fixtureId === fixture.id, "Unknown fixture reference");
  list(value.requiredCapabilities, 64);
  value.requiredCapabilities.forEach(identifier);
  unique(value.requiredCapabilities);
  if (capabilities)
    for (const capability of value.requiredCapabilities) {
      identifier(capability);
      requireCondition(
        capabilities.includes(capability),
        `Unsupported capability: ${capability}`,
      );
    }
  list(value.permissions, 64);
  const permissionScopes = value.permissions.map((permission) => {
    validatePermission(permission);
    return JSON.stringify([
      permission.tool,
      permission.action,
      Object.entries(permission.arguments).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ]);
  });
  unique(permissionScopes);
  object(value.budget);
  rejectUnknownFields(value.budget, ["runMs", "cleanupMs", "persistenceMs"]);
  for (const key of ["runMs", "cleanupMs", "persistenceMs"])
    integer(value.budget[key], 1, 3_600_000);
  integer(value.budget.runMs, 1, 3_600_000);
  list(value.steps, 32);
  requireCondition(value.steps.length > 0, "Empty scenario");
  let assertionCount = 0;
  const stepIds: string[] = [];
  for (const step of value.steps) {
    object(step);
    rejectUnknownFields(step, [
      "id",
      "message",
      "timeoutMs",
      "expectedStatus",
      "sourceId",
      "assertions",
    ]);
    identifier(step.id);
    if (step.sourceId !== undefined) {
      identifier(step.sourceId);
      requireCondition(
        fixture.sources?.some((source) => source.id === step.sourceId),
        "Unknown step source",
      );
    }
    stepIds.push(step.id);
    text(step.message, 16_384);
    requireCondition(step.message.trim().length > 0, "Empty message");
    integer(step.timeoutMs, 1, value.budget.runMs);
    list(step.assertions);
    assertions(step.assertions, names);
    assertionCount += step.assertions.length;
    requireCondition(
      step.expectedStatus === undefined ||
        step.expectedStatus === "completed" ||
        step.expectedStatus === "refused",
      "Invalid expected terminal status",
    );
    if (step.expectedStatus === "refused")
      requireCondition(
        step.assertions.length > 0,
        "Expected refusal requires explicit assertions",
      );
  }
  unique(stepIds);
  for (const permission of value.permissions) {
    validatePermission(permission);
    for (const id of permission.stepIds ?? [])
      requireCondition(stepIds.includes(id), "Unknown permission step");
  }
  list(value.assertions);
  assertions(value.assertions, names);
  if (value.requiredCapabilities.includes("automation")) {
    const requiresRestart = [
      ...value.assertions,
      ...value.steps.flatMap((step) => {
        object(step);
        list(step.assertions);
        return step.assertions;
      }),
    ].some((assertion) => {
      object(assertion);
      object(assertion.parameters);
      return (
        assertion.name === "context" &&
        assertion.parameters.afterRestart === true
      );
    });
    requireCondition(
      !requiresRestart || value.requiredCapabilities.includes("persistence"),
      "Automation restart assertions require the persistence capability",
    );
  }
  requireCondition(
    value.assertions.length + assertionCount > 0,
    "No assertions",
  );
}
export function validateIdentity(
  value: unknown,
): asserts value is SessionIdentity {
  object(value);
  for (const key of ["appSessionId", "conversationId", "agentId"])
    identifier(value[key]);
}
export function validateSubmission(
  value: unknown,
): asserts value is Submission {
  object(value);
  validateIdentity(value);
  identifier(value.userMessageId);
  identifier(value.operationId);
}
function source(value: unknown): void {
  object(value);
  rejectUnknownFields(value, [
    "trackId",
    "clipId",
    "slotIndex",
    "mediaSha256",
    "midiNotesSha256",
    "instrumentChainSha256",
  ]);
  identifier(value.trackId);
  identifier(value.clipId);
  integer(value.slotIndex, 0, 100_000);
  if ("mediaSha256" in value) {
    requireCondition(
      !("midiNotesSha256" in value) && !("instrumentChainSha256" in value),
      "Mixed source identity",
    );
    hash(value.mediaSha256);
  } else {
    hash(value.midiNotesSha256);
    hash(value.instrumentChainSha256);
  }
}
function contexts(value: unknown): void {
  list(value, 128);
  for (const context of value) {
    object(context);
    identifier(context.contextId);
    identifier(context.passId);
    source(context.source);
    hash(context.contentSha256);
    requireCondition(
      typeof context.readable === "boolean" &&
        typeof context.afterOwnedRestart === "boolean",
      "Invalid context evidence",
    );
  }
}
export function validateBaseline(
  value: unknown,
): asserts value is BaselineEvidence {
  object(value);
  requireCondition(value.schemaVersion === 1, "Unsupported baseline version");
  validateFacts(value.facts);
  if (value.sources !== undefined) {
    object(value.sources);
    requireCondition(
      Object.keys(value.sources).length <= 16,
      "Too many sources",
    );
    for (const [id, entry] of Object.entries(value.sources)) {
      identifier(id);
      object(entry);
      rejectUnknownFields(entry, [
        "source",
        "listenerId",
        "loadedMediaPath",
        "facts",
        "midi",
        "listenerPlacement",
      ]);
      source(entry.source);
      listenerIdentifier(entry.listenerId);
      object(entry.source);
      if ("mediaSha256" in entry.source) {
        requireCondition(
          !("midi" in entry) && !("listenerPlacement" in entry),
          "Mixed source evidence",
        );
        text(entry.loadedMediaPath, 4096);
      } else {
        requireCondition(
          !("loadedMediaPath" in entry),
          "MIDI source cannot declare an audio path",
        );
        object(entry.listenerPlacement);
        rejectUnknownFields(entry.listenerPlacement, [
          "trackIndex",
          "deviceIndex",
          "deviceReference",
        ]);
        integer(entry.listenerPlacement.trackIndex, 0, 255);
        integer(entry.listenerPlacement.deviceIndex, 0, 7);
        identifier(entry.listenerPlacement.deviceReference);
        const content = midiContentIdentity(
          entry.midi,
          entry.listenerPlacement as unknown as ListenerPlacement,
        );
        requireCondition(
          content.midiNotesSha256 === entry.source.midiNotesSha256 &&
            content.instrumentChainSha256 ===
              entry.source.instrumentChainSha256,
          "MIDI evidence content hashes differ",
        );
      }
      validateFacts(entry.facts);
    }
  }
  object(value.dependencyHashes);
  requireCondition(
    Object.keys(value.dependencyHashes).length <= 32,
    "Too many dependency hashes",
  );
  for (const [key, digest] of Object.entries(value.dependencyHashes)) {
    identifier(key);
    hash(digest);
  }
}
function flatnessSmoke(value: unknown): void {
  if (value === undefined) return;
  list(value, 32);
  value.forEach(validateFlatnessSmoke);
}
export function validateTurn(value: unknown): asserts value is TurnEvidence {
  object(value);
  validateSubmission(value);
  const record = value;
  requireCondition(record.schemaVersion === 1, "Unsupported turn version");
  identifier(record.assistantMessageId);
  requireCondition(record.terminal === true, "Nonterminal turn evidence");
  requireCondition(
    typeof record.status === "string" &&
      ["completed", "refused", "failed", "cancelled"].includes(record.status),
    "Invalid turn status",
  );
  requireCondition(
    typeof record.assistantText === "string" &&
      record.assistantText.length <= 65_536,
    "Invalid assistant text",
  );
  validateFacts(record.facts);
  contexts(record.contexts);
  flatnessSmoke(record.flatnessSmoke);
  list(record.captures, 32);
  for (const capture of record.captures) {
    object(capture);
    identifier(capture.passId);
    identifier(capture.operationId);
    listenerIdentifier(capture.listenerId);
    source(capture.source);
    if (capture.native !== undefined) {
      object(capture.native);
      rejectUnknownFields(capture.native, [
        "generation",
        "nativeEpoch",
        "connectionId",
        "connectionEpoch",
      ]);
      for (const key of ["generation", "connectionId", "connectionEpoch"]) {
        text(capture.native[key], 36);
        requireCondition(
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(
            String(capture.native[key]),
          ),
          "Invalid native ownership UUID",
        );
      }
      integer(capture.native.nativeEpoch, 1, 1_000_000);
    }
    if (capture.spectralCentroidHz !== undefined)
      requireCondition(
        typeof capture.spectralCentroidHz === "number" &&
          Number.isFinite(capture.spectralCentroidHz) &&
          capture.spectralCentroidHz >= 0 &&
          capture.spectralCentroidHz <= 384_000,
        "Invalid measured spectral centroid",
      );
    for (const key of ["complete", "nonSilent", "truncated", "cleanupComplete"])
      requireCondition(
        typeof capture[key] === "boolean",
        "Invalid capture flag",
      );
    integer(capture.missingRecords, 0, Number.MAX_SAFE_INTEGER);
    integer(capture.sampleRate, 1, 768_000);
    integer(capture.startSample, 0, Number.MAX_SAFE_INTEGER);
    integer(
      capture.endSample,
      capture.startSample + 1,
      Number.MAX_SAFE_INTEGER,
    );
    list(capture.metricFamilies, 64);
    capture.metricFamilies.forEach(identifier);
    unique(capture.metricFamilies);
    requireCondition(
      capture.failure === null ||
        (typeof capture.failure === "string" && capture.failure.length <= 8192),
      "Invalid capture failure",
    );
  }
}
export function validateEvidence(value: unknown): asserts value is RunEvidence {
  object(value);
  requireCondition(value.schemaVersion === 1, "Unsupported evidence version");
  if (value.recoveries !== undefined) {
    list(value.recoveries, 32);
    value.recoveries.forEach((entry) => text(entry, 8192));
  }
  if (value.capturePassIds !== undefined) {
    list(value.capturePassIds, 128);
    value.capturePassIds.forEach(identifier);
    unique(value.capturePassIds);
  }
  validateFacts(value.facts);
  contexts(value.contexts);
  flatnessSmoke(value.flatnessSmoke);
  list(value.unchanged);
  const scopes = value.unchanged.map((scope) => {
    object(scope);
    identifier(scope.scope);
    hash(scope.beforeSha256);
    hash(scope.afterSha256);
    return scope.scope;
  });
  unique(scopes);
}
export function validateDriver(
  value: unknown,
): asserts value is AcceptanceDriver {
  object(value);
  requireCondition(value.schemaVersion === 1, "Unsupported driver version");
  list(value.capabilities, 64);
  value.capabilities.forEach(identifier);
  unique(value.capabilities);
  for (const method of [
    "launch",
    "ready",
    "subscribe",
    "readBaseline",
    "submit",
    "collect",
    "cleanup",
  ])
    requireCondition(
      typeof value[method] === "function",
      `Missing driver method: ${method}`,
    );
}
export function validateDependencyInventory(
  value: unknown,
  fixture?: FixtureManifest,
): asserts value is DependencyInventory {
  object(value);
  rejectUnknownFields(value, [
    "schemaVersion",
    "candidateRoot",
    "resources",
    "generatedConfigurations",
    "frozenDevices",
    "preparedProject",
  ]);
  requireCondition(
    value.schemaVersion === 1,
    "Unsupported dependency inventory version",
  );
  text(value.candidateRoot, 4096);
  list(value.resources, 512);
  const resources = value.resources.map((entry) => {
    object(entry);
    rejectUnknownFields(entry, ["id", "path", "target", "sha256", "bytes"]);
    identifier(entry.id);
    resource(entry);
    return entry;
  });
  const total = resources.reduce((sum, entry) => sum + entry.bytes, 0);
  requireCondition(
    total <= 256 * 1024 * 1024,
    "Dependency inventory exceeds byte budget",
  );
  const ids = new Set(resources.map((entry) => entry.id));
  const configurationTargets: string[] = [];
  if (value.generatedConfigurations !== undefined) {
    list(value.generatedConfigurations, 32);
    for (const configuration of value.generatedConfigurations) {
      object(configuration);
      rejectUnknownFields(configuration, ["id", "target", "sha256", "bytes"]);
      identifier(configuration.id);
      requireCondition(
        ids.has(configuration.id),
        "Generated configuration has no declared production bundle",
      );
      safeRelativePath(configuration.target);
      hash(configuration.sha256);
      integer(configuration.bytes, 1, 65_536);
      configurationTargets.push(configuration.target.toLowerCase());
    }
  }
  const allTargets = [
    ...resources.map((entry) => entry.target.toLowerCase()),
    ...configurationTargets,
  ];
  if (value.frozenDevices !== undefined) {
    list(value.frozenDevices, 32);
    const frozenIds: string[] = [];
    for (const device of value.frozenDevices) {
      object(device);
      rejectUnknownFields(device, [
        "id",
        "sourceTarget",
        "target",
        "sha256",
        "bytes",
      ]);
      identifier(device.id);
      safeRelativePath(device.sourceTarget);
      safeRelativePath(device.target);
      hash(device.sha256);
      integer(device.bytes, 1, 64 * 1024 * 1024);
      requireCondition(
        resources.some(
          (entry) =>
            entry.id === device.id &&
            entry.target === device.sourceTarget &&
            entry.target.endsWith(".amxd"),
        ),
        "Frozen device has no immutable source",
      );
      requireCondition(
        device.target.startsWith(`dependencies/${device.id}/frozen/`) &&
          device.target.endsWith(".amxd"),
        "Invalid frozen device mount",
      );
      frozenIds.push(device.id);
      allTargets.push(device.target.toLowerCase());
    }
    unique(frozenIds);
  }
  if (value.preparedProject !== undefined) {
    object(value.preparedProject);
    rejectUnknownFields(value.preparedProject, ["target", "sha256", "bytes"]);
    requireCondition(
      value.preparedProject.target === "prepared.als",
      "Invalid prepared project target",
    );
    hash(value.preparedProject.sha256);
    integer(value.preparedProject.bytes, 1, 8 * 1024 * 1024);
    allTargets.push("prepared.als");
    requireCondition(
      Array.isArray(value.frozenDevices) && value.frozenDevices.length > 0,
      "Prepared project requires frozen dependencies",
    );
  }
  unique(allTargets);
  requireCondition(
    allTargets.every(
      (target) => !allTargets.some((other) => other.startsWith(`${target}/`)),
    ),
    "Colliding dependency file and directory paths",
  );
  if (fixture) {
    requireCondition(
      ids.size === fixture.dependencies.length &&
        fixture.dependencies.every((id) => ids.has(id)),
      "Provisioned inventory must exactly match declared dependencies",
    );
    const targets = fixture.resources.map((entry) =>
      entry.target.toLowerCase(),
    );
    requireCondition(
      allTargets.every(
        (target) =>
          !targets.some(
            (fixtureTarget) =>
              target === fixtureTarget ||
              target.startsWith(`${fixtureTarget}/`) ||
              fixtureTarget.startsWith(`${target}/`),
          ),
      ),
      "Dependency mount collides with immutable fixture resource",
    );
  }
}
export function validateAssertionResult(
  value: unknown,
): asserts value is AssertionResult {
  object(value);
  identifier(value.name);
  text(value.code);
  text(value.detail, 8192);
  requireCondition(
    typeof value.passed === "boolean",
    "Invalid assertion result",
  );
}
export function validateResult(value: unknown): asserts value is RunResult {
  object(value);
  requireCondition(value.schemaVersion === 1, "Unsupported result version");
  for (const key of ["runId", "traceId", "scenarioId", "fixtureId"])
    identifier(value[key]);
  requireCondition(
    typeof value.status === "string" &&
      [
        "passed",
        "expected-refusal",
        "recovered",
        "blocked",
        "failed",
        "cancelled",
        "finalization-failed",
      ].includes(value.status),
    "Invalid run status",
  );
  for (const key of ["startedAt", "completedAt", "durationMs"])
    integer(value[key], 0, Number.MAX_SAFE_INTEGER);
  requireCondition(
    Number(value.completedAt) >= Number(value.startedAt),
    "Invalid result timing",
  );
  identifiers(value.selected, 32);
  identifiers(value.executed, 32);
  identifiers(value.unrun, 32);
  const selected = value.selected;
  const executed = value.executed;
  const unrun = value.unrun;
  requireCondition(
    selected.length > 0 &&
      selected.length === executed.length + unrun.length &&
      selected.every(
        (step) => executed.includes(step) !== unrun.includes(step),
      ),
    "Invalid execution accounting",
  );
  list(value.assertions, 4224);
  const assertionResults = value.assertions.map((entry) => {
    validateAssertionResult(entry);
    return entry;
  });
  list(value.turns, 32);
  value.turns.forEach(validateTurn);
  if (value.baseline !== undefined) validateBaseline(value.baseline);
  if (value.dependencyInventory !== undefined)
    validateDependencyInventory(value.dependencyInventory);
  if (value.evidence !== undefined) validateEvidence(value.evidence);
  requireCondition(
    typeof value.cleanupComplete === "boolean" &&
      typeof value.persisted === "boolean",
    "Invalid finalization facts",
  );
  list(value.finalizationFailures, 16);
  for (const entry of [
    ...value.finalizationFailures,
    ...(value.primaryFailure === undefined ? [] : [value.primaryFailure]),
  ]) {
    object(entry);
    text(entry.stage);
    text(entry.message, 8192);
  }
  if (
    value.status === "passed" ||
    value.status === "expected-refusal" ||
    value.status === "recovered"
  )
    requireCondition(
      value.cleanupComplete &&
        value.persisted &&
        unrun.length === 0 &&
        value.primaryFailure === undefined &&
        value.finalizationFailures.length === 0 &&
        value.assertions.length > 0 &&
        assertionResults.every((entry) => entry.passed),
      "Success requires assertions and finalized cleanup/persistence",
    );
}
