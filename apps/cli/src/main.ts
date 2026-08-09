#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline";

import {
  CopilotAgentService,
  HeadlessApplication,
  type AbletonService,
} from "@ableton-agent/application";
import { AbletonBridgeService } from "@ableton-agent/bridge";
import {
  InMemoryEventPublisher,
  noopLogger,
  type ConnectionStatus,
} from "@ableton-agent/shared";
import type {
  CapabilityDocument,
  CreateCuePointParams,
  CuePointMutationResult,
  CreateArrangementMidiClipParams,
  CreateArrangementMidiClipResult,
  DeleteArrangementClipParams,
  DeleteArrangementClipResult,
  DeleteCuePointParams,
  DuplicateClipToArrangementParams,
  DuplicateClipToArrangementResult,
  DuplicateSessionClipParams,
  DuplicateSessionClipResult,
  CreateMidiClipParams,
  CreateMidiClipResult,
  CreateTrackParams,
  DeleteTrackParams,
  DeleteSessionClipParams,
  DeleteSessionClipResult,
  RenameTrackParams,
  RenameTrackResult,
  ReplaceMidiNotesParams,
  ReplaceMidiNotesResult,
  ReplaceArrangementMidiNotesParams,
  ReplaceArrangementMidiNotesResult,
  SetArrangementClipPropertiesParams,
  SetArrangementClipPropertiesResult,
  SetArrangementLoopParams,
  SetArrangementLoopResult,
  SetSessionClipPropertiesParams,
  SetSessionClipPropertiesResult,
  PingResult,
  InspectArrangementParams,
  InspectArrangementResult,
  InspectArrangementTransportParams,
  InspectArrangementTransportResult,
  InspectDeviceParametersParams,
  InspectDeviceParametersResult,
  InspectDevicesParams,
  InspectDevicesResult,
  InspectDrumPadChainDevicesParams,
  InspectDrumPadChainDevicesResult,
  InspectDrumPadChainsParams,
  InspectDrumPadChainsResult,
  InspectDrumRackPadsParams,
  InspectDrumRackPadsResult,
  InspectRackChainDevicesParams,
  InspectRackChainDevicesResult,
  InspectRackChainsParams,
  InspectRackChainsResult,
  LaunchSessionClipParams,
  LaunchSessionClipResult,
  SessionSnapshot,
  SetPlayingResult,
  SetTempoResult,
  SetTrackMixerParams,
  SetTrackMixerResult,
  SetDeviceEnabledParams,
  SetDeviceEnabledResult,
  SetDeviceParameterParams,
  SetDeviceParameterResult,
  TrackMutationResult,
} from "@ableton-agent/protocol";

import { CliUsageError, parseArgs, runCommand, type CliIo } from "./cli.js";
import type { InteractiveInput } from "./cli.js";

class BufferedLineInput implements InteractiveInput {
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | undefined) => void> = [];
  #closed = false;

  public constructor(private readonly terminal: Interface) {
    terminal.on("SIGINT", () => terminal.close());
    terminal.on("line", (line) => {
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        this.#lines.push(line);
      }
    });
    terminal.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter(undefined);
      }
    });
  }

  public readLine(): Promise<string | undefined> {
    const line = this.#lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  public close(): void {
    this.terminal.close();
  }
}

class UnconfiguredAbletonService implements AbletonService {
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async getStatus(): Promise<ConnectionStatus> {
    return {
      state: "error",
      code: "configuration_missing",
      message: "Set ABLETON_AGENT_TOKEN to connect to the Remote Script",
    };
  }
  public async getCapabilities(): Promise<CapabilityDocument> {
    throw new Error("Ableton bridge is not configured");
  }
  public async ping(): Promise<PingResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectSession(): Promise<SessionSnapshot> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setTempo(): Promise<SetTempoResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setPlaying(): Promise<SetPlayingResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectArrangementTransport(): Promise<InspectArrangementTransportResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setArrangementLoop(): Promise<SetArrangementLoopResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async createCuePoint(): Promise<CuePointMutationResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async deleteCuePoint(): Promise<CuePointMutationResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async createTrack(): Promise<TrackMutationResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async deleteTrack(): Promise<TrackMutationResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async renameTrack(): Promise<RenameTrackResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setTrackMixer(): Promise<SetTrackMixerResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectDevices(): Promise<InspectDevicesResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectDeviceParameters(): Promise<InspectDeviceParametersResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectRackChains(): Promise<InspectRackChainsResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectRackChainDevices(): Promise<InspectRackChainDevicesResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectDrumRackPads(): Promise<InspectDrumRackPadsResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectDrumPadChains(): Promise<InspectDrumPadChainsResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectDrumPadChainDevices(): Promise<InspectDrumPadChainDevicesResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setDeviceEnabled(): Promise<SetDeviceEnabledResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setDeviceParameter(): Promise<SetDeviceParameterResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async createMidiClip(): Promise<CreateMidiClipResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async replaceMidiNotes(): Promise<ReplaceMidiNotesResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async launchSessionClip(): Promise<LaunchSessionClipResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async duplicateSessionClip(): Promise<DuplicateSessionClipResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async deleteSessionClip(): Promise<DeleteSessionClipResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setSessionClipProperties(): Promise<SetSessionClipPropertiesResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async createArrangementMidiClip(): Promise<CreateArrangementMidiClipResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectArrangement(): Promise<InspectArrangementResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async deleteArrangementClip(): Promise<DeleteArrangementClipResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async replaceArrangementMidiNotes(): Promise<ReplaceArrangementMidiNotesResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async duplicateClipToArrangement(): Promise<DuplicateClipToArrangementResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setArrangementClipProperties(): Promise<SetArrangementClipPropertiesResult> {
    throw new Error("Ableton bridge is not configured");
  }
}

const io: CliIo = {
  write: (text) => process.stdout.write(`${text}\n`),
  writeRaw: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(`${text}\n`),
};

async function main(): Promise<number> {
  try {
    const command = parseArgs(process.argv.slice(2));
    const terminal =
      command.name === "chat"
        ? new BufferedLineInput(
            createInterface({
              input: process.stdin,
              output: process.stdout,
              terminal: process.stdin.isTTY,
            }),
          )
        : undefined;
    const events = new InMemoryEventPublisher();
    const token = process.env.ABLETON_AGENT_TOKEN;
    const configuredPort = Number(process.env.ABLETON_AGENT_PORT ?? "8765");
    if (
      !Number.isInteger(configuredPort) ||
      configuredPort < 1 ||
      configuredPort > 65_535
    ) {
      throw new CliUsageError(
        "ABLETON_AGENT_PORT must be an integer from 1 to 65535",
      );
    }
    const ableton =
      token === undefined
        ? new UnconfiguredAbletonService()
        : new AbletonBridgeService({
            authenticationToken: token,
            events,
            port: configuredPort,
          });
    const agent = new CopilotAgentService({
      events,
      getAbletonStatus: () => ableton.getStatus(),
      inspectSession: () => ableton.inspectSession(),
      setTempo: (tempo) => ableton.setTempo(tempo),
      setPlaying: (isPlaying) => ableton.setPlaying(isPlaying),
      inspectArrangementTransport: (
        params: InspectArrangementTransportParams,
      ) => ableton.inspectArrangementTransport(params),
      setArrangementLoop: (params: SetArrangementLoopParams) =>
        ableton.setArrangementLoop(params),
      createCuePoint: (params: CreateCuePointParams) =>
        ableton.createCuePoint(params),
      deleteCuePoint: (params: DeleteCuePointParams) =>
        ableton.deleteCuePoint(params),
      createTrack: (params: CreateTrackParams) => ableton.createTrack(params),
      deleteTrack: (params: DeleteTrackParams) => ableton.deleteTrack(params),
      renameTrack: (params: RenameTrackParams) => ableton.renameTrack(params),
      setTrackMixer: (params: SetTrackMixerParams) =>
        ableton.setTrackMixer(params),
      inspectDevices: (params: InspectDevicesParams) =>
        ableton.inspectDevices(params),
      inspectDeviceParameters: (params: InspectDeviceParametersParams) =>
        ableton.inspectDeviceParameters(params),
      inspectRackChains: (params: InspectRackChainsParams) =>
        ableton.inspectRackChains(params),
      inspectRackChainDevices: (params: InspectRackChainDevicesParams) =>
        ableton.inspectRackChainDevices(params),
      inspectDrumRackPads: (params: InspectDrumRackPadsParams) =>
        ableton.inspectDrumRackPads(params),
      inspectDrumPadChains: (params: InspectDrumPadChainsParams) =>
        ableton.inspectDrumPadChains(params),
      inspectDrumPadChainDevices: (params: InspectDrumPadChainDevicesParams) =>
        ableton.inspectDrumPadChainDevices(params),
      setDeviceEnabled: (params: SetDeviceEnabledParams) =>
        ableton.setDeviceEnabled(params),
      setDeviceParameter: (params: SetDeviceParameterParams) =>
        ableton.setDeviceParameter(params),
      createMidiClip: (params: CreateMidiClipParams) =>
        ableton.createMidiClip(params),
      replaceMidiNotes: (params: ReplaceMidiNotesParams) =>
        ableton.replaceMidiNotes(params),
      launchSessionClip: (params: LaunchSessionClipParams) =>
        ableton.launchSessionClip(params),
      duplicateSessionClip: (params: DuplicateSessionClipParams) =>
        ableton.duplicateSessionClip(params),
      deleteSessionClip: (params: DeleteSessionClipParams) =>
        ableton.deleteSessionClip(params),
      setSessionClipProperties: (params: SetSessionClipPropertiesParams) =>
        ableton.setSessionClipProperties(params),
      createArrangementMidiClip: (params: CreateArrangementMidiClipParams) =>
        ableton.createArrangementMidiClip(params),
      inspectArrangement: (params: InspectArrangementParams) =>
        ableton.inspectArrangement(params),
      deleteArrangementClip: (params: DeleteArrangementClipParams) =>
        ableton.deleteArrangementClip(params),
      replaceArrangementMidiNotes: (
        params: ReplaceArrangementMidiNotesParams,
      ) => ableton.replaceArrangementMidiNotes(params),
      duplicateClipToArrangement: (params: DuplicateClipToArrangementParams) =>
        ableton.duplicateClipToArrangement(params),
      setArrangementClipProperties: (
        params: SetArrangementClipPropertiesParams,
      ) => ableton.setArrangementClipProperties(params),
      ...(terminal === undefined
        ? {}
        : {
            requestToolApproval: async (request) => {
              io.write(
                `Approval required: ${request.metadata.title} (${request.metadata.risk})`,
              );
              io.write(`Arguments: ${JSON.stringify(request.arguments)}`);
              io.writeRaw("Approve once? [y/N] ");
              const answer = await terminal.readLine();
              return answer?.trim().toLowerCase() === "y";
            },
          }),
    });
    const application = new HeadlessApplication({
      agent,
      ableton,
      events,
      logger: noopLogger,
    });
    try {
      return await runCommand(command, application, io, terminal);
    } finally {
      terminal?.close();
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.writeError(error.message);
      return 2;
    }
    io.writeError(error instanceof Error ? error.message : String(error));
    return 5;
  }
}

process.exitCode = await main();
