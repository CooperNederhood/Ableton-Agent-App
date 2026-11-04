import { randomUUID, createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  verifyNativeMetricEngineeringBinding,
  admitNativeMetricScenarioFixture,
} from "./native-metric-scenario.mjs";
import {
  reviewNativeScenario,
  admitNativeScenarios,
  runNativeScenarioGroup,
} from "./native-listening-runner.mjs";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const partial = async () =>
  JSON.parse(
    await readFile(
      "integration/live-scenarios/native-metric-session-midi-partial-spectrum.json",
      "utf8",
    ),
  );
const normal = async () =>
  JSON.parse(
    await readFile(
      "integration/live-scenarios/native-metric-session-midi-spectrum.json",
      "utf8",
    ),
  );
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(tagged = true) {
  const runtimeEntry = tagged
    ? "audio_listener_native_v5_unavailable_spectrum_max.js"
    : "audio_listener_native_v5_max.js";
  const runtime = await readFile(`max-patches/audio-listener/${runtimeEntry}`);
  const metadata = {
    schema: "native-metric-engineering-fixture/v1",
    id: "native5-unavailable-spectrum/v1",
    engineeringOnly: true,
    unavailableMetric: "spectral-centroid",
    sourceSemantics: "spectral-acquisition-not-started",
    runtimeEntry,
    runtimeEntrySha256: hash(runtime),
  };
  const artifact = {
    nativeVersion: 5,
    nativeMode: true,
    realLiveValidated: false,
    resources: [{ name: runtimeEntry, sha256: hash(runtime) }],
    ...(tagged ? { engineeringFixture: metadata } : {}),
  };
  const root = resolve(
    ".test-artifacts/independent-metric-listening",
    `engineering-admission-unit-${randomUUID()}`,
  );
  await mkdir(root, { recursive: true });
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const candidateDirectory = join(root, "candidate");
  await mkdir(candidateDirectory);
  const bytes = Buffer.from(JSON.stringify(artifact));
  await writeFile(
    join(candidateDirectory, "audio-listener-manifest.json"),
    bytes,
  );
  await writeFile(join(candidateDirectory, runtimeEntry), runtime);
  const input = {
    nativeVersion: 5,
    candidateDirectory,
    candidateManifestSha256: hash(bytes),
    ...(tagged
      ? { engineeringFixture: globalThis.structuredClone(metadata) }
      : {}),
  };
  return {
    root,
    artifact,
    metadata,
    input,
    runtime,
    checkArtifact: vi.fn(async () => artifact),
  };
}

it("reviews deliberate partial only with the explicit engineering fixture policy", async () => {
  const manifest = await partial();
  expect(reviewNativeScenario(manifest).engineeringFixtureId).toBe(
    "native5-unavailable-spectrum/v1",
  );
  expect(() =>
    reviewNativeScenario({
      ...manifest,
      setupContract: {
        ...manifest.setupContract,
        engineeringFixture: undefined,
      },
    }),
  ).toThrow(/Unreviewed/);
  expect(() =>
    reviewNativeScenario({
      ...manifest,
      setupContract: {
        ...manifest.setupContract,
        engineeringFixture: "foreign",
      },
    }),
  ).toThrow(/Unreviewed/);
});

it("rejects repaired defaults for deliberate partial, without artifact checking or process launch", async () => {
  const f = await fixture(false);
  const reviewed = reviewNativeScenario(await partial());
  await expect(
    admitNativeMetricScenarioFixture(reviewed, f.input, {
      checkArtifact: f.checkArtifact,
    }),
  ).rejects.toThrow(/engineering fixture/);
  expect(f.checkArtifact).not.toHaveBeenCalled();
  const inputPath = join(f.root, "input.json");
  await writeFile(inputPath, JSON.stringify(f.input));
  await expect(
    admitNativeScenarios({
      manifests: [await partial()],
      skipInstall: true,
      computerUse: false,
      approveAll: false,
      inputV5: inputPath,
    }),
  ).rejects.toThrow(/engineering fixture/);
  const launch = vi.fn();
  await expect(
    runNativeScenarioGroup({
      manifests: [await partial()],
      controller: {
        close: vi.fn(),
        publicRecord: () => undefined,
        assertNoPreExistingLive: vi.fn(),
        launch,
      },
      applicationPath: "must-not-launch",
      createRunner: () =>
        admitNativeMetricScenarioFixture(reviewed, f.input, {
          checkArtifact: f.checkArtifact,
        }),
    }),
  ).rejects.toThrow(/engineering fixture/);
  expect(launch).not.toHaveBeenCalled();
});

it("admits a valid explicit controlled package only after manifest, entry hash and artifact check binding", async () => {
  const f = await fixture();
  const reviewed = reviewNativeScenario(await partial());
  const result = await admitNativeMetricScenarioFixture(reviewed, f.input, {
    checkArtifact: f.checkArtifact,
  });
  expect(result).toMatchObject({
    variant: "native5-unavailable-spectrum/v1",
    runtimeEntrySha256: f.metadata.runtimeEntrySha256,
    candidateManifestSha256: f.input.candidateManifestSha256,
  });
  expect(f.checkArtifact).toHaveBeenCalledOnce();
});

it.each([
  "input-foreign",
  "artifact-foreign",
  "input-only-tag",
  "artifact-only-tag",
  "forged-hash",
  "promoted",
  "extra-tag-key",
  "wrong-resource",
  "wrong-input-version",
  "wrong-artifact-version",
])(
  "denies %s without weakening deliberate-partial fixture binding",
  async (failure) => {
    const f = await fixture();
    const reviewed = reviewNativeScenario(await partial());
    const input = globalThis.structuredClone(f.input);
    const artifact = globalThis.structuredClone(f.artifact);
    if (failure === "input-foreign") input.engineeringFixture.id = "foreign";
    if (failure === "artifact-foreign")
      artifact.engineeringFixture.id = "foreign";
    if (failure === "input-only-tag") delete artifact.engineeringFixture;
    if (failure === "artifact-only-tag") delete input.engineeringFixture;
    if (failure === "forged-hash")
      input.engineeringFixture.runtimeEntrySha256 = "a".repeat(64);
    if (failure === "promoted") artifact.realLiveValidated = true;
    if (failure === "extra-tag-key")
      input.engineeringFixture.allowDefault = true;
    if (failure === "wrong-resource")
      artifact.resources[0].sha256 = "b".repeat(64);
    if (failure === "wrong-input-version") input.nativeVersion = 4;
    if (failure === "wrong-artifact-version") artifact.nativeVersion = 4;
    expect(() =>
      verifyNativeMetricEngineeringBinding(
        reviewed,
        input,
        artifact,
        f.runtime,
      ),
    ).toThrow();
  },
);

it.each([true, false])(
  "attributes bounded admission lifecycle proof, timing and first-failure termination (valid=%s)",
  async (valid) => {
    const f = await fixture(valid);
    const reviewed = reviewNativeScenario(await partial());
    const events = [];
    const trace = {
      traceId: "fixture-trace",
      correlationId: "fixture-correlation",
      causationId: "fixture-root",
    };
    const lifecycle = createNativeRunnerLifecycle({
      telemetry: { enqueue: (event) => events.push(event) },
      sanitize: (attributes) => globalThis.structuredClone(attributes),
      trace,
    });
    const attributes = { expectedFixtureId: reviewed.engineeringFixtureId };
    const admission = lifecycle.stage(
      "metric-fixture-admission",
      async () => {
        const proof = await admitNativeMetricScenarioFixture(
          reviewed,
          f.input,
          {
            checkArtifact: f.checkArtifact,
          },
        );
        attributes.admission = proof;
        return proof;
      },
      attributes,
    );
    if (valid)
      await expect(admission).resolves.toMatchObject({
        variant: attributes.expectedFixtureId,
      });
    else await expect(admission).rejects.toThrow(/engineering fixture/);
    expect(events.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      valid ? "completed" : "failed",
    ]);
    for (const [index, event] of events.entries()) {
      expect(event.name).toBe(
        `integration.native_listening.metric-fixture-admission.${event.stage}`,
      );
      expect(event.source).toBe("application");
      expect(event.trace.traceId).toBe(trace.traceId);
      expect(event.correlationId).toBe(trace.correlationId);
      expect(event.causationId).toBe(
        index === 0 ? trace.causationId : events[index - 1].id,
      );
      expect(event.durationMs).toBeGreaterThanOrEqual(
        index === 0 ? 0 : events[index - 1].durationMs,
      );
    }
    if (valid)
      expect(events.at(-1).attributes.admission.candidateManifestSha256).toBe(
        f.input.candidateManifestSha256,
      );
    else expect(f.checkArtifact).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain(f.root);
    expect(JSON.stringify(events)).not.toContain(f.runtime.toString("utf8"));
  },
);

it("denies all tagged/foreign fixture selections for normal positive scenarios; clean defaults remain admitted", async () => {
  const f = await fixture();
  const reviewed = reviewNativeScenario(await normal());
  for (const tag of [f.metadata, null, false, "foreign"]) {
    expect(() =>
      verifyNativeMetricEngineeringBinding(
        reviewed,
        { ...f.input, engineeringFixture: tag },
        f.artifact,
        f.runtime,
      ),
    ).toThrow(/engineering fixture/);
  }
  const defaults = await fixture(false);
  expect(
    verifyNativeMetricEngineeringBinding(
      reviewed,
      defaults.input,
      defaults.artifact,
    ),
  ).toMatchObject({ variant: "default" });
  expect(() =>
    verifyNativeMetricEngineeringBinding(reviewed, defaults.input, f.artifact),
  ).toThrow(/engineering fixture/);
  const admission = await admitNativeMetricScenarioFixture(
    reviewed,
    defaults.input,
    { checkArtifact: defaults.checkArtifact },
  );
  expect(admission.variant).toBe("default");
  expect(defaults.checkArtifact).toHaveBeenCalledOnce();
});

it.each(["artifact-check-failed", "manifest-replaced", "entry-replaced"])(
  "fails %s during checked admission without retry",
  async (failure) => {
    const f = await fixture();
    const checkArtifact = vi.fn(async () => {
      if (failure === "artifact-check-failed") throw new Error(failure);
      if (failure === "manifest-replaced")
        await writeFile(
          join(f.input.candidateDirectory, "audio-listener-manifest.json"),
          "{}",
        );
      if (failure === "entry-replaced")
        await writeFile(
          join(f.input.candidateDirectory, f.metadata.runtimeEntry),
          "changed-after-check",
        );
      return f.artifact;
    });
    await expect(
      admitNativeMetricScenarioFixture(
        reviewNativeScenario(await partial()),
        f.input,
        { checkArtifact },
      ),
    ).rejects.toThrow();
    expect(checkArtifact).toHaveBeenCalledOnce();
  },
);

it("rejects actual entry or manifest bytes changed after explicit pinning", async () => {
  const f = await fixture();
  await writeFile(
    join(f.input.candidateDirectory, f.metadata.runtimeEntry),
    "changed-entry",
  );
  await expect(
    admitNativeMetricScenarioFixture(
      reviewNativeScenario(await partial()),
      f.input,
      { checkArtifact: f.checkArtifact },
    ),
  ).rejects.toThrow(/hash/);
  await writeFile(
    join(f.input.candidateDirectory, f.metadata.runtimeEntry),
    f.runtime,
  );
  await writeFile(
    join(f.input.candidateDirectory, "audio-listener-manifest.json"),
    "{}",
  );
  await expect(
    admitNativeMetricScenarioFixture(
      reviewNativeScenario(await partial()),
      f.input,
      { checkArtifact: f.checkArtifact },
    ),
  ).rejects.toThrow(/hash/);
});
