import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { sessionListeningPreflightResultSchema } from "@ableton-agent/protocol";
import {
  midiContentIdentity,
  declaredSourceBaseline,
  validateFixtureSourceEvidence,
} from "./sources.js";
import {
  validateBaseline,
  validateFixture,
  validateSupportedAudioBaseline,
  validateSupportedSessionBaseline,
} from "./validation.js";
import { SUPPORTED_AUDIO_BASELINE } from "./contracts.js";
import { sameSource } from "./assertions.js";
import { runAcceptance } from "./coordinator.js";
import { stageFixture, dependencyInventoryHashes } from "./staging.js";
import * as staging from "./staging.js";
import type {
  AcceptanceDriver,
  FixtureManifest,
  LifecycleEvent,
} from "./contracts.js";

const ref = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const state = {
    transportPlaying: false,
    globalBeat: 5.5,
    startTimeBeats: 0,
    playingPosition: 0,
    targetPlaying: true,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: 1,
    firedSlotIndex: -1,
    selectedClipReference: null,
  };
  const devices = ["Operator", "Listener"].map((name, index) => ({
    reference: ref(4 + index),
    trackReference: ref(1),
    trackIndex: 0,
    index,
    name,
    className: index === 0 ? "Operator" : "MxDeviceAudioEffect",
    classDisplayName: name,
    enabled: true,
    parameterCount: 1,
    canHaveChains: false,
    canHaveDrumPads: false,
  }));
  const inventory = { devices, total: 2, offset: 0, limit: 8 };
  return {
    source: {
      schemaVersion: 1,
      queryId: ref(3),
      projectRevision: 0,
      evidence: "message-rate-only",
      nativeAlignment: "unverified",
      sourceKind: "midi",
      positionUnit: "beats",
      target: {
        view: "session",
        track: {
          kind: "regular",
          index: 0,
          expectedReference: ref(1),
          expectedName: "MIDI",
        },
        sceneIndex: 1,
        expectedClipReference: ref(2),
        expectedClipName: "Quarter notes",
      },
      before: state,
      after: state,
      settings: {
        tempoBpm: 120,
        signatureNumerator: 4,
        signatureDenominator: 4,
        globalQuantization: 4,
        launchQuantization: 0,
        launchMode: 0,
        legato: false,
        followActionEnabled: false,
        startMarker: 0,
        endMarker: 4,
        loopStart: 0,
        loopEnd: 4,
        looping: true,
      },
    },
    midi: {
      clip: {
        reference: ref(2),
        name: "Quarter notes",
        trackReference: ref(1),
        trackIndex: 0,
        sceneIndex: 1,
        length: 4,
        noteCount: 4,
      },
      notes: [0, 1, 2, 3].map((startTime) => ({
        pitch: 60,
        startTime,
        duration: 0.25,
        velocity: 100,
        mute: false,
      })),
      offset: 0,
      limit: 2048,
      totalNotes: 4,
      truncated: false,
    },
    instrumentChain: {
      before: inventory,
      after: structuredClone(inventory),
      devices: devices.map((device, index) => ({
        device,
        total: 1,
        offset: 0,
        limit: 256,
        parameters: [
          {
            reference: ref(10 + index),
            deviceReference: device.reference,
            index: 0,
            name: index === 1 ? "Attack rise dB" : "Level",
            value: 0.5,
            normalizedValue: 0.5,
            min: 0,
            max: 1,
            isQuantized: false,
            isEnabled: true,
            valueItemCount: 0,
          },
        ],
      })),
    },
    recording: {
      action: "inspect",
      state: {
        arrangementRecord: false,
        sessionRecord: false,
        overdub: false,
        sessionAutomationRecord: false,
        punchIn: false,
        punchOut: false,
      },
    },
  };
}
const placement = { trackIndex: 0, deviceIndex: 1, deviceReference: ref(5) };
const binding = {
  slot: "MidiTrack:1/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:1",
  sourcePath: "Presets/Listener.amxd",
  dependency: "machine-listening" as const,
  trackIndex: 0,
  deviceIndex: 1,
};
function admitted() {
  const preflight = fixture();
  const hashes = midiContentIdentity(preflight, placement);
  const definition = {
    id: "midi-source",
    trackName: "MIDI",
    clipName: "Quarter notes",
    trackIndex: 0,
    sceneIndex: 1,
    listenerBindingSlot: binding.slot,
    midi: {
      notesSha256: hashes.midiNotesSha256,
      instrumentChainSha256: hashes.instrumentChainSha256,
    },
  };
  const manifest: FixtureManifest = {
    schemaVersion: 1,
    id: "combined",
    qualification: "synthetic-only",
    provenance: { ownership: "authored", description: "Controlled test only" },
    dependencies: ["machine-listening"],
    listenerBindings: [binding],
    resources: [
      {
        path: "set.als",
        target: "project.als",
        sha256: "1".repeat(64),
        bytes: 1,
      },
    ],
    sources: [definition],
    baseline: {},
  };
  const evidence = {
    source: { trackId: ref(1), clipId: ref(2), slotIndex: 1, ...hashes },
    listenerId: "listener-1",
    facts: {
      trackName: "MIDI",
      clipName: "Quarter notes",
      sceneIndex: 1,
      trackIndex: 0,
    },
    midi: sessionListeningPreflightResultSchema.parse(preflight) as Extract<
      ReturnType<typeof sessionListeningPreflightResultSchema.parse>,
      { midi: unknown }
    >,
    listenerPlacement: placement,
  };
  return { definition, manifest, evidence };
}

describe("bounded independently declared MIDI source identity", () => {
  it("supports one combined fixture with common type-specific baseline facts omitted", () => {
    const { manifest, definition } = admitted();
    const common = Object.fromEntries(
      Object.entries({
        ...SUPPORTED_AUDIO_BASELINE,
        globalQuantization: "bar",
        currentSongTime: 2.059377861721612,
        playingSessionClips: 2,
        rememberedSessionClips: 2,
      }).filter(
        ([key]) => key !== "clipWarped" && key !== "clipLaunchQuantization",
      ),
    );
    const combined: FixtureManifest = {
      ...manifest,
      baseline: common,
      resources: [
        ...manifest.resources,
        {
          path: "audio.wav",
          target: "media/resource-001.wav",
          sha256: "0".repeat(64),
          bytes: 1,
        },
      ],
      sources: [
        {
          id: "audio",
          trackName: "audio-track",
          clipName: "clip-1",
          sceneIndex: 0,
          mediaTarget: "media/resource-001.wav",
          clipLaunchQuantization: "global",
        },
        { ...definition, clipLaunchQuantization: "bar" },
      ],
    };
    expect(() => validateFixture(combined)).not.toThrow();
    for (const source of combined.sources!) {
      const expected = declaredSourceBaseline(combined, source);
      expect(expected.clipLaunchQuantization).toBe(
        source.clipLaunchQuantization,
      );
      expect(expected).not.toHaveProperty("clipWarped");
      expect(() =>
        validateSupportedSessionBaseline(
          expected,
          "mediaTarget" in source ? "audio" : "midi",
        ),
      ).not.toThrow();
    }
    expect(() =>
      validateSupportedSessionBaseline(common, "midi"),
    ).not.toThrow();
    expect(() =>
      validateSupportedSessionBaseline(
        { ...common, rememberedSessionClips: null },
        "midi",
      ),
    ).toThrow();
  });
  it("admits explicit remembered playing counts without allowing running, queued or inconsistent state", () => {
    const baseline = {
      ...SUPPORTED_AUDIO_BASELINE,
      currentSongTime: 2.059377861721612,
      globalQuantization: "bar",
      playingSessionClips: 2,
      rememberedSessionClips: 2,
    };
    expect(() => validateSupportedAudioBaseline(baseline)).not.toThrow();
    for (const patch of [
      { playingSessionClips: 0 },
      { rememberedSessionClips: 1 },
      { rememberedSessionClips: undefined },
      { queuedSessionClips: 1 },
      { transportPlaying: true },
    ])
      expect(() =>
        validateSupportedAudioBaseline({ ...baseline, ...patch }),
      ).toThrow();
  });
  it.each([
    "success",
    "source-quantization",
    "wrong-notes",
    "wrong-instrument",
    "partial",
    "recording",
    "running",
    "cancelled",
  ] as const)(
    "runs MIDI admission through the existing coordinator with cleanup and lifecycle: %s",
    async (mode) => {
      const { manifest, definition, evidence } = admitted();
      const success = mode === "success" || mode === "source-quantization";
      if (mode === "source-quantization") {
        evidence.midi.source.settings.launchQuantization = 5;
        Object.assign(evidence.facts, { clipLaunchQuantization: "bar" });
      }
      const root = resolve(".test-artifacts", `midi-admission-${randomUUID()}`);
      const catalogRoot = join(root, "catalog"),
        workingRoot = join(root, "working");
      const candidateRoot = join(root, "candidate");
      const digest = (text: string) =>
        createHash("sha256").update(text).digest("hex");
      const fixtureManifest: FixtureManifest = {
        ...manifest,
        ...(mode === "source-quantization"
          ? { baseline: { clipLaunchQuantization: "global" } }
          : {}),
        resources: [
          {
            path: "set.als",
            target: "project.als",
            sha256: digest("set"),
            bytes: 3,
          },
        ],
        sources: [
          {
            ...definition,
            ...(mode === "source-quantization"
              ? { clipLaunchQuantization: "bar" as const }
              : {}),
            midi: {
              notesSha256:
                mode === "wrong-notes"
                  ? "0".repeat(64)
                  : definition.midi.notesSha256,
              instrumentChainSha256:
                mode === "wrong-instrument"
                  ? "0".repeat(64)
                  : definition.midi.instrumentChainSha256,
            },
          },
        ],
      };
      const inventory = {
        schemaVersion: 1 as const,
        candidateRoot,
        resources: [
          {
            id: "machine-listening",
            path: "listener.amxd",
            target: "dependencies/listener.amxd",
            sha256: digest("listener"),
            bytes: 8,
          },
        ],
      };
      // Staging provenance has its own suite; isolate coordinator source admission here.
      const provenance = vi
        .spyOn(staging, "verifyDependencyInventory")
        .mockResolvedValue(undefined);
      let cleanup = false,
        submitted = false,
        persisted = false;
      const events: LifecycleEvent[] = [];
      const cancellation = new AbortController();
      const identity = {
        appSessionId: "app",
        conversationId: "conversation",
        agentId: "agent",
      };
      const driver: AcceptanceDriver = {
        schemaVersion: 1,
        capabilities: ["session-midi"],
        launch: async () => {},
        ready: async () => identity,
        subscribe: async () => ({
          close: async () => {},
          waitForTurn: async (submission) => ({
            ...submission,
            schemaVersion: 1,
            assistantMessageId: "assistant",
            terminal: true,
            status: "completed",
            assistantText: "Observed",
            captures: [],
            contexts: [],
            facts: {},
          }),
        }),
        readBaseline: async () => {
          if (mode === "partial") evidence.midi.midi.truncated = true;
          if (mode === "recording")
            evidence.midi.recording.state.sessionRecord = true;
          if (mode === "running")
            evidence.midi.source.after.transportPlaying = true;
          if (mode === "cancelled")
            cancellation.abort(new Error("Controlled cancellation"));
          return {
            schemaVersion: 1,
            facts:
              mode === "source-quantization"
                ? { clipLaunchQuantization: "bar" }
                : {},
            sources: { [definition.id]: evidence },
            dependencyHashes: dependencyInventoryHashes(inventory),
          };
        },
        submit: async () => {
          submitted = true;
          return {
            ...identity,
            userMessageId: "message",
            operationId: "operation",
          };
        },
        collect: async () => ({
          schemaVersion: 1,
          facts: { verified: true },
          contexts: [],
          unchanged: [],
        }),
        cleanup: async (ctx) => {
          expect(ctx.signal.aborted).toBe(false);
          cleanup = true;
        },
      };
      try {
        await Promise.all(
          [catalogRoot, workingRoot, candidateRoot].map((path) =>
            mkdir(path, { recursive: true }),
          ),
        );
        await writeFile(join(catalogRoot, "set.als"), "set");
        await writeFile(join(candidateRoot, "listener.amxd"), "listener");
        const result = await runAcceptance({
          fixture: fixtureManifest,
          driver,
          signal: cancellation.signal,
          scenario: {
            schemaVersion: 1,
            id: "midi-case",
            fixtureId: fixtureManifest.id,
            requiredCapabilities: ["session-midi"],
            permissions: [],
            budget: { runMs: 2000, cleanupMs: 1000, persistenceMs: 1000 },
            steps: [
              {
                id: "listen",
                sourceId: definition.id,
                message: "Listen",
                timeoutMs: 1000,
                assertions: [],
              },
            ],
            assertions: [
              {
                name: "fact-equals",
                parameters: { key: "verified", expected: true },
              },
            ],
          },
          stage: (ctx) =>
            stageFixture({
              fixture: fixtureManifest,
              catalogRoot,
              workingRoot,
              runId: ctx.runId,
              signal: ctx.signal,
              allowSynthetic: true,
            }),
          provision: async (ctx) => {
            await mkdir(
              join(ctx.stagedFixture!.workingDirectory, "dependencies"),
            );
            await writeFile(
              join(
                ctx.stagedFixture!.workingDirectory,
                "dependencies/listener.amxd",
              ),
              "listener",
            );
            return inventory;
          },
          persist: async () => {
            persisted = true;
          },
          event: (event) => events.push(event),
        });
        expect(result.status, JSON.stringify(result.primaryFailure)).toBe(
          success ? "passed" : mode === "cancelled" ? "cancelled" : "blocked",
        );
        expect(submitted).toBe(success);
        expect(cleanup && persisted && result.cleanupComplete).toBe(true);
        expect(
          events.some(
            (event) =>
              event.stage === "preconditions" && event.phase === "started",
          ),
        ).toBe(true);
        expect(
          events.every(
            (event) =>
              event.traceId === result.traceId &&
              event.correlationId.length > 0 &&
              event.causationId.length > 0 &&
              event.durationMs >= 0,
          ),
        ).toBe(true);
        expect(
          events.findIndex(
            (event) =>
              event.stage === "preconditions" && event.phase === "started",
          ),
        ).toBeLessThan(
          events.findIndex(
            (event) => event.stage === "cleanup" && event.phase === "started",
          ),
        );
      } finally {
        provenance.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("admits declared MIDI without manufactured audio file hashes", () => {
    const { manifest, definition, evidence } = admitted();
    expect(() => validateFixture(manifest)).not.toThrow();
    expect(() =>
      validateBaseline({
        schemaVersion: 1,
        facts: {},
        sources: { "midi-source": evidence },
        dependencyHashes: {},
      }),
    ).not.toThrow();
    expect(() =>
      validateFixtureSourceEvidence(manifest, definition, evidence),
    ).not.toThrow();
    expect(evidence.source).not.toHaveProperty("mediaSha256");
    expect(sameSource(evidence.source, { ...evidence.source })).toBe(true);
    for (const patch of [
      { midiNotesSha256: "0".repeat(64) },
      { instrumentChainSha256: "0".repeat(64) },
      { clipId: ref(8) },
      { slotIndex: 2 },
    ])
      expect(
        sameSource(evidence.source, { ...evidence.source, ...patch }),
      ).toBe(false);
    expect(
      sameSource(evidence.source, {
        trackId: ref(1),
        clipId: ref(2),
        slotIndex: 1,
        mediaSha256: evidence.source.midiNotesSha256,
      }),
    ).toBe(false);
  });
  it("pins source-specific clip quantization independently of common baseline defaults", () => {
    const { manifest, definition, evidence } = admitted();
    const declared = { ...definition, clipLaunchQuantization: "bar" as const };
    const combined = {
      ...manifest,
      baseline: { clipLaunchQuantization: "global" },
      sources: [declared],
    };
    expect(() => validateFixture(combined)).not.toThrow();
    expect(() =>
      validateFixtureSourceEvidence(combined, declared, evidence),
    ).toThrow("quantization");
    const observed = {
      ...evidence,
      facts: { ...evidence.facts, clipLaunchQuantization: "bar" },
    };
    observed.midi.source.settings.launchQuantization = 5;
    expect(() =>
      validateFixtureSourceEvidence(combined, declared, observed),
    ).not.toThrow();
    observed.midi.source.settings.launchQuantization = 4;
    expect(() =>
      validateFixtureSourceEvidence(combined, declared, observed),
    ).toThrow("quantization");
    for (const value of [5, null, "unsupported", "Global", "half"])
      expect(() =>
        validateFixture({
          ...manifest,
          sources: [{ ...definition, clipLaunchQuantization: value }],
        }),
      ).toThrow();
  });
  it("is reference-neutral, order-neutral for notes, and preserves multiplicity", () => {
    const original = fixture();
    const changed = JSON.parse(
      JSON.stringify(original).replaceAll("10000000-", "20000000-"),
    ) as ReturnType<typeof fixture>;
    changed.midi.notes.reverse();
    expect(
      midiContentIdentity(changed, {
        ...placement,
        deviceReference: placement.deviceReference.replace(
          "10000000-",
          "20000000-",
        ),
      }),
    ).toEqual(midiContentIdentity(original, placement));
    original.midi.notes.push(original.midi.notes[0]!);
    original.midi.totalNotes++;
    original.midi.clip.noteCount++;
    expect(midiContentIdentity(original, placement).midiNotesSha256).not.toBe(
      midiContentIdentity(fixture(), placement).midiNotesSha256,
    );
  });
  it("preserves every note field and exposed instrument parameter state", () => {
    const expected = midiContentIdentity(fixture(), placement);
    for (const patch of [
      { pitch: 70 },
      { startTime: 0.1 },
      { duration: 0.6 },
      { velocity: 99 },
      { mute: true },
    ]) {
      const changed = fixture();
      Object.assign(changed.midi.notes[0]!, patch);
      expect(midiContentIdentity(changed, placement).midiNotesSha256).not.toBe(
        expected.midiNotesSha256,
      );
    }
    for (const patch of [
      { value: 0.6 },
      { name: "Other" },
      { normalizedValue: 0.6 },
      { isEnabled: false },
    ]) {
      const changed = fixture();
      Object.assign(changed.instrumentChain.devices[0]!.parameters[0]!, patch);
      expect(
        midiContentIdentity(changed, placement).instrumentChainSha256,
      ).not.toBe(expected.instrumentChainSha256);
    }
  });
  it("excludes only verified listener values, retaining its topology and parameter identities", () => {
    const expected = midiContentIdentity(fixture(), placement);
    const changed = fixture();
    Object.assign(changed.instrumentChain.devices[1]!.parameters[0]!, {
      value: 0.7,
      normalizedValue: 0.7,
    });
    expect(midiContentIdentity(changed, placement)).toEqual(expected);
    changed.instrumentChain.devices[1]!.parameters[0]!.name = "Different";
    expect(midiContentIdentity(changed, placement)).not.toEqual(expected);
    for (const patch of [
      { deviceReference: ref(4) },
      { deviceIndex: 0 },
      { trackIndex: 1 },
    ])
      expect(() =>
        midiContentIdentity(fixture(), { ...placement, ...patch }),
      ).toThrow();
  });
  it("rejects partial, malformed, wrong-type and inconsistent evidence", () => {
    for (const mutate of [
      (v: ReturnType<typeof fixture>) => {
        v.midi.truncated = true;
      },
      (v: ReturnType<typeof fixture>) => {
        v.midi.totalNotes++;
      },
      (v: ReturnType<typeof fixture>) => {
        v.midi.clip.sceneIndex = 0;
      },
      (v: ReturnType<typeof fixture>) => {
        v.source.sourceKind = "warped-audio";
      },
      (v: ReturnType<typeof fixture>) => {
        v.instrumentChain.devices.pop();
      },
      (v: ReturnType<typeof fixture>) => {
        v.instrumentChain.devices[0]!.parameters = [];
      },
      (v: ReturnType<typeof fixture>) => {
        v.instrumentChain.after.devices[0]!.enabled = false;
      },
      (v: ReturnType<typeof fixture>) => {
        v.instrumentChain.devices[0]!.device.canHaveChains = true;
      },
    ]) {
      const value = fixture();
      mutate(value);
      expect(() => midiContentIdentity(value, placement)).toThrow();
    }
  });
  it("rejects independently declared hash, source, listener and type mismatches", () => {
    for (const patch of [
      {
        midi: {
          notesSha256: "0".repeat(64),
          instrumentChainSha256: "0".repeat(64),
        },
      },
      { trackName: "Other" },
      { clipName: "Other" },
      { trackIndex: 1 },
      { sceneIndex: 0 },
      { listenerBindingSlot: "different" },
    ]) {
      const { manifest, definition, evidence } = admitted();
      expect(() =>
        validateFixtureSourceEvidence(
          manifest,
          { ...definition, ...patch },
          evidence,
        ),
      ).toThrow();
    }
    const { manifest, definition, evidence } = admitted();
    expect(() =>
      validateFixtureSourceEvidence(
        manifest,
        {
          id: definition.id,
          trackName: "MIDI",
          clipName: "Quarter notes",
          sceneIndex: 1,
          mediaTarget: "media/resource-001.wav",
        },
        evidence,
      ),
    ).toThrow();
    expect(() =>
      validateBaseline({
        schemaVersion: 1,
        facts: {},
        dependencyHashes: {},
        sources: { source: { ...evidence, loadedMediaPath: "/fake.wav" } },
      }),
    ).toThrow();
    expect(() =>
      validateFixture({
        ...manifest,
        sources: [{ ...definition, mediaTarget: "media/resource-001.wav" }],
      }),
    ).toThrow();
  });
});
