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
  InspectBrowserRootsResult,
  InspectBrowserChildrenParams,
  InspectBrowserChildrenResult,
  SearchBrowserParams,
  SearchBrowserResult,
  LoadBrowserItemParams,
  LoadBrowserItemResult,
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
import { EXIT_CODES, exitCodeForError } from "./exit-codes.js";
import { shouldUseColor } from "./terminal.js";

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
  private unavailable(): never {
    throw Object.assign(new Error("Ableton bridge is not configured"), {
      code: "configuration_missing",
    });
  }

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
    this.unavailable();
  }
  public async ping(): Promise<PingResult> {
    this.unavailable();
  }
  public async inspectSession(): Promise<SessionSnapshot> {
    this.unavailable();
  }
  public async setTempo(): Promise<SetTempoResult> {
    this.unavailable();
  }
  public async setPlaying(): Promise<SetPlayingResult> {
    this.unavailable();
  }
  public async inspectArrangementTransport(): Promise<InspectArrangementTransportResult> {
    this.unavailable();
  }
  public async setArrangementLoop(): Promise<SetArrangementLoopResult> {
    this.unavailable();
  }
  public async createCuePoint(): Promise<CuePointMutationResult> {
    this.unavailable();
  }
  public async deleteCuePoint(): Promise<CuePointMutationResult> {
    this.unavailable();
  }
  public async createTrack(): Promise<TrackMutationResult> {
    this.unavailable();
  }
  public async deleteTrack(): Promise<TrackMutationResult> {
    this.unavailable();
  }
  public async renameTrack(): Promise<RenameTrackResult> {
    this.unavailable();
  }
  public async setTrackMixer(): Promise<SetTrackMixerResult> {
    this.unavailable();
  }
  public async inspectDevices(): Promise<InspectDevicesResult> {
    this.unavailable();
  }
  public async inspectBrowserRoots(): Promise<InspectBrowserRootsResult> {
    this.unavailable();
  }
  public async inspectBrowserChildren(): Promise<InspectBrowserChildrenResult> {
    this.unavailable();
  }
  public async searchBrowser(): Promise<SearchBrowserResult> {
    this.unavailable();
  }
  public async loadBrowserItem(): Promise<LoadBrowserItemResult> {
    this.unavailable();
  }
  public async inspectDeviceParameters(): Promise<InspectDeviceParametersResult> {
    this.unavailable();
  }
  public async inspectRackChains(): Promise<InspectRackChainsResult> {
    this.unavailable();
  }
  public async inspectRackChainDevices(): Promise<InspectRackChainDevicesResult> {
    this.unavailable();
  }
  public async inspectDrumRackPads(): Promise<InspectDrumRackPadsResult> {
    this.unavailable();
  }
  public async inspectDrumPadChains(): Promise<InspectDrumPadChainsResult> {
    this.unavailable();
  }
  public async inspectDrumPadChainDevices(): Promise<InspectDrumPadChainDevicesResult> {
    this.unavailable();
  }
  public async setDeviceEnabled(): Promise<SetDeviceEnabledResult> {
    this.unavailable();
  }
  public async setDeviceParameter(): Promise<SetDeviceParameterResult> {
    this.unavailable();
  }
  public async createMidiClip(): Promise<CreateMidiClipResult> {
    this.unavailable();
  }
  public async replaceMidiNotes(): Promise<ReplaceMidiNotesResult> {
    this.unavailable();
  }
  public async launchSessionClip(): Promise<LaunchSessionClipResult> {
    this.unavailable();
  }
  public async duplicateSessionClip(): Promise<DuplicateSessionClipResult> {
    this.unavailable();
  }
  public async deleteSessionClip(): Promise<DeleteSessionClipResult> {
    this.unavailable();
  }
  public async setSessionClipProperties(): Promise<SetSessionClipPropertiesResult> {
    this.unavailable();
  }
  public async createArrangementMidiClip(): Promise<CreateArrangementMidiClipResult> {
    this.unavailable();
  }
  public async inspectArrangement(): Promise<InspectArrangementResult> {
    this.unavailable();
  }
  public async deleteArrangementClip(): Promise<DeleteArrangementClipResult> {
    this.unavailable();
  }
  public async replaceArrangementMidiNotes(): Promise<ReplaceArrangementMidiNotesResult> {
    this.unavailable();
  }
  public async duplicateClipToArrangement(): Promise<DuplicateClipToArrangementResult> {
    this.unavailable();
  }
  public async setArrangementClipProperties(): Promise<SetArrangementClipPropertiesResult> {
    this.unavailable();
  }
}

const io: CliIo = {
  write: (text) => process.stdout.write(`${text}\n`),
  writeRaw: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(`${text}\n`),
};

async function main(): Promise<number> {
  try {
    const rawArgs = process.argv.slice(2);
    const quiet = rawArgs.includes("--quiet") || rawArgs.includes("-q");
    const args = rawArgs.filter(
      (argument) => argument !== "--quiet" && argument !== "-q",
    );
    const color = shouldUseColor({ isTTY: process.stdout.isTTY }, process.env);
    const command = parseArgs(args);
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
      inspectBrowserRoots: () => ableton.inspectBrowserRoots(),
      inspectBrowserChildren: (params: InspectBrowserChildrenParams) =>
        ableton.inspectBrowserChildren(params),
      searchBrowser: (params: SearchBrowserParams) =>
        ableton.searchBrowser(params),
      loadBrowserItem: (params: LoadBrowserItemParams) =>
        ableton.loadBrowserItem(params),
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
      return await runCommand(command, application, io, terminal, {
        quiet,
        color,
      });
    } finally {
      terminal?.close();
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.writeError(error.message);
      return EXIT_CODES.USAGE_ERROR;
    }
    io.writeError(error instanceof Error ? error.message : String(error));
    return exitCodeForError(error);
  }
}

process.on("SIGINT", () => {
  // Force an immediate, unambiguous exit on Ctrl+C rather than waiting for
  // in-flight I/O (e.g. a pending Ableton round trip) to settle.
  process.exit(EXIT_CODES.INTERRUPTED);
});

process.exitCode = await main();
