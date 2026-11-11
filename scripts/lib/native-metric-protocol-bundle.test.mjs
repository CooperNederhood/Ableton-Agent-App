/* global AbortController */
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";
import { createSyntheticMetricListeningObservation } from "../../packages/protocol/src/metric-testing.ts";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";
import { compileNativeMetricProtocol } from "./native-metric-protocol-bundle.mjs";

vi.mock("esbuild", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, build: vi.fn(actual.build) };
});

const directories = [];
afterEach(async () => {
  vi.mocked(build).mockReset();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function lifecycle(signal) {
  const events = [];
  const trace = {
    traceId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
  };
  return {
    trace,
    events,
    ...createNativeRunnerLifecycle({
      telemetry: { enqueue: (event) => events.push(event) },
      sanitize: sanitizeTelemetryAttributes,
      trace,
      signal,
    }),
  };
}

describe("canonical native metric CommonJS protocol bundle", () => {
  it("preserves canonical validation and budget admission without Object.hasOwn in Node for Max", async () => {
    const owner = lifecycle();
    const result = await compileNativeMetricProtocol({ stage: owner.stage });
    const parent = resolve(".test-artifacts/independent-metric-listening");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "metric-codec-"));
    directories.push(directory);
    await writeFile(join(directory, "package.json"), '{"type":"commonjs"}');
    const path = join(directory, result.fileName);
    await writeFile(path, result.source);
    const observation = createSyntheticMetricListeningObservation();
    const reply = execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `
      delete Object.hasOwn;
      const Module = require("node:module");
      const original = Module._load;
      Module._load = function (name, ...args) {
        if (name !== process.argv[1]) throw new Error("external_dependency:" + name);
        return original.call(this, name, ...args);
      };
      const codec = require(process.argv[1]);
      const observation = JSON.parse(process.argv[2]);
      const parsed = codec.metricAudioObservationSchema.parse(observation);
      const producer = codec.listenerMetricProducerSchema.parse({
        producerId: parsed.ownership.listenerId,
        instanceId: "synthetic-compiler-instance",
        displayName: "Synthetic metric producer",
        signalKind: "audio",
        schemaVersion: codec.LISTENER_METRIC_PRODUCER_SCHEMA_VERSION
      });
      const g = parsed.geometry;
      const detector = parsed.metrics.attacks.algorithm;
      const config = codec.nativeMetricListeningConfigSchema.parse({
        scope: codec.LISTENER_METRIC_SCOPE,
        algorithmVersion: codec.LISTENER_METRIC_ALGORITHM_VERSION,
        mode: "arrangement", sourceEvidence: "transport-only",
        sourceContext: parsed.source,
        geometry: codec.createMetricListeningGeometry({
          sampleRate: g.sampleRate, vectorSize: g.vectorSize,
          tempoBpm: g.tempoBpm, startBeat: g.startBeat, endBeat: g.endBeat,
          startSample: 0
        }),
        timingPolicy: parsed.alignment.policy,
        grid: {beats:0.25,anchor:"global-beat-grid",rounding:"nearest-sample",coordinates:"capture-local"},
        requestedMetrics: parsed.requestedMetrics,
        attacks: {thresholdDb:detector.thresholdDb,minSpacingSamples:detector.minSpacingSamples}
      });
      const admission = codec.admitMetricListeningBudget({
        config, ownership: parsed.ownership, source: parsed.source, jobId: "synthetic-budget"
      });
      const analyzerAdmission = codec.admitMetricListeningBudget({
        config: {
          ...config,
          requestedMetrics: ["level", "spectral-centroid", "attacks", "mel-bands", "pitch", "spectral-shape"]
        },
        ownership: parsed.ownership, source: parsed.source, jobId: "synthetic-analyzer-budget"
      });
      const fault = codec.analyzerNativeSourceIdentitySchema.parse({
        schema: "analyzer-native-source-identity/v1", producerAbi: 3,
        expectedEpoch: 1, expectedGeneration: 1, completedFrames: 21,
        sourceAbi: 3, sourceEpoch: 1, sourceRejected: 14,
        sourceSealedEpoch: null, sourceClock: 1858560
      });
      observation.metrics.attacks.records[0].events[0].strength = 0;
      process.stdout.write(JSON.stringify({
        version: codec.LISTENER_VERSION_METRIC,
        capability: codec.LISTENER_CAPABILITY_METRIC,
        melCapability: codec.LISTENER_CAPABILITY_MEL,
        melBandCount: codec.MEL_BAND_PROFILE.bandCount,
        rejectsMissingMelTimeline: !codec.melBandTimelineSchema.safeParse({}).success,
        outcome: parsed.outcome,
        rejectsForgedEvent: !codec.metricAudioObservationSchema.safeParse(observation).success,
        rejectsLegacyControl: !codec.listenerControlMetricSchema.safeParse({listenerVersion:4}).success,
        producerSchema: producer.schemaVersion,
        rejectsLegacyProducer: !codec.listenerMetricProducerSchema.safeParse({...producer,schemaVersion:"audio-observation/v2"}).success,
        budgetAdmitted: admission.admitted,
        analyzerBudgetAdmitted: analyzerAdmission.admitted,
        preservesFaultOperands: fault.sourceRejected === 14 && fault.sourceSealedEpoch === null,
        rejectsUnboundedFault: !codec.analyzerNativeSourceIdentitySchema.safeParse({...fault,completedFrames:704}).success,
        sourceContextBound: JSON.stringify(config.sourceContext) === JSON.stringify(parsed.source),
        rejectsForeignSourceRange: !codec.nativeMetricListeningConfigSchema.safeParse({
          ...config, sourceContext: {
            ...parsed.source, transport: {...parsed.source.transport,endBeat:g.endBeat+1}
          }
        }).success,
        proofChecker: typeof codec.assertNativeMetricSourceCoverage,
        budgetChecker: typeof codec.admitMetricListeningBudget,
        rebuildsReportRows: JSON.stringify(codec.createMetricObservationReportRows({
          ...parsed, rows: []
        })) === JSON.stringify(parsed.rows)
      }));
    `,
        path,
        JSON.stringify(observation),
      ],
      {
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(reply)).toEqual({
      version: 5,
      capability: "audio-listener/independent-metric-timelines-v1",
      melCapability: "audio-listener/mel-band-timelines-v1",
      melBandCount: 24,
      rejectsMissingMelTimeline: true,
      outcome: "complete",
      rejectsForgedEvent: true,
      rejectsLegacyControl: true,
      producerSchema: "metric-audio-observation/v1",
      rejectsLegacyProducer: true,
      budgetAdmitted: true,
      analyzerBudgetAdmitted: true,
      preservesFaultOperands: true,
      rejectsUnboundedFault: true,
      sourceContextBound: true,
      rejectsForeignSourceRange: true,
      proofChecker: "function",
      budgetChecker: "function",
      rebuildsReportRows: true,
    });
    expect(
      result.provenance.inputs.some(
        (input) =>
          input.path === "packages/protocol/src/metric-observation-schemas.ts",
      ),
    ).toBe(true);
    expect(
      result.provenance.inputs.some(
        (input) =>
          input.path === "packages/protocol/src/metric-listening-budget.ts",
      ),
    ).toBe(true);
    expect(
      result.provenance.inputs.some(
        (input) =>
          input.path ===
          "packages/signal-routing/src/listener-metric-contracts.ts",
      ),
    ).toBe(true);
    expect(
      result.provenance.inputs.every(
        (input) =>
          !input.path.includes("/dist/") && !input.path.startsWith("../"),
      ),
    ).toBe(true);
    expect(result.source).toContain("MIT License");
    expect(owner.events.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    expect(
      owner.events.every(
        (event) =>
          event.trace.traceId === owner.trace.traceId &&
          event.correlationId === owner.trace.correlationId &&
          event.durationMs >= 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(owner.events)).not.toContain("Bundled Zod license");
  });

  it("is deterministic and pins the exact compiler inputs", async () => {
    const first = await compileNativeMetricProtocol({
      stage: lifecycle().stage,
    });
    const second = await compileNativeMetricProtocol({
      stage: lifecycle().stage,
    });
    expect(second.source).toBe(first.source);
    expect(second.provenance).toEqual(first.provenance);
    expect(first.provenance.bytes).toBe(
      Buffer.byteLength(first.source, "utf8"),
    );
    expect(first.provenance.inputs.length).toBeGreaterThan(1);
    for (const input of first.provenance.inputs)
      expect(input).toMatchObject({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    expect(Object.isFrozen(first.provenance.inputs)).toBe(true);
    expect(Object.isFrozen(first.provenance.inputs[0])).toBe(true);
    expect(() => {
      first.provenance.inputs[0].sha256 = "forged";
    }).toThrow();
  });

  it("retains cancellation attribution without compiling or returning an artifact", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled metric codec"));
    const owner = lifecycle(controller.signal);
    await expect(
      compileNativeMetricProtocol({
        stage: owner.stage,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Cancelled metric codec");
    expect(owner.events.map((event) => event.stage)).toEqual([
      "queued",
      "cancelled",
    ]);
    expect(owner.events.at(-1)).toMatchObject({
      outcome: "cancelled",
      trace: { traceId: owner.trace.traceId },
    });
  });

  it("requires the caller-owned lifecycle instead of silently compiling", async () => {
    await expect(compileNativeMetricProtocol()).rejects.toThrow(
      "native_metric_codec_lifecycle_required",
    );
  });

  it("reports compilation failure with redaction, timing and causal attribution", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    vi.mocked(build).mockRejectedValueOnce(
      new Error(`Authorization: Bearer ${secret}`),
    );
    const owner = lifecycle();
    await expect(
      compileNativeMetricProtocol({ stage: owner.stage }),
    ).rejects.toThrow("Authorization");
    expect(owner.events.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "failed",
    ]);
    expect(JSON.stringify(owner.events)).not.toContain(secret);
    for (const [index, event] of owner.events.entries()) {
      expect(event.causationId).toBe(
        index === 0 ? owner.trace.causationId : owner.events[index - 1].id,
      );
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not return a compiled artifact when cancellation wins after compilation", async () => {
    const actual = await vi.importActual("esbuild");
    const controller = new AbortController();
    vi.mocked(build).mockImplementationOnce(async (options) => {
      const result = await actual.build(options);
      controller.abort(new Error("Cancelled after compilation"));
      return result;
    });
    const owner = lifecycle(controller.signal);
    await expect(
      compileNativeMetricProtocol({
        stage: owner.stage,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Cancelled after compilation");
    expect(owner.events.at(-1)).toMatchObject({
      stage: "cancelled",
      outcome: "cancelled",
    });
    expect(owner.events.some((event) => event.stage === "completed")).toBe(
      false,
    );
  });

  it.each(["external-import", "unrecorded-input"])(
    "rejects a compiler output with %s rather than emitting an unverifiable bundle",
    async (failure) => {
      const actual = await vi.importActual("esbuild");
      vi.mocked(build).mockImplementationOnce(async (options) => {
        const result = await actual.build(options);
        if (failure === "external-import") {
          Object.values(result.metafile.outputs)[0].imports.push({
            path: "unreviewed",
            kind: "require-call",
            external: true,
          });
        } else {
          result.metafile.inputs["unrecorded.ts"] = { bytes: 1, imports: [] };
        }
        return result;
      });
      const owner = lifecycle();
      await expect(
        compileNativeMetricProtocol({ stage: owner.stage }),
      ).rejects.toThrow(
        failure === "external-import"
          ? "native_metric_codec_not_self_contained"
          : "native_metric_codec_unpinned_input",
      );
      expect(owner.events.at(-1)).toMatchObject({
        stage: "failed",
        outcome: "failure",
      });
      expect(owner.events.some((event) => event.stage === "completed")).toBe(
        false,
      );
    },
  );
});
