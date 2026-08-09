import type { AbletonService } from "@ableton-agent/ableton-contracts";
import type * as Protocol from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";

/** Raised for operations the fake deliberately does not simulate. */
export class UnsupportedByFakeError extends Error {
  public readonly code = "unsupported_by_fake";

  public constructor(operation: string) {
    super(`The fake Ableton service does not implement ${operation}`);
    this.name = "UnsupportedByFakeError";
  }
}

export interface FakeDevice {
  summary: Protocol.DeviceSummary;
  parameters: Protocol.DeviceParameterSummary[];
}

export interface FakeAbletonState {
  status: ConnectionStatus;
  snapshot: Protocol.SessionSnapshot;
  devicesByTrackReference: Record<string, FakeDevice[]>;
  capabilities: Protocol.CapabilityDocument;
}

const trackReference = "11111111-1111-4111-8111-111111111111";
const clipReference = "22222222-2222-4222-8222-222222222222";
const deviceReference = "33333333-3333-4333-8333-333333333333";
const parameterReference = "44444444-4444-4444-8444-444444444444";

/** A small but internally consistent Live set used by client tests. */
export function defaultFakeState(): FakeAbletonState {
  return {
    status: {
      state: "connected",
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      projectId: "project-fake",
    },
    capabilities: {
      selectedProtocolVersion: 2,
      liveVersion: "12.1",
      remoteScriptVersion: "0.2.0",
      projectId: "project-fake",
      capabilities: { "session.inspect": true, "transport.set_tempo": false },
      limits: { maxFrameBytes: 262_144, maxBatchItems: 64 },
    },
    snapshot: {
      tempo: 122,
      timeSignature: { numerator: 4, denominator: 4 },
      isPlaying: false,
      trackCount: 1,
      tracks: [
        {
          index: 0,
          reference: trackReference,
          name: "Bass",
          kind: "midi",
          color: 0x79_c2_ff,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.74,
          pan: -0.08,
        },
      ],
      clips: [
        {
          reference: clipReference,
          trackReference,
          trackIndex: 0,
          sceneIndex: 2,
          name: "Sub Motif",
          kind: "midi",
          length: 16,
          noteCount: 12,
          isPlaying: true,
          isTriggered: false,
        },
      ],
    },
    devicesByTrackReference: {
      [trackReference]: [
        {
          summary: {
            reference: deviceReference,
            trackReference,
            trackIndex: 0,
            index: 0,
            name: "Wavetable",
            className: "InstrumentVector",
            classDisplayName: "Wavetable",
            enabled: true,
            parameterCount: 1,
            canHaveChains: false,
            canHaveDrumPads: false,
          },
          parameters: [
            {
              reference: parameterReference,
              deviceReference,
              index: 0,
              name: "Filter cutoff",
              value: 2400,
              normalizedValue: 0.56,
              min: 20,
              max: 20_000,
              isQuantized: false,
              isEnabled: true,
              valueItemCount: 0,
            },
          ],
        },
      ],
    },
  };
}

/**
 * In-memory {@link AbletonService} used by client tests. Reads are answered
 * from a small deterministic Live set; unsimulated operations throw
 * {@link UnsupportedByFakeError} rather than returning invented success.
 */
export class FakeAbletonService implements AbletonService {
  public started = false;
  public state: FakeAbletonState;

  public constructor(state: FakeAbletonState = defaultFakeState()) {
    this.state = state;
  }

  public async start(): Promise<void> {
    this.started = true;
  }

  public async stop(): Promise<void> {
    this.started = false;
  }

  public async getStatus(): Promise<ConnectionStatus> {
    return this.started ? this.state.status : { state: "disconnected" };
  }

  public async getCapabilities(): Promise<Protocol.CapabilityDocument> {
    return this.state.capabilities;
  }

  public async ping(): Promise<Protocol.PingResult> {
    return { pong: true };
  }

  public async inspectSession(): Promise<Protocol.SessionSnapshot> {
    return this.state.snapshot;
  }

  public async setTempo(tempo: number): Promise<Protocol.SetTempoResult> {
    const beforeTempo = this.state.snapshot.tempo;
    this.state.snapshot = { ...this.state.snapshot, tempo };
    return { beforeTempo, afterTempo: tempo, verified: true };
  }

  public async setPlaying(
    isPlaying: boolean,
  ): Promise<Protocol.SetPlayingResult> {
    const beforeIsPlaying = this.state.snapshot.isPlaying;
    this.state.snapshot = { ...this.state.snapshot, isPlaying };
    return { beforeIsPlaying, afterIsPlaying: isPlaying, verified: true };
  }

  public async inspectDevices(
    params: Protocol.InspectDevicesParams,
  ): Promise<Protocol.InspectDevicesResult> {
    const devices =
      this.state.devicesByTrackReference[params.expectedReference] ?? [];
    const page = devices.slice(params.offset, params.offset + params.limit);
    return {
      devices: page.map((device) => device.summary),
      total: devices.length,
      offset: params.offset,
      limit: params.limit,
    };
  }

  public async inspectDeviceParameters(
    params: Protocol.InspectDeviceParametersParams,
  ): Promise<Protocol.InspectDeviceParametersResult> {
    const device = (
      this.state.devicesByTrackReference[params.expectedReference] ?? []
    ).find(
      (candidate) =>
        candidate.summary.reference === params.expectedDeviceReference,
    );
    if (!device) {
      throw new UnsupportedByFakeError(
        `parameters for unknown device ${params.expectedDeviceReference}`,
      );
    }
    const page = device.parameters.slice(
      params.offset,
      params.offset + params.limit,
    );
    return {
      device: device.summary,
      parameters: page,
      total: device.parameters.length,
      offset: params.offset,
      limit: params.limit,
    };
  }

  public inspectArrangementTransport(): Promise<Protocol.InspectArrangementTransportResult> {
    return Promise.reject(
      new UnsupportedByFakeError("inspectArrangementTransport"),
    );
  }
  public setArrangementLoop(): Promise<Protocol.SetArrangementLoopResult> {
    return Promise.reject(new UnsupportedByFakeError("setArrangementLoop"));
  }
  public createCuePoint(): Promise<Protocol.CuePointMutationResult> {
    return Promise.reject(new UnsupportedByFakeError("createCuePoint"));
  }
  public deleteCuePoint(): Promise<Protocol.CuePointMutationResult> {
    return Promise.reject(new UnsupportedByFakeError("deleteCuePoint"));
  }
  public createTrack(): Promise<Protocol.TrackMutationResult> {
    return Promise.reject(new UnsupportedByFakeError("createTrack"));
  }
  public deleteTrack(): Promise<Protocol.TrackMutationResult> {
    return Promise.reject(new UnsupportedByFakeError("deleteTrack"));
  }
  public renameTrack(): Promise<Protocol.RenameTrackResult> {
    return Promise.reject(new UnsupportedByFakeError("renameTrack"));
  }
  public setTrackMixer(): Promise<Protocol.SetTrackMixerResult> {
    return Promise.reject(new UnsupportedByFakeError("setTrackMixer"));
  }
  public inspectBrowserRoots(): Promise<Protocol.InspectBrowserRootsResult> {
    return Promise.reject(new UnsupportedByFakeError("inspectBrowserRoots"));
  }
  public inspectBrowserChildren(): Promise<Protocol.InspectBrowserChildrenResult> {
    return Promise.reject(new UnsupportedByFakeError("inspectBrowserChildren"));
  }
  public searchBrowser(): Promise<Protocol.SearchBrowserResult> {
    return Promise.reject(new UnsupportedByFakeError("searchBrowser"));
  }
  public loadBrowserItem(): Promise<Protocol.LoadBrowserItemResult> {
    return Promise.reject(new UnsupportedByFakeError("loadBrowserItem"));
  }
  public inspectRackChains(): Promise<Protocol.InspectRackChainsResult> {
    return Promise.reject(new UnsupportedByFakeError("inspectRackChains"));
  }
  public inspectRackChainDevices(): Promise<Protocol.InspectRackChainDevicesResult> {
    return Promise.reject(
      new UnsupportedByFakeError("inspectRackChainDevices"),
    );
  }
  public inspectDrumRackPads(): Promise<Protocol.InspectDrumRackPadsResult> {
    return Promise.reject(new UnsupportedByFakeError("inspectDrumRackPads"));
  }
  public inspectDrumPadChains(): Promise<Protocol.InspectDrumPadChainsResult> {
    return Promise.reject(new UnsupportedByFakeError("inspectDrumPadChains"));
  }
  public inspectDrumPadChainDevices(): Promise<Protocol.InspectDrumPadChainDevicesResult> {
    return Promise.reject(
      new UnsupportedByFakeError("inspectDrumPadChainDevices"),
    );
  }
  public setDeviceEnabled(): Promise<Protocol.SetDeviceEnabledResult> {
    return Promise.reject(new UnsupportedByFakeError("setDeviceEnabled"));
  }
  public setDeviceParameter(): Promise<Protocol.SetDeviceParameterResult> {
    return Promise.reject(new UnsupportedByFakeError("setDeviceParameter"));
  }
  public createMidiClip(): Promise<Protocol.CreateMidiClipResult> {
    return Promise.reject(new UnsupportedByFakeError("createMidiClip"));
  }
  public replaceMidiNotes(): Promise<Protocol.ReplaceMidiNotesResult> {
    return Promise.reject(new UnsupportedByFakeError("replaceMidiNotes"));
  }
  public launchSessionClip(): Promise<Protocol.LaunchSessionClipResult> {
    return Promise.reject(new UnsupportedByFakeError("launchSessionClip"));
  }
  public duplicateSessionClip(): Promise<Protocol.DuplicateSessionClipResult> {
    return Promise.reject(new UnsupportedByFakeError("duplicateSessionClip"));
  }
  public deleteSessionClip(): Promise<Protocol.DeleteSessionClipResult> {
    return Promise.reject(new UnsupportedByFakeError("deleteSessionClip"));
  }
  public setSessionClipProperties(): Promise<Protocol.SetSessionClipPropertiesResult> {
    return Promise.reject(
      new UnsupportedByFakeError("setSessionClipProperties"),
    );
  }
  public createArrangementMidiClip(): Promise<Protocol.CreateArrangementMidiClipResult> {
    return Promise.reject(
      new UnsupportedByFakeError("createArrangementMidiClip"),
    );
  }
  public inspectArrangement(): Promise<Protocol.InspectArrangementResult> {
    return Promise.reject(new UnsupportedByFakeError("inspectArrangement"));
  }
  public deleteArrangementClip(): Promise<Protocol.DeleteArrangementClipResult> {
    return Promise.reject(new UnsupportedByFakeError("deleteArrangementClip"));
  }
  public replaceArrangementMidiNotes(): Promise<Protocol.ReplaceArrangementMidiNotesResult> {
    return Promise.reject(
      new UnsupportedByFakeError("replaceArrangementMidiNotes"),
    );
  }
  public duplicateClipToArrangement(): Promise<Protocol.DuplicateClipToArrangementResult> {
    return Promise.reject(
      new UnsupportedByFakeError("duplicateClipToArrangement"),
    );
  }
  public setArrangementClipProperties(): Promise<Protocol.SetArrangementClipPropertiesResult> {
    return Promise.reject(
      new UnsupportedByFakeError("setArrangementClipProperties"),
    );
  }
}
