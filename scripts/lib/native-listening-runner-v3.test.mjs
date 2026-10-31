import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as application from "@ableton-agent/application";
import * as runtime from "@ableton-agent/runtime";
import * as observability from "@ableton-agent/observability";
import * as storage from "@ableton-agent/storage";
import * as shared from "@ableton-agent/shared";
import * as protocol from "@ableton-agent/protocol";
import { JsonSessionStore } from "../../apps/desktop/src/main/desktop-service.ts";
import { createDesktopSessionContextManager } from "../../apps/desktop/src/main/desktop-session-context.ts";
import { sessionSchema } from "../../apps/desktop/src/contracts.ts";
import { publishSignalSecrets } from "../../apps/desktop/src/main/signal-credentials.ts";
import { nativeFixtureInput } from "./native-listening-fixture.test.mjs";
import { sessionEvidence } from "./native-listening-verification.test.mjs";
import {
  createNativeListeningRunner,
  inspectNativeCandidateAdmission,
} from "./native-listening-runner.mjs";

// Synthetic actor/capture/source receipts; production publication, storage and reopen.
async function fixture({
  kind = "midi",
  rate = 44100,
  failure,
  followUnknown = false,
  operatorParameters = 0,
  scenarioId,
  nativeVersion = 3,
  candidateViewTransform = (candidate) => candidate,
} = {}) {
  const id =
    scenarioId ??
    (nativeVersion === 4
      ? `native-dual-session-${kind === "midi" ? "midi" : "warped-audio"}`
      : `native-session-${kind === "midi" ? "midi" : "warped-audio"}`);
  const manifest = JSON.parse(
    await readFile(`integration/live-scenarios/${id}.json`, "utf8"),
  );
  const repeated = manifest.sequence !== undefined;
  const loopEnd = manifest.sourceRegion.loopEnd;
  const durationBeats = manifest.capture.durationBeats ?? null;
  const resolvedDurationBeats = durationBeats ?? loopEnd;
  const f = await nativeFixtureInput({ nativeVersion });
  let e = sessionEvidence({
    rate,
    kind,
    followUnknown,
    ...(repeated ? { startBeat: 0 } : {}),
    durationBeats,
    loopEnd,
  });
  if (nativeVersion === 4) {
    e.listener.registration.version = 4;
    e.received[0].result.listenerVersion = 4;
    e.received[0].result.mode = "session";
  }
  if (repeated && failure !== "repeat-silent") {
    // Synthetic consistency fixture only: no DSP execution or acoustic claim.
    const level = 20 * Math.log10(0.125);
    const raw = e.received[0].result.observation;
    for (const observation of [raw, e.entries[0].payload]) {
      const peak = failure === "repeat-clipped" ? 1 : 0.25;
      observation.summaries = {
        peak: [peak, peak],
        rmsDbfs: [level, level],
        centroidHz: 440,
      };
      observation.samples.forEach((point) => {
        point.peak = [peak, peak];
        point.rmsDbfs = [level, level];
        point.centroidHz = 440;
      });
      const first = observation.samples[0];
      observation.attacks = [
        { sample: first.sample, beat: first.beat, strength: level + 120 },
      ];
      observation.reduction.originalAttacks = 1;
    }
    const proof = e.received[0].result.nativeCapture.transport;
    proof.envelopeWindows.forEach((row) => {
      row[1] = 0.125;
      row[2] = 0.125;
    });
    proof.spectralWindows.forEach((row) => {
      row[2] = 440;
      row[3] = 1;
    });
  }
  const selectedIndex = kind === "midi" ? 0 : 1;
  e.session.target.track.index = selectedIndex;
  e.session.target.track.expectedName =
    kind === "midi" ? "Fixture MIDI" : "Fixture Audio";
  e.entries[0].payload.source.target = globalThis.structuredClone(
    e.session.target,
  );
  f.input.sessionSources = Object.fromEntries(
    ["midi", "warped-audio"].map((sourceKind, index) => [
      sourceKind,
      {
        canonicalPath: `live_set tracks ${index} devices ${operatorParameters && index === 0 ? 1 : 0}`,
        trackName: index === 0 ? "Fixture MIDI" : "Fixture Audio",
        deviceName: "Candidate",
        sceneIndex: 0,
      },
    ]),
  );
  e.target.binding.expectedDeviceName = "Candidate";
  if (operatorParameters && selectedIndex === 0)
    e.target.binding.deviceIndex = 1;
  const inputPath = join(f.root, "session-input.json");
  await writeFile(inputPath, JSON.stringify(f.input));
  const runId = randomUUID();
  const log = [],
    events = new Set(),
    results = new Set();
  let playing = false,
    host,
    job,
    actorContext,
    hostOptions,
    runtimeOptions,
    publications = 0;
  const trackRefs = [randomUUID(), randomUUID()];
  trackRefs[selectedIndex] = e.session.target.track.expectedReference;
  const clipRefs = [randomUUID(), randomUUID()];
  clipRefs[selectedIndex] = e.session.target.expectedClipReference;
  const secondClipReference = randomUUID();
  const firstClipName = e.session.target.expectedClipName;
  let subpass = 0;
  let repeatBeat = 0;
  let clipStopped = false;
  let diagnosticActive = false;
  let openedJournal;
  let journalFlushes = 0;
  const diagnosticReads = [];
  const deviceRefs = [randomUUID(), randomUUID()];
  deviceRefs[selectedIndex] = e.target.binding.expectedDeviceReference;
  const parameterRefs = [randomUUID(), randomUUID()];
  const operatorReference = randomUUID();
  const operatorParameterRefs = Array.from({ length: operatorParameters }, () =>
    randomUUID(),
  );
  const inspectionQueries = [];
  const parameterReadCounts = [];
  const listeners = trackRefs.map((trackId, index) => ({
    connectionId: `connection-${index}`,
    producer: {
      producerId:
        index === selectedIndex ? e.listener.producer.producerId : "unselected",
      instanceId: `instance-${index}`,
      signalKind: "audio",
      schemaVersion: "audio-observation/v2",
    },
    binding: { trackId, deviceId: deviceRefs[index] },
    registration: {
      version:
        failure === "version" && index === selectedIndex ? 2 : nativeVersion,
      connectionEpoch: "epoch",
      sampleRate: rate,
      vectorSize: 128,
      deviceCanonicalPath: `live_set tracks ${index} devices ${operatorParameters && index === 0 ? 1 : 0}`,
      trackCanonicalPath: `live_set tracks ${index}`,
      nativeStatus: {
        version: nativeVersion,
        scope:
          nativeVersion === 4
            ? protocol.LISTENER_DUAL_SCOPE
            : protocol.NATIVE_SESSION_LISTENER_SCOPE,
        ...(nativeVersion === 4
          ? { abiVersion: 2, supportedModes: ["arrangement", "session"] }
          : {
              sourceEvidence: "expected-context-only",
              synchronization: "transport-coupled-first-iteration",
              maxDurationBeats: 4,
            }),
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
      },
    },
    phase: "idle",
  }));
  const listener = listeners[selectedIndex];
  const snapshot = () => ({
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    isPlaying: playing,
    trackCount: 2,
    tracks: trackRefs.map((reference, index) => ({
      reference,
      index,
      name: index === 0 ? "Fixture MIDI" : "Fixture Audio",
      kind: index === 0 ? "midi" : "audio",
      color: null,
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      volume: 0.85,
      pan: 0,
      devicesTruncated: failure === "truncated-devices",
      devices: [
        ...(operatorParameters && index === 0
          ? [
              {
                index: 0,
                reference: operatorReference,
                name: "Operator",
                className: "Operator",
                classDisplayName: "Operator",
                enabled: true,
                parameterCount: operatorParameters,
              },
            ]
          : []),
        {
          index: operatorParameters && index === 0 ? 1 : 0,
          reference: deviceRefs[index],
          name: "Candidate",
          className: "MxDeviceAudioEffect",
          classDisplayName: "Max Audio Effect",
          enabled: true,
          parameterCount: 1,
        },
      ],
    })),
    clips: [
      ...clipRefs.map((reference, index) => ({
        reference,
        trackReference: trackRefs[index],
        trackIndex: index,
        sceneIndex: 0,
        name: index === selectedIndex ? firstClipName : `Unselected ${index}`,
        kind: index === 0 ? "midi" : "audio",
        length: loopEnd,
        noteCount: index === 0 ? 1 : null,
        isPlaying:
          playing &&
          ((index === selectedIndex && (!repeated || subpass !== 1)) ||
            failure === "unselected-launch"),
        isTriggered: false,
        muted: false,
        looping: true,
      })),
      ...(repeated
        ? [
            {
              reference: secondClipReference,
              trackReference: trackRefs[0],
              trackIndex: 0,
              sceneIndex: 1,
              name: "Fixture MIDI second",
              kind: "midi",
              length: loopEnd,
              noteCount: 1,
              isPlaying: playing && subpass === 1,
              isTriggered: false,
              muted: false,
              looping: true,
            },
          ]
        : []),
    ],
  });
  const target = {
    binding: e.target.binding,
    enabled: true,
    sessionOverride: false,
    clipsTruncated: failure === "preflight-clips",
    dependenciesTruncated: Boolean(operatorParameters && selectedIndex === 0),
    fingerprint: {
      completeness: "unknown",
      unknownReasons: ["upstream-parameters-truncated"],
    },
    attribution: "nonexclusive",
    unknownReasons:
      operatorParameters && selectedIndex === 0
        ? ["upstream-parameters-truncated"]
        : [],
    canonicalPath: listener.registration.deviceCanonicalPath,
    pathAttestation: {
      canonicalDevicePath: listener.registration.deviceCanonicalPath,
    },
    clips: [],
    upstreamDevices:
      operatorParameters && selectedIndex === 0
        ? [
            {
              reference: operatorReference,
              name: "Operator",
              className: "Operator",
              enabled: true,
              parameters: operatorParameterRefs
                .slice(0, 16)
                .map((reference, index) => ({
                  reference,
                  name: `Operator parameter ${index}`,
                  value: 1,
                })),
            },
          ]
        : [],
  };
  const setPlaying = vi.fn(async (value) => {
    expect(repeated).toBe(true);
    expect(value).toBe(false);
    log.push("harness-stop");
    mutations.push("harness-stop");
    playing = false;
    repeatBeat = 20.330666666666666;
    if (failure === "repeat-stop-throws")
      throw new Error("Synthetic partially applied harness stop");
    subpass++;
    const oldPass = e.pass.id;
    const oldClip = e.session.target.expectedClipReference;
    const oldName = e.session.target.expectedClipName;
    const newClip = subpass === 1 ? secondClipReference : clipRefs[0];
    const newName = subpass === 1 ? "Fixture MIDI second" : firstClipName;
    const newPass = failure === "repeat-reused-pass" ? oldPass : randomUUID();
    e = globalThis.structuredClone(e);
    const change = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, v] of Object.entries(value)) {
        if (v === oldPass) value[key] = newPass;
        else if (v === oldClip) value[key] = newClip;
        else if (v === oldName) value[key] = newName;
        else if (
          key === "nativeEpoch" &&
          failure !== "repeat-reused-native-epoch"
        )
          value[key] = v + 1;
        else if (key === "sceneIndex") value[key] = subpass === 1 ? 1 : 0;
        else if (["playingSlotIndex", "firedSlotIndex"].includes(key) && v >= 0)
          value[key] = subpass === 1 ? 1 : 0;
        else change(v);
      }
    };
    change(e);
    if (failure === "repeat-reconnect" && subpass === 1)
      listener.connectionId = "reconnected";
  });
  if (failure === "preflight-secret")
    target.binding.expectedDeviceName = "token=runner-private-value";
  const state = (running) => ({
    ...e.session.source.after,
    ...(repeated && !running ? { globalBeat: repeatBeat } : {}),
    ...(running
      ? { ...e.session.after.after, globalBeat: 12.25, playingPosition: 4.25 }
      : {}),
    ...(clipStopped
      ? {
          transportPlaying: playing,
          globalBeat: 12.25,
          targetPlaying: false,
          targetTriggered: false,
          targetRecording: false,
          playingSlotIndex: -2,
          firedSlotIndex: -1,
          selectedClipReference: null,
        }
      : {}),
  });
  const source = (params) => {
    const selected =
      params.target.expectedClipReference ===
      e.session.target.expectedClipReference;
    return {
      ...e.session.source,
      queryId: params.queryId,
      target: params.target,
      sourceKind: params.target.track.index === 0 ? "midi" : "warped-audio",
      before: state(playing && selected),
      after: state(playing && selected),
      settings: {
        ...e.session.source.settings,
        ...(failure === "loop-end" ? { endMarker: 3.999 } : {}),
        ...(failure === "follow-enabled" ? { followActionEnabled: true } : {}),
      },
    };
  };
  const mutations = [];
  const ableton = {
    setPlaying,
    getLiveIdentity: vi.fn(async () => ({
      liveSetId:
        failure === "repeat-foreign-set" && publications > 0
          ? "foreign-set"
          : "set",
      liveSetName: "Fixture",
      saved: true,
    })),
    executeTracksOperation: vi.fn(async (params) => {
      protocol.tracksOperationParamsSchema.parse(params);
      if (params.action === "get") {
        diagnosticActive = true;
        diagnosticReads.push("track");
        if (failure === "repeat-stop-delayed-diag-unavailable")
          throw new Error(
            "Track diagnostic unavailable token=private-diagnostic",
          );
        return protocol.tracksOperationResultSchema.parse({
          action: "get",
          track: {
            kind: "regular",
            index: 0,
            reference: trackRefs[0],
            name: "Fixture MIDI",
            trackType: "midi",
            colorIndex: null,
            isGroup: false,
            isFolded: null,
            monitoringState: null,
            canBeArmed: true,
            isArmed: false,
            isMuted: false,
            isSoloed: false,
            backToArrangement: true,
          },
        });
      }
      expect(params).toEqual({
        action: "stop-clips",
        target: e.session.target.track,
        quantized: false,
      });
      mutations.push("harness-stop-clips");
      if (failure?.startsWith("repeat-stop-delayed")) {
        expect(journalFlushes).toBeGreaterThan(0);
        const stored = await openedJournal.read({
          names: [
            "integration.native_listening.repeat-1-harness-stop-clips-request.progress",
          ],
        });
        expect(stored.items[0].attributes.request.params).toEqual(params);
        clipStopped = true;
        throw Object.assign(
          new Error("Track clips did not stop as requested"),
          { code: "conflict" },
        );
      }
      if (failure === "repeat-clip-stop-denied")
        throw new Error("Fixture clip stop denied");
      return {
        action: "stop-clips",
        result: { verified: failure !== "repeat-clip-stop-unconfirmed" },
      };
    }),
    executeTransportOperation: vi.fn(async (params) => {
      protocol.transportOperationParamsSchema.parse(params);
      if (params.action === "get") {
        diagnosticReads.push("transport");
        return protocol.transportOperationResultSchema.parse({
          action: "get",
          offset: 0,
          limit: 1,
          cuePoints: [],
          totalCuePoints: 0,
          transport: {
            currentSongTime: 12.25,
            isPlaying: playing,
            tempo: 120,
            timeSignature: { numerator: 4, denominator: 4 },
            metronome: false,
            launchQuantization: 0,
            recordQuantization: 0,
            linkEnabled: false,
            backToArrangement: true,
          },
        });
      }
      expect(params).toEqual({ action: "seek", time: 0 });
      expect(playing).toBe(false);
      mutations.push("harness-position-zero");
      const before = {
        currentSongTime: repeatBeat,
        isPlaying: false,
        tempo: 120,
        timeSignature: { numerator: 4, denominator: 4 },
        metronome: false,
        launchQuantization: 0,
        recordQuantization: 0,
        linkEnabled: false,
        backToArrangement: true,
      };
      if (failure === "repeat-position-denied")
        throw new Error("Fixture position denied before applying");
      if (failure !== "repeat-position-unapplied") repeatBeat = 0;
      if (failure === "repeat-position-throws")
        throw new Error("Partially applied fixture position");
      return protocol.transportOperationResultSchema.parse({
        action: "seek",
        verified: true,
        before,
        after: {
          ...before,
          currentSongTime: repeatBeat,
          metronome: failure === "repeat-position-settings",
        },
      });
    }),
    inspectListeningContext: async (params) => {
      if (diagnosticActive) diagnosticReads.push("recording");
      inspectionQueries.push(globalThis.structuredClone(params));
      const inspectedTarget = globalThis.structuredClone(target);
      if (failure?.startsWith("repeat-inventory-active-first")) {
        inspectedTarget.clips = [
          [0, clipRefs[selectedIndex], firstClipName],
          [1, secondClipReference, "Fixture MIDI second"],
        ].map(([sceneIndex, reference, name]) => ({
          target: {
            view: "session",
            track: e.target.binding.track,
            sceneIndex,
            expectedClipReference: reference,
            expectedClipName: name,
          },
          interval: null,
          settings: { looping: true },
        }));
        if (playing && subpass === 1) {
          inspectedTarget.clips.reverse();
          if (failure === "repeat-inventory-active-first-mutation")
            inspectedTarget.clips[0].settings.looping = false;
        }
      }
      return {
        bindingQueryId: params.bindingQueryId,
        listeners: [inspectedTarget],
        transport: {
          playing,
          currentBeat: playing
            ? 12.25
            : failure === "repeat-initial-nonzero"
              ? 8
              : repeated
                ? repeatBeat
                : 8,
          tempo: 120,
          safeToStart:
            !playing &&
            !["preflight-recording", "preflight-clips"].includes(failure),
          recording: {
            recordMode:
              failure === "preflight-recording" ||
              (failure === "repeat-recording-before-reset" &&
                publications > 0) ||
              (failure === "repeat-stop-recording" && subpass === 1),
            sessionRecord: false,
            arrangementOverdub: false,
            sessionAutomationRecord: false,
          },
        },
      };
    },
    inspectSessionListeningSource: vi.fn(async (params) => {
      if (diagnosticActive)
        diagnosticReads.push(`source-${params.target.sceneIndex}`);
      const read = source(params);
      if (failure === "repeat-foreign-source" && publications > 0)
        read.target = { ...read.target, expectedClipReference: randomUUID() };
      if (
        failure === "repeat-source-recording-before-reset" &&
        publications > 0
      ) {
        read.before = { ...read.before, targetRecording: true };
        read.after = { ...read.after, targetRecording: true };
      }
      if (failure === "repeat-reset-queued" && subpass === 1) {
        read.before = {
          ...read.before,
          targetTriggered: true,
          firedSlotIndex: 1,
        };
        read.after = {
          ...read.after,
          targetTriggered: true,
          firedSlotIndex: 1,
        };
      }
      if (failure === "repeat-reset-settings" && subpass === 1)
        read.settings = { ...read.settings, launchQuantization: 4 };
      return read;
    }),
    inspectDeviceParameters: async (params) => {
      const track = snapshot().tracks[params.index],
        device = track.devices.find(
          (device) => device.index === params.deviceIndex,
        );
      parameterReadCounts.push(device.parameterCount);
      return {
        device: {
          ...device,
          trackReference: track.reference,
          trackIndex: track.index,
        },
        total: device.parameterCount,
        offset: 0,
        limit: 256,
        parameters: Array.from(
          { length: device.parameterCount },
          (_, index) => ({
            reference:
              device.reference === operatorReference
                ? operatorParameterRefs[index]
                : parameterRefs[track.index],
            deviceReference: device.reference,
            index,
            name:
              device.reference === operatorReference
                ? `Operator parameter ${index}`
                : "Device On",
            value:
              playing &&
              ((failure === "parameter-edit" &&
                track.index !== selectedIndex) ||
                (failure === "operator-hidden-parameter-edit" &&
                  device.reference === operatorReference &&
                  index === 194))
                ? 0
                : 1,
            normalizedValue: 1,
            min: 0,
            max: 1,
            isQuantized: true,
            isEnabled: true,
            valueItemCount: 2,
          }),
        ),
      };
    },
    inspectMidiNotes: async (params) => ({
      clip: snapshot().clips.find(
        (clip) => clip.reference === params.expectedClipReference,
      ),
      totalNotes: 1,
      offset: 0,
      limit: 2048,
      truncated: failure === "truncated-midi",
      notes: [
        {
          pitch:
            params.sceneIndex === 1 && failure !== "repeat-identical-clips"
              ? 67
              : playing && failure === "midi-edit"
                ? 61
                : 60,
          startTime: 0,
          duration: 1,
          velocity: 100,
          mute: false,
        },
      ],
    }),
    executeAudioClipsOperation: async (params) =>
      params.action === "warp-markers"
        ? {
            action: "warp-markers",
            total: failure === "truncated-warp" ? 3 : 2,
            offset: 0,
            limit: 256,
            markers: [
              { index: 0, beatTime: 0, sampleTime: 0 },
              {
                index: 1,
                beatTime: loopEnd,
                sampleTime:
                  playing && failure === "warp-edit" ? 3 : loopEnd / 2,
              },
            ],
          }
        : {
            action: "inspect",
            clip: {
              reference: params.target.expectedClipReference,
              name: params.target.expectedClipName,
              length: loopEnd,
              gain: playing && failure === "audio-edit" ? 0.5 : 1,
              pitchCoarse: 0,
              pitchFine: 0,
              warping: true,
              warpMode: 0,
              availableWarpModes: [0],
              startMarker: 0,
              endMarker: loopEnd,
              loopStart: 0,
              loopEnd,
              looping: true,
              ramMode: false,
              filePath: "/synthetic-only/tone.wav",
              sampleLength: (rate * loopEnd) / 2,
              sampleRate: rate,
            },
          },
    sessionListeningPass: vi.fn(async (params) => {
      log.push(`source:${params.action}`);
      // Read-only inspection accepts nonzero anchors; launch preparation must
      // not occur there. This models qualification, not a restriction on reads.
      if (
        params.action === "prepare" &&
        failure === "repeat-requires-zero" &&
        subpass > 0 &&
        repeatBeat !== 0
      )
        throw new Error(
          "session_launch_case_unqualified: stopped beat zero required",
        );
      if (params.action === "prepare" && failure === "prepare-failure")
        throw new Error("Session prepare denied token=unit-private-value");
      if (params.action === "prepare" && failure === "prepare-cancelled")
        throw new globalThis.DOMException(
          "Session prepare cancelled",
          "AbortError",
        );
      if (params.action === "launch") {
        playing = true;
        mutations.push("launch");
      }
      const original = e.session.receipts.find(
        (receipt) => receipt.params.action === params.action,
      ).result;
      return {
        ...globalThis.structuredClone(original),
        passId: job.passId,
        ownerId: params.ownerId,
        ...(params.action === "release" && params.reason === "cancelled"
          ? { status: "cancelled" }
          : {}),
        ...(failure === "source-epoch" && params.action === "inspect"
          ? { sourceEpoch: { ...original.sourceEpoch, startTimeBeats: 7 } }
          : {}),
      };
    }),
  };
  const originalSourcePass = ableton.sessionListeningPass;
  const p = {
    ...protocol,
    snapshotNativeSessionListeningExpectation: vi.fn((input) => {
      log.push("freeze");
      return protocol.snapshotNativeSessionListeningExpectation(input);
    }),
  };
  const appStop = vi.fn(),
    signalStop = vi.fn();
  const services = {
    ...application,
    ...runtime,
    ...observability,
    LocalObservabilityJournal: {
      open: async (options) => {
        openedJournal =
          await observability.LocalObservabilityJournal.open(options);
        const flush = openedJournal.flush.bind(openedJournal);
        openedJournal.flush = async () => {
          journalFlushes++;
          return flush();
        };
        return openedJournal;
      },
    },
    ...storage,
    ...shared,
    JsonSessionStore,
    createDesktopSessionContextManager: (options) => {
      const manager = createDesktopSessionContextManager(options);
      if (failure === "repeat-prior-context-rewrite") {
        const resolve = manager.resolveRepository.bind(manager);
        manager.resolveRepository = async (context) => {
          const repository = await resolve(context);
          return new Proxy(repository, {
            get(target, key) {
              if (key === "getEntry")
                return async (id) => {
                  const entry = await target.getEntry(id);
                  return publications >= 2 && entry?.passId !== job?.passId
                    ? { ...entry, tampered: true }
                    : entry;
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      }
      return manager;
    },
    sessionSchema,
    publishSignalSecrets,
    protocol: p,
    createListeningRuntimeHost: (_dependencies, options) => {
      hostOptions = options;
      return {
        executeListeningOperation: async (params, context) => {
          if (params.action === "inspect-listeners")
            return {
              action: params.action,
              listeners: [
                candidateViewTransform({
                  listenerId: listener.producer.producerId,
                  ready: false,
                  limitations: ["native_per_pass_validation_required"],
                  trackReference: trackRefs[selectedIndex],
                  deviceReference: deviceRefs[selectedIndex],
                }),
              ].filter((candidate) => candidate !== undefined),
            };
          if (params.action === "play-session-and-listen") {
            actorContext = context;
            job = {
              passId: e.pass.id,
              owner: await options.resolveOwner(context),
              stage: "queued",
              contextIds: [],
              cleanupPolicy: "leave-running",
            };
            options.onChange(job);
            log.push("queued");
            const prepare = {
              ...e.session.receipts[0].params,
              expectedLiveSetId: job.owner.liveSetId,
              listener: target.binding,
              target: params.target,
            };
            await ableton.sessionListeningPass(prepare);
            await ableton.sessionListeningPass(e.session.receipts[1].params);
            job = { ...job, stage: "arming" };
            options.onChange(job);
          }
          return { action: params.action, job };
        },
        waitForListeningPass: async () => {
          const cancelled = failure === "cancelled";
          if (
            cancelled ||
            failure === "capture" ||
            (failure === "repeat-second-capture" && subpass === 1)
          ) {
            await ableton.sessionListeningPass({
              ...e.session.receipts[3].params,
              reason: "cancelled",
            });
            job = {
              ...job,
              stage: cancelled ? "cancelled" : "failed",
              error: "synthetic capture termination",
            };
            hostOptions.onChange(job);
            return job;
          }
          if (failure === "repeat-second-partial-proof" && subpass === 1)
            e.received[0].result.nativeCapture.transport.spectralWindows.pop();
          for (const result of results)
            result({
              ...e.received[0],
              connectionId: listener.connectionId,
              producer: listener.producer,
              binding: listener.binding,
              result: { ...e.received[0].result, ...actorContext.trace },
            });
          log.push("native-completed");
          await ableton.sessionListeningPass(e.session.receipts[2].params);
          job = { ...job, stage: "persisting" };
          hostOptions.onChange(job);
          log.push("persisting");
          const repository = await options.resolveRepository(
            job.owner,
            actorContext,
          );
          const at = new Date().toISOString();
          const canonicalTrackId = repeated
            ? `canonical-track-${job.passId}`
            : "canonical-track-subject";
          const associatedTrackId =
            failure === "inconsistent-track-subject-id"
              ? trackRefs[selectedIndex]
              : canonicalTrackId;
          const subject = (primary) => ({
            id: primary
              ? repeated
                ? `session-clip-${job.passId}`
                : "session-clip-subject"
              : canonicalTrackId,
            sessionId: job.owner.sessionId,
            liveSetId: job.owner.liveSetId,
            kind: primary ? "clip" : "track",
            location: primary ? "session" : "track",
            trackId: associatedTrackId,
            binding: {
              version: 1,
              semanticLocator: {
                name: primary
                  ? e.session.target.expectedClipName
                  : e.session.target.track.expectedName,
                trackId: associatedTrackId,
                ...(primary ? { sceneIndex: e.session.target.sceneIndex } : {}),
              },
              sourceIdentity: "synthetic-message-rate-only",
              playbackSettingsHash: "a".repeat(64),
              upstreamProcessingHash: "b".repeat(64),
              routingHash: "c".repeat(64),
              dependencyScope: "unknown",
              previousRuntimeBindings: [
                primary
                  ? e.session.target.expectedClipReference
                  : trackRefs[selectedIndex],
              ],
            },
          });
          const publication = application.buildListeningPublication({
            passId: job.passId,
            owner: job.owner,
            trace: actorContext.trace,
            requestedMode: "session",
            actualMode: "session",
            requestedRange: { startBeat: 0, endBeat: resolvedDurationBeats },
            createdAt: at,
            startedAt: at,
            endedAt: at,
            observations: [e.entries[0].payload],
            bindings: [
              {
                listenerId: listener.producer.producerId,
                deviceReference: deviceRefs[selectedIndex],
                connectionEpoch: "epoch",
                version: "2.0.0",
                primary: subject(true),
                contributors: [subject(false)],
                attribution: "unknown",
              },
            ],
          });
          await repository.appendPass(publication, {
            trace: actorContext.trace,
            activeAgentId: job.owner.agentId,
          });
          publications++;
          await ableton.sessionListeningPass(e.session.receipts[3].params);
          job = {
            ...job,
            stage: "completed",
            contextIds: [publication.entries[0].id],
          };
          hostOptions.onChange(job);
          return job;
        },
        shutdown: async () => {},
      };
    },
    createAgentRuntime: (options) => {
      runtimeOptions = options;
      host = options.listening({ ableton });
      return {
        ableton,
        signals: {
          start: async () => {},
          stop: signalStop,
          listeners: {
            inspectListeners: () => globalThis.structuredClone(listeners),
            onListenerResult: (fn) => {
              results.add(fn);
              return () => results.delete(fn);
            },
          },
        },
        application: {
          start: async () => {},
          stop: appStop,
          getStatus: async () => ({
            state: "connected",
            liveSetId: "set",
            liveVersion: "11.3.43",
            saved: true,
            liveSetName: `${manifest.artifactPrefix}${runId}`,
          }),
          inspectSession: async () => snapshot(),
          subscribe: (fn) => {
            events.add(fn);
            return () => events.delete(fn);
          },
          createManagedAgent: async (configuration) => {
            expect(configuration.resolvedOperations).toContain(
              "listening.play_session_and_listen",
            );
            expect(configuration.resolvedOperations).not.toContain(
              "listening.play_arrangement_and_listen",
            );
            return "synthetic-sdk-session";
          },
          sendToManagedAgent: async (_agent, prompt) => {
            expect(prompt).toContain(JSON.stringify(e.session.target));
            const context = {
              sessionId: options.currentAppSessionId(),
              agentId: _agent,
              actorKind: "agent",
              trace: {
                traceId: randomUUID(),
                correlationId: "session-runner-unit",
                causationId: randomUUID(),
              },
            };
            const invoke = async (args, risk) => {
              for (const event of events) event({ type: "operation.started" });
              const approved = await options.requestToolApproval({
                metadata: { name: "ableton_listening", risk },
                arguments: args,
              });
              if (!approved)
                throw new Error("synthetic actor permission denied; no retry");
              return host.executeListeningOperation(args, context);
            };
            await invoke({ action: "inspect-listeners" }, "read");
            await invoke(
              {
                action: "play-session-and-listen",
                target: e.session.target,
                listenerIds: [listener.producer.producerId],
                ...(failure === "denial" ||
                (failure === "repeat-second-denial" && subpass === 1)
                  ? { durationBeats: 4.001 }
                  : durationBeats === null
                    ? {}
                    : { durationBeats }),
                maximumDurationMs: 30000,
              },
              "reversible",
            );
            await invoke({ action: "get-pass", passId: job.passId }, "read");
          },
        },
      };
    },
  };
  const runner = await createNativeListeningRunner({
    manifest,
    inputPath,
    directory: join(f.root, "session-run"),
    environment: { ABLETON_AGENT_TOKEN: "u".repeat(64) },
    runId,
    services,
    waitForBridge: async () => {},
  });
  return {
    ...f,
    runner,
    e,
    log,
    mutations,
    services,
    p,
    appStop,
    signalStop,
    originalSourcePass,
    runtimeOptions: () => runtimeOptions,
    publications: () => publications,
    inspectionQueries,
    parameterReadCounts,
    diagnosticReads,
    readJournal: (query) => openedJournal.read(query),
  };
}

describe("native Session runner composition (no Live launched, not physical qualification)", () => {
  it.each([
    ["readyFalse", (candidate) => ({ ...candidate, ready: true })],
    [
      "nativePerPassValidationRequired",
      (candidate) => ({ ...candidate, limitations: [] }),
    ],
    [
      "trackReferenceMatches",
      (candidate) => ({
        ...candidate,
        trackReference: "token=runner-private-admission",
      }),
    ],
    [
      "deviceReferenceMatches",
      (candidate) => ({ ...candidate, deviceReference: "foreign-device" }),
    ],
  ])(
    "attributes previously opaque candidate admission failure exactly to %s",
    async (predicate, candidateViewTransform) => {
      const f = await fixture({
        nativeVersion: 4,
        scenarioId: "native-dual-session-repeat-1-2-1",
        candidateViewTransform,
      });
      try {
        const result = await f.runner.run(async () => {});
        expect(result).toMatchObject({
          ok: false,
          approvals: [],
          jobs: [],
          candidateAdmission: {
            schema: "native-candidate-admission/v1",
            passed: false,
            failedChecks: [predicate],
            checks: { [predicate]: false, candidatePresent: true },
            expected: {
              listenerId: f.e.listener.producer.producerId,
              trackReference: f.e.session.target.track.expectedReference,
              deviceReference: f.e.target.binding.expectedDeviceReference,
            },
          },
        });
        expect(result.error).toBe(
          `Candidate readiness or independently resolved identity mismatch: ${predicate}`,
        );
        const events = result.lifecycle.filter((event) =>
          event.name.startsWith(
            "integration.native_listening.candidate-admission.",
          ),
        );
        expect(events.map((event) => event.stage)).toEqual([
          "queued",
          "started",
          "progress",
          "failed",
        ]);
        expect(events.at(-1).attributes.candidateAdmission).toEqual(
          result.candidateAdmission,
        );
        expect(JSON.stringify(result)).not.toContain(
          "runner-private-admission",
        );
        expect(f.mutations).toEqual([]);
        expect(f.publications()).toBe(0);
        expect(f.originalSourcePass).not.toHaveBeenCalled();
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it("retains explicit absence diagnostics instead of guessing a readiness or identity cause", async () => {
    const f = await fixture({
      nativeVersion: 4,
      candidateViewTransform: () => undefined,
    });
    try {
      const result = await f.runner.run(async () => {});
      expect(result).toMatchObject({
        ok: false,
        candidateAdmission: {
          passed: false,
          candidateView: null,
          checks: { candidatePresent: false },
          failedChecks: [
            "candidatePresent",
            "readyFalse",
            "nativePerPassValidationRequired",
            "trackReferenceMatches",
            "deviceReferenceMatches",
          ],
        },
        approvals: [],
        jobs: [],
      });
      expect(f.mutations).toEqual([]);
      expect(f.publications()).toBe(0);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
  it("bounds/redacts allowlisted diagnostics but compares untruncated raw references and limitations", () => {
    const prefix = "a".repeat(256);
    const input = {
      listenerId: "listener",
      trackReference: `${prefix}expected`,
      deviceReference: "device",
      candidateView: {
        listenerId: "listener",
        instanceId: "token=synthetic-private-instance",
        ready: false,
        trackReference: `${prefix}different`,
        deviceReference: "device",
        limitations: [
          ...Array(12).fill(`token=synthetic-private-limitation ${prefix}`),
          "native_per_pass_validation_required",
        ],
        authorization: "synthetic-private-field",
        payload: "never-copy-arbitrary-fields",
      },
    };
    const evidence = inspectNativeCandidateAdmission(
      input,
      observability.sanitizePersistedText,
    );
    expect(evidence.failedChecks).toEqual(["trackReferenceMatches"]);
    expect(evidence.checks.nativePerPassValidationRequired).toBe(true);
    // Same diagnostic prefix must never turn unequal raw references into a pass.
    expect(evidence.candidateView.trackReference).toBe(
      evidence.expected.trackReference,
    );
    expect(evidence.candidateView).toMatchObject({
      limitationsCount: 13,
      limitationsTruncated: true,
    });
    expect(evidence.candidateView.limitations).toHaveLength(8);
    for (const text of evidence.candidateView.limitations)
      expect(text.length).toBeLessThanOrEqual(128);
    expect(JSON.stringify(evidence)).not.toContain("synthetic-private");
    expect(evidence.candidateView).not.toHaveProperty("authorization");
    expect(evidence.candidateView).not.toHaveProperty("payload");
    expect(JSON.stringify(evidence).length).toBeLessThan(3000);
    input.candidateView.trackReference = input.trackReference;
    expect(
      inspectNativeCandidateAdmission(
        input,
        observability.sanitizePersistedText,
      ).passed,
    ).toBe(true);
  });
  it("restores the qualified stopped-zero Session baseline after a nonzero completed pass", async () => {
    const f = await fixture({
      scenarioId: "native-dual-session-repeat-1-2-1",
      nativeVersion: 4,
      failure: "repeat-requires-zero",
    });
    try {
      const result = await f.runner.run(async () => {});
      expect(result.ok, result.error).toBe(true);
      expect(result.repeated.passes).toHaveLength(3);
      expect(
        f.mutations.filter((m) => m === "harness-position-zero"),
      ).toHaveLength(2);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
  it.each(["repeat-stop-delayed", "repeat-stop-delayed-diag-unavailable"])(
    "persists request before dispatch and retains one read-only failure round at %s without accepting an applied stop",
    async (failure) => {
      const f = await fixture({
        scenarioId: "native-dual-session-repeat-1-2-1",
        nativeVersion: 4,
        failure,
      });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok).toBe(false);
        expect(result.error).toBe("Track clips did not stop as requested");
        expect(result.jobs).toHaveLength(1);
        expect(result.repeatedProgress.value).toHaveLength(1);
        const baseline = result.harnessStoppedBaselines.value[0];
        expect(baseline.verified).toBe(false);
        expect(baseline.requests).toHaveLength(1);
        expect(baseline.requests[0]).toMatchObject({
          persistedBeforeDispatch: true,
          status: "failed",
          request: {
            command: "tracks.mutate",
            params: {
              action: "stop-clips",
              target: f.e.session.target.track,
              quantized: false,
            },
          },
          error: {
            code: "conflict",
            message: "Track clips did not stop as requested",
          },
        });
        const diagnostic = baseline.failureDiagnostics;
        expect(diagnostic.ownedIdentityVerified).toBe(true);
        expect(diagnostic.reads).toHaveLength(5);
        expect(f.diagnosticReads).toEqual([
          "track",
          "source-0",
          "source-1",
          "transport",
          "recording",
        ]);
        expect(diagnostic.status).toBe(
          failure.endsWith("unavailable") ? "failed" : "completed",
        );
        const persisted = await f.readJournal({
          names: [
            "integration.native_listening.repeat-1-failure-read-source-0.completed",
          ],
        });
        expect(persisted.items).toHaveLength(1);
        expect(persisted.items[0].attributes.result.after).toMatchObject({
          transportPlaying: true,
          targetPlaying: false,
          playingSlotIndex: -2,
          firedSlotIndex: -1,
        });
        for (const read of diagnostic.reads.filter((read) =>
          read.name.startsWith("source-"),
        ))
          expect(read.result.after).toMatchObject({
            transportPlaying: true,
            targetPlaying: false,
            targetTriggered: false,
            targetRecording: false,
            playingSlotIndex: -2,
            firedSlotIndex: -1,
          });
        if (failure.endsWith("unavailable"))
          expect(diagnostic.reads[0]).toMatchObject({
            status: "failed",
            error: { name: "Error" },
          });
        expect(JSON.stringify(result)).not.toContain("private-diagnostic");
        expect(f.mutations).toEqual(["launch", "harness-stop-clips"]);
        expect(f.publications()).toBe(1);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        const writes = [...f.mutations];
        await f.runner.close({ processStopped: true });
        expect(f.mutations).toEqual(writes);
      }
    },
  );
  it("denies lost exact-PID ownership before fixture resets and never positions during cleanup", async () => {
    const f = await fixture({
      scenarioId: "native-dual-session-repeat-1-2-1",
      nativeVersion: 4,
    });
    try {
      const result = await f.runner.run(async () => {
        if (f.publications() > 0)
          throw new Error("Exact owned PID no longer matches");
      });
      expect(result.ok).toBe(false);
      expect(f.mutations).toEqual(["launch"]);
      expect(f.appStop).toHaveBeenCalledOnce();
      expect(f.signalStop).toHaveBeenCalledOnce();
    } finally {
      const before = [...f.mutations];
      await f.runner.close({ processStopped: true });
      expect(f.mutations).toEqual(before);
    }
  });
  it("retains partially positioned fixture until owned process closure is confirmed, without repair", async () => {
    const f = await fixture({
      scenarioId: "native-dual-session-repeat-1-2-1",
      nativeVersion: 4,
      failure: "repeat-position-throws",
    });
    const result = await f.runner.run(async () => {});
    expect(result.ok).toBe(false);
    expect(result.repeatedProgress.value).toHaveLength(1);
    expect(result.harnessStoppedBaselines.value[0]).toMatchObject({
      positionDispatched: true,
      verified: false,
    });
    const before = [...f.mutations];
    await expect(f.runner.close({ processStopped: false })).rejects.toThrow(
      /retained staging/,
    );
    await access(f.runner.fixture.setPath);
    expect(f.mutations).toEqual(before);
    // Unit fixture only: no process was launched. Journal is now closed; clean
    // this exact staged fixture after simulated process closure, without a seek.
    await f.runner.fixture.cleanup();
    await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    expect(f.mutations).toEqual(before);
  });
  it.each([
    ["repeat-inventory-active-first", true],
    ["repeat-inventory-active-first-mutation", false],
  ])(
    "compares exact clip inventory by identity despite active-first ordering (%s)",
    async (failure, passed) => {
      const f = await fixture({
        scenarioId: "native-dual-session-repeat-1-2-1",
        nativeVersion: 4,
        failure,
      });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok, result.error).toBe(passed);
        if (passed) expect(result.repeated.passes).toHaveLength(3);
        else {
          expect(result.postconditions.failedChecks).toEqual([
            "bindingUnchanged",
          ]);
          expect(
            result.postconditions.differences.some((difference) =>
              difference.path.endsWith(".settings.looping"),
            ),
          ).toBe(true);
        }
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );

  it.each([44100, 48000])(
    "qualifies same-loaded native4 clip1 → clip2 → clip1 at %sHz with three immutable contexts",
    async (rate) => {
      const f = await fixture({
        scenarioId: "native-dual-session-repeat-1-2-1",
        nativeVersion: 4,
        rate,
      });
      const runtimeFactory = vi.spyOn(f.services, "createAgentRuntime");
      try {
        const result = await f.runner.run(async () => {});
        expect(result, result.error).toMatchObject({
          ok: true,
          candidateAdmission: { passed: true, failedChecks: [] },
          repeated: {
            sameLoadedInstance: true,
            priorContextsPreserved: true,
            harnessStoppedBaselines: 2,
          },
        });
        expect(result.repeated.passes.map((p) => p.target.sceneIndex)).toEqual([
          0, 1, 0,
        ]);
        expect(new Set(result.repeated.passes.map((p) => p.passId)).size).toBe(
          3,
        );
        expect(
          new Set(result.repeated.passes.map((p) => p.contextId)).size,
        ).toBe(3);
        const epochs = result.repeated.passes.map((p) => p.nativeEpoch);
        expect(epochs[1]).toBeGreaterThan(epochs[0]);
        expect(epochs[2]).toBeGreaterThan(epochs[1]);
        expect(result.jobs).toHaveLength(3);
        expect(f.publications()).toBe(3);
        const resets = result.harnessStoppedBaselines.value;
        expect(resets).toHaveLength(2);
        for (const reset of resets) {
          expect(reset).toMatchObject({
            reviewRevision: "fixture-beat-zero-reset-v1",
            verified: true,
            settingsUnchanged: true,
            preflight: { transport: { playing: false, currentBeat: 0 } },
          });
          expect(reset.sourceStates).toHaveLength(2);
          for (const read of reset.sourceStates)
            for (const state of [read.before, read.after])
              expect(state).toMatchObject({
                globalBeat: 0,
                transportPlaying: false,
                targetPlaying: false,
                targetTriggered: false,
                targetRecording: false,
                firedSlotIndex: -1,
              });
        }
        expect(runtimeFactory).toHaveBeenCalledOnce();
        expect(f.mutations).toEqual([
          "launch",
          "harness-stop-clips",
          "harness-stop",
          "harness-position-zero",
          "launch",
          "harness-stop-clips",
          "harness-stop",
          "harness-position-zero",
          "launch",
        ]);
        expect(
          f.originalSourcePass.mock.calls.filter(
            ([p]) => p.action === "prepare",
          ),
        ).toHaveLength(3);
        expect(
          result.approvals.filter(
            (d) => d.arguments?.action === "play-session-and-listen",
          ),
        ).toHaveLength(3);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it.each([
    ["repeat-identical-clips", 0, 0],
    ["repeat-initial-nonzero", 0, 0],
    ["repeat-foreign-set", 0, 1],
    ["repeat-foreign-source", 0, 1],
    ["repeat-recording-before-reset", 0, 1],
    ["repeat-source-recording-before-reset", 0, 1],
    ["repeat-clip-stop-denied", 0, 1],
    ["repeat-clip-stop-unconfirmed", 0, 1],
    ["repeat-position-unapplied", 1, 1],
    ["repeat-position-throws", 1, 1],
    ["repeat-position-denied", 1, 1],
    ["repeat-position-settings", 1, 1],
    ["repeat-reset-queued", 1, 1],
    ["repeat-reset-settings", 1, 1],
    ["capture", 0, 1],
    ["cancelled", 0, 1],
    ["repeat-stop-throws", 1, 1],
    ["repeat-silent", 0, 1],
    ["repeat-clipped", 0, 1],
    ["repeat-stop-recording", 1, 1],
    ["repeat-reconnect", 1, 1],
    ["repeat-reused-pass", 1, 1],
    ["repeat-second-capture", 1, 2],
    ["repeat-second-denial", 1, 1],
    ["repeat-second-partial-proof", 1, 2],
    ["repeat-prior-context-rewrite", 1, 2],
    ["repeat-reused-native-epoch", 1, 2],
  ])(
    "fails closed at %s without capture retries or later unauthorized stops",
    async (failure, stops, launches) => {
      const f = await fixture({
        scenarioId: "native-dual-session-repeat-1-2-1",
        nativeVersion: 4,
        failure,
      });
      try {
        const result = await f.runner.run(async () => {});
        expect(result.ok, JSON.stringify(result)).toBe(false);
        expect(f.mutations.filter((m) => m === "harness-stop")).toHaveLength(
          stops,
        );
        expect(f.mutations.filter((m) => m === "launch")).toHaveLength(
          launches,
        );
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it.each([
    ["native-session-midi-full-loop", 44100],
    ["native-session-midi-full-loop", 48000],
    ["native-session-midi-eight-beats", 44100],
    ["native-session-midi-eight-beats", 48000],
  ])(
    "independently freezes and reopens full eight-beat %s at %sHz",
    async (scenarioId, rate) => {
      const f = await fixture({ scenarioId, rate });
      try {
        const result = await f.runner.run(async () => {});
        expect(result, result.error).toMatchObject({
          ok: true,
          evidence: {
            requestedRange: { startBeat: 0, endBeat: 8 },
            transportRange: { startBeat: 8, endBeat: 16 },
            envelopeWindows: 40,
            spectralWindows: 40,
          },
        });
        const decision = result.approvals.find(
          (entry) => entry.arguments?.action === "play-session-and-listen",
        );
        expect(Object.hasOwn(decision.arguments, "durationBeats")).toBe(
          scenarioId !== "native-session-midi-full-loop",
        );
        expect(f.originalSourcePass.mock.calls[0][0].durationBeats).toBe(8);
        expect(f.publications()).toBe(1);
        expect(f.mutations).toEqual(["launch"]);
      } finally {
        await f.runner.close({ processStopped: true });
      }
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    },
  );
  it.each(["midi", "warped-audio"])(
    "executes the reviewed wire4 %s Session scenario with exact mode proof and typed reopen without launching Live",
    async (kind) => {
      const f = await fixture({ nativeVersion: 4, kind });
      try {
        const result = await f.runner.run(async () => {});
        expect(result, result.error).toMatchObject({ ok: true });
        expect(f.publications()).toBe(1);
        const prepared = result.lifecycle.find(
          (event) =>
            event.name ===
            "integration.native_listening.session-source-prepare.completed",
        );
        expect(prepared.attributes.sourceReceipt).toMatchObject({
          params: { action: "prepare", passId: result.jobs[0].passId },
          result: { status: "prepared", mutationState: "not-attempted" },
          beforePublication: true,
        });
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it("admits a 195-parameter Operator with unknown nonexclusive dependencies without raising inspection budgets", async () => {
    const f = await fixture({ operatorParameters: 195 });
    try {
      const result = await f.runner.run(async () => {});
      expect(result, result.error).toMatchObject({ ok: true });
      expect(result.preflight).toMatchObject({
        passed: true,
        target: { dependenciesTruncated: true },
        quality: {
          dependencyCompleteness: "incomplete",
          fingerprintCompleteness: "unknown",
          attribution: "nonexclusive",
        },
      });
      expect(
        f.inspectionQueries.every((query) => query.maxParameters === 16),
      ).toBe(true);
      expect(
        f.parameterReadCounts.filter((count) => count === 195),
      ).toHaveLength(2);
      expect(f.mutations).toEqual(["launch"]);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
  it.each([
    ["preflight-recording", ["safeToStart", "recordModeOff"]],
    ["preflight-secret", ["deviceName"]],
    ["preflight-clips", ["safeToStart", "clipsComplete"]],
  ])(
    "retains bounded normal-result refusal evidence for %s without approval, jobs or launch",
    async (failure, guards) => {
      const f = await fixture({ failure, operatorParameters: 195 });
      try {
        const result = await f.runner.run(async () => {});
        expect(result).toMatchObject({
          ok: false,
          approvals: [],
          jobs: [],
          preflight: {
            passed: false,
            failedChecks: guards,
            limits: { maxParameters: 16, maxClips: 32 },
            quality: {
              dependencyCompleteness: "incomplete",
              fingerprintCompleteness: "unknown",
            },
          },
        });
        for (const guard of guards) expect(result.error).toContain(guard);
        expect(f.mutations).toEqual([]);
        expect(f.publications()).toBe(0);
        expect(JSON.stringify(result)).not.toContain("runner-private-value");
        const events = result.lifecycle.filter((event) =>
          event.name.startsWith(
            "integration.native_listening.stopped-preflight.",
          ),
        );
        expect(events.map((event) => event.stage)).toEqual([
          "queued",
          "started",
          "progress",
          "failed",
        ]);
        expect(
          events.every(
            (event) =>
              event.durationMs >= 0 &&
              event.trace.traceId === events[0].trace.traceId,
          ),
        ).toBe(true);
        expect(events.at(-1).attributes.preflight.failedChecks).toEqual(guards);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it("still rejects an Operator parameter edit outside the 16-field dependency fingerprint", async () => {
    const f = await fixture({
      operatorParameters: 195,
      failure: "operator-hidden-parameter-edit",
    });
    try {
      const result = await f.runner.run(async () => {});
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "Session capture changed fixture content",
        ),
        preflight: {
          passed: true,
          quality: { fingerprintCompleteness: "unknown" },
        },
      });
      expect(
        f.parameterReadCounts.filter((count) => count === 195),
      ).toHaveLength(2);
      expect(f.mutations).toEqual(["launch"]);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
  it.each([
    ["midi", 44100],
    ["warped-audio", 48000],
  ])(
    "freezes %s/%s before launch and verifies one atomic typed context after real store reopen",
    async (kind, rate) => {
      const f = await fixture({ kind, rate, followUnknown: true });
      try {
        const result = await f.runner.run(async () => {});
        expect(result, result.error).toMatchObject({
          ok: true,
          qualificationStatus: "unqualified",
          evidence: {
            observationSchema: "session-audio-observation/v1",
            sourceKind: kind,
            physicalClipIdentityProven: false,
            continuity: { followActions: "unknown" },
          },
        });
        expect(f.publications()).toBe(1);
        expect(f.mutations).toEqual(["launch"]);
        expect(f.log.indexOf("freeze")).toBeLessThan(
          f.log.indexOf("source:prepare"),
        );
        expect(f.log.indexOf("source:launch")).toBeLessThan(
          f.log.indexOf("native-completed"),
        );
        expect(f.log.indexOf("source:inspect")).toBeLessThan(
          f.log.indexOf("persisting"),
        );
        expect(f.log.filter((item) => item.startsWith("source:")).at(-1)).toBe(
          "source:release",
        );
        expect(
          f.p.snapshotNativeSessionListeningExpectation,
        ).toHaveBeenCalledTimes(2);
        expect(
          f.p.snapshotNativeSessionListeningExpectation.mock.calls[0],
        ).toEqual(f.p.snapshotNativeSessionListeningExpectation.mock.calls[1]);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
        for (const stage of [
          "session-source-baseline",
          "session-fixture-content-baseline",
          "session-source-prepare",
          "session-source-launch",
          "session-source-inspect",
          "session-source-release",
          "session-source-after",
          "session-fixture-content-after",
          "fixture-integrity",
        ]) {
          const events = result.lifecycle.filter((event) =>
            event.name.startsWith(`integration.native_listening.${stage}.`),
          );
          expect(events.map((event) => event.stage)).toEqual([
            "queued",
            "started",
            "progress",
            "completed",
          ]);
          expect(
            events.every(
              (event) =>
                event.durationMs >= 0 &&
                event.trace.traceId === events[0].trace.traceId &&
                event.correlationId === events[0].correlationId,
            ),
          ).toBe(true);
          for (let index = 1; index < events.length; index++)
            expect(events[index].causationId).toBe(events[index - 1].id);
        }
      } finally {
        await f.runner.close({ processStopped: true });
      }
      await expect(access(f.runner.fixture.setPath)).rejects.toThrow();
    },
  );
  it.each([
    ["version", "scope/sample rate/idle"],
    ["loop-end", "first-iteration geometry"],
    ["follow-enabled", "first-iteration geometry"],
    ["truncated-devices", "Complete bounded Session fixture"],
    ["truncated-midi", "immutable fixture MIDI content"],
    ["truncated-warp", "immutable fixture audio/warp content"],
    ["denial", "actor permission denied"],
    ["prepare-failure", "Session prepare denied"],
    ["prepare-cancelled", "Session prepare cancelled"],
  ])(
    "denies %s before any launch or publication and cleans only its staged copy",
    async (failure, message) => {
      const f = await fixture({ failure });
      try {
        const result = await f.runner.run(async () => {});
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining(message),
        });
        expect(JSON.stringify(result)).not.toContain("unit-private-value");
        if (failure.startsWith("prepare-")) {
          const events = result.lifecycle.filter((event) =>
            event.name.startsWith(
              "integration.native_listening.session-source-prepare.",
            ),
          );
          expect(events.map((event) => event.stage)).toEqual([
            "queued",
            "started",
            "progress",
            failure === "prepare-cancelled" ? "cancelled" : "failed",
          ]);
        }
        expect(f.mutations).toEqual([]);
        expect(f.publications()).toBe(0);
        expect(f.appStop).toHaveBeenCalledOnce();
        expect(f.signalStop).toHaveBeenCalledOnce();
      } finally {
        await f.runner.close({ processStopped: true });
      }
      await expect(access(f.input.sourceSet)).resolves.toBeUndefined();
    },
  );
  it.each([
    "midi-edit",
    "audio-edit",
    "warp-edit",
    "parameter-edit",
    "unselected-launch",
    "source-epoch",
  ])(
    "fails independent %s evidence rather than claiming a qualified unchanged fixture",
    async (failure) => {
      const f = await fixture({ failure });
      try {
        expect(await f.runner.run(async () => {})).toMatchObject({ ok: false });
        expect(f.mutations).toEqual(["launch"]);
        expect(
          f.originalSourcePass.mock.calls.filter(
            ([params]) => params.action === "launch",
          ),
        ).toHaveLength(1);
        expect(f.originalSourcePass.mock.calls.at(-1)[0].action).toBe(
          "release",
        );
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it.each(["cancelled", "capture"])(
    "retains %s failure, releases monitoring and publishes no context without stopping playback",
    async (failure) => {
      const f = await fixture({ failure });
      try {
        expect(await f.runner.run(async () => {})).toMatchObject({ ok: false });
        expect(f.publications()).toBe(0);
        expect(f.mutations).toEqual(["launch"]);
        expect(f.originalSourcePass.mock.calls.at(-1)[0]).toMatchObject({
          action: "release",
          reason: "cancelled",
        });
      } finally {
        await f.runner.close({ processStopped: true });
      }
    },
  );
  it("rejects inconsistent canonical clip/contributor associations before publication", async () => {
    const f = await fixture({ failure: "inconsistent-track-subject-id" });
    try {
      expect(await f.runner.run(async () => {})).toMatchObject({
        ok: false,
        error: expect.stringContaining("contributing track"),
      });
      expect(f.publications()).toBe(0);
    } finally {
      await f.runner.close({ processStopped: true });
    }
  });
});
