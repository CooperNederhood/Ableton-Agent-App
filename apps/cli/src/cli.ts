import type { HeadlessApplication } from "@ableton-agent/application";
import type { BrowserRootKey } from "@ableton-agent/protocol";
import type { AppEvent } from "@ableton-agent/shared";

export type CliCommand =
  | { name: "chat"; json: false }
  | { name: "status"; json: boolean }
  | { name: "doctor"; json: boolean }
  | { name: "capabilities"; json: boolean }
  | { name: "snapshot"; json: boolean }
  | { name: "transport"; json: boolean }
  | { name: "browser-roots"; json: boolean }
  | {
      name: "browser-category";
      root: BrowserRootKey;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "browser-search";
      query: string;
      roots: BrowserRootKey[];
      maxNodes: number;
      maxResults: number;
      maxDepth: number;
      maxDurationMs: number;
      json: boolean;
    }
  | {
      name: "browser-load";
      trackNumber: number;
      query: string;
      resultNumber: number;
      roots: BrowserRootKey[];
      maxNodes: number;
      maxResults: number;
      maxDepth: number;
      maxDurationMs: number;
      json: boolean;
    }
  | { name: "devices"; trackNumber: number; json: boolean }
  | {
      name: "parameters";
      trackNumber: number;
      deviceNumber: number;
      json: boolean;
    }
  | {
      name: "rack-chains";
      trackNumber: number;
      deviceNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "drum-pads";
      trackNumber: number;
      deviceNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "chain-devices";
      trackNumber: number;
      deviceNumber: number;
      chainNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "pad-chains";
      trackNumber: number;
      deviceNumber: number;
      padNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "pad-chain-devices";
      trackNumber: number;
      deviceNumber: number;
      padNumber: number;
      chainNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | { name: "run"; prompt: string; json: boolean }
  | { name: "help"; json: false };

export class CliUsageError extends Error {}

export function parseArgs(args: readonly string[]): CliCommand {
  const json = args.includes("--json");
  const positional = args.filter((argument) => argument !== "--json");
  const command = positional[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    return { name: "help", json: false };
  }
  if (command === "chat") {
    if (positional.length !== 1 || json) {
      throw new CliUsageError("chat does not accept arguments or --json");
    }
    return { name: "chat", json: false };
  }
  if (
    command === "status" ||
    command === "doctor" ||
    command === "capabilities" ||
    command === "snapshot" ||
    command === "transport" ||
    command === "browser-roots"
  ) {
    if (positional.length !== 1) {
      throw new CliUsageError(
        `${command} does not accept positional arguments`,
      );
    }
    return { name: command, json };
  }
  if (command === "browser-category") {
    const page = parsePageArgs(positional, 32, 64);
    if (page.positional.length !== 2) {
      throw new CliUsageError("browser-category requires a browser root key");
    }
    return {
      name: command,
      root: parseBrowserRoot(page.positional[1] ?? ""),
      offset: page.offset,
      limit: page.limit,
      json,
    };
  }
  if (command === "browser-search") {
    const search = parseBrowserSearchArgs(positional);
    if (search.positional.length !== 2) {
      throw new CliUsageError(
        "browser-search requires one quoted search query",
      );
    }
    return {
      name: command,
      query: search.positional[1] ?? "",
      ...search.options,
      json,
    };
  }
  if (command === "browser-load") {
    const approved = positional.includes("--approve");
    const search = parseBrowserSearchArgs(
      positional.filter((argument) => argument !== "--approve"),
    );
    if (search.positional.length !== 4) {
      throw new CliUsageError(
        "browser-load requires track number, quoted query, and result number",
      );
    }
    if (!approved) {
      throw new CliUsageError(
        "browser-load requires --approve for this reversible mutation",
      );
    }
    return {
      name: command,
      trackNumber: parsePositiveIndex(search.positional[1] ?? "", "track"),
      query: search.positional[2] ?? "",
      resultNumber: parsePositiveIndex(search.positional[3] ?? "", "result"),
      ...search.options,
      json,
    };
  }
  if (command === "devices") {
    if (positional.length !== 2) {
      throw new CliUsageError("devices requires a one-based track number");
    }
    return {
      name: "devices",
      trackNumber: parsePositiveIndex(positional[1] ?? "", "track"),
      json,
    };
  }
  if (command === "parameters") {
    if (positional.length !== 3) {
      throw new CliUsageError(
        "parameters requires one-based track and device numbers",
      );
    }
    return {
      name: "parameters",
      trackNumber: parsePositiveIndex(positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(positional[2] ?? "", "device"),
      json,
    };
  }
  if (command === "rack-chains" || command === "drum-pads") {
    const page = parsePageArgs(
      positional,
      command === "rack-chains" ? 16 : 32,
      command === "rack-chains" ? 64 : 128,
    );
    if (page.positional.length !== 3) {
      throw new CliUsageError(
        `${command} requires one-based track and device numbers`,
      );
    }
    return {
      name: command,
      trackNumber: parsePositiveIndex(page.positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(page.positional[2] ?? "", "device"),
      offset: page.offset,
      limit: page.limit,
      json,
    };
  }
  if (command === "chain-devices") {
    const page = parsePageArgs(positional, 32, 128);
    if (page.positional.length !== 4) {
      throw new CliUsageError(
        "chain-devices requires one-based track, device, and chain numbers",
      );
    }
    return {
      name: command,
      trackNumber: parsePositiveIndex(page.positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(page.positional[2] ?? "", "device"),
      chainNumber: parsePositiveIndex(page.positional[3] ?? "", "chain"),
      offset: page.offset,
      limit: page.limit,
      json,
    };
  }
  if (command === "pad-chains" || command === "pad-chain-devices") {
    const page = parsePageArgs(
      positional,
      command === "pad-chains" ? 8 : 32,
      command === "pad-chains" ? 64 : 128,
    );
    const expectedLength = command === "pad-chains" ? 4 : 5;
    if (page.positional.length !== expectedLength) {
      throw new CliUsageError(
        `${command} requires one-based track, device, pad${command === "pad-chain-devices" ? ", and chain" : ""} numbers`,
      );
    }
    const common = {
      trackNumber: parsePositiveIndex(page.positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(page.positional[2] ?? "", "device"),
      padNumber: parsePositiveIndex(page.positional[3] ?? "", "pad"),
      offset: page.offset,
      limit: page.limit,
      json,
    };
    return command === "pad-chains"
      ? { name: command, ...common }
      : {
          name: command,
          ...common,
          chainNumber: parsePositiveIndex(page.positional[4] ?? "", "chain"),
        };
  }
  if (command === "run") {
    const prompt = positional.slice(1).join(" ").trim();
    if (!prompt) {
      throw new CliUsageError("run requires a prompt");
    }
    return { name: "run", prompt, json };
  }
  throw new CliUsageError(`Unknown command: ${command}`);
}

function parsePositiveIndex(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${label} number must be a positive integer`);
  }
  return parsed;
}

function parsePageArgs(
  args: readonly string[],
  defaultLimit: number,
  maximumLimit: number,
): { positional: string[]; offset: number; limit: number } {
  const positional: string[] = [];
  let offset = 0;
  let limit = defaultLimit;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--offset" && argument !== "--limit") {
      positional.push(argument ?? "");
      continue;
    }

    const value = Number(args[index + 1]);
    if (
      !Number.isInteger(value) ||
      value < (argument === "--offset" ? 0 : 1) ||
      (argument === "--limit" && value > maximumLimit)
    ) {
      throw new CliUsageError(
        argument === "--offset"
          ? "offset must be a non-negative integer"
          : `limit must be an integer from 1 to ${maximumLimit}`,
      );
    }
    if (argument === "--offset") {
      offset = value;
    } else {
      limit = value;
    }
    index += 1;
  }
  return { positional, offset, limit };
}

const browserRootKeys = [
  "sounds",
  "drums",
  "instruments",
  "audio_effects",
  "midi_effects",
  "max_for_live",
  "plugins",
  "clips",
  "samples",
  "packs",
  "user_library",
  "current_project",
] as const;

function parseBrowserRoot(value: string): BrowserRootKey {
  if (!(browserRootKeys as readonly string[]).includes(value)) {
    throw new CliUsageError(`unknown browser root: ${value}`);
  }
  return value as BrowserRootKey;
}

function parseBrowserSearchArgs(args: readonly string[]): {
  positional: string[];
  options: {
    roots: BrowserRootKey[];
    maxNodes: number;
    maxResults: number;
    maxDepth: number;
    maxDurationMs: number;
  };
} {
  const positional: string[] = [];
  const roots: BrowserRootKey[] = [];
  let maxNodes = 128;
  let maxResults = 20;
  let maxDepth = 4;
  let maxDurationMs = 100;
  const numeric = {
    "--max-nodes": { minimum: 1, maximum: 256 },
    "--limit": { minimum: 1, maximum: 32 },
    "--depth": { minimum: 0, maximum: 6 },
    "--duration-ms": { minimum: 10, maximum: 250 },
  } as const;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      roots.push(parseBrowserRoot(args[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (argument && argument in numeric) {
      const bounds = numeric[argument as keyof typeof numeric];
      const value = Number(args[index + 1]);
      if (
        !Number.isInteger(value) ||
        value < bounds.minimum ||
        value > bounds.maximum
      ) {
        throw new CliUsageError(
          `${argument} must be an integer from ${bounds.minimum} to ${bounds.maximum}`,
        );
      }
      if (argument === "--max-nodes") maxNodes = value;
      if (argument === "--limit") maxResults = value;
      if (argument === "--depth") maxDepth = value;
      if (argument === "--duration-ms") maxDurationMs = value;
      index += 1;
      continue;
    }
    positional.push(argument ?? "");
  }
  if (new Set(roots).size !== roots.length) {
    throw new CliUsageError("browser roots must be unique");
  }
  return {
    positional,
    options: {
      roots:
        roots.length > 0
          ? roots
          : ["instruments", "audio_effects", "midi_effects"],
      maxNodes,
      maxResults,
      maxDepth,
      maxDurationMs,
    },
  };
}

export interface CliIo {
  write(text: string): void;
  writeRaw(text: string): void;
  writeError(text: string): void;
}

export interface InteractiveInput {
  readLine(): Promise<string | undefined>;
}

export function renderEvent(event: AppEvent): string | undefined {
  switch (event.type) {
    case "lifecycle.changed":
      return `application: ${event.state}`;
    case "ableton.connection_changed":
      return `ableton: ${event.status.state}`;
    case "agent.message_delta":
      return event.content;
    case "agent.message_complete":
      return event.content;
    case "operation.started":
      return `• ${event.label}`;
    case "operation.completed":
      return `✓ ${event.summary}`;
    case "operation.failed":
      return `✗ ${event.message}`;
  }
}

export async function runCommand(
  command: CliCommand,
  application: HeadlessApplication,
  io: CliIo,
  input?: InteractiveInput,
): Promise<number> {
  if (command.name === "help") {
    io.write(
      [
        "Ableton Agent",
        "",
        "Usage:",
        "  ableton-agent chat",
        "  ableton-agent status [--json]",
        "  ableton-agent doctor [--json]",
        "  ableton-agent capabilities [--json]",
        "  ableton-agent snapshot [--json]",
        "  ableton-agent transport [--json]",
        "  ableton-agent browser-roots [--json]",
        "  ableton-agent browser-category <root-key> [--offset N] [--limit N] [--json]",
        '  ableton-agent browser-search "<query>" [--root KEY] [--max-nodes N] [--limit N] [--depth N] [--duration-ms N] [--json]',
        '  ableton-agent browser-load <track-number> "<query>" <result-number> --approve [browser search options] [--json]',
        "  ableton-agent devices <track-number> [--json]",
        "  ableton-agent parameters <track-number> <device-number> [--json]",
        "  ableton-agent rack-chains <track-number> <device-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent chain-devices <track-number> <device-number> <chain-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent drum-pads <track-number> <device-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent pad-chains <track-number> <device-number> <pad-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent pad-chain-devices <track-number> <device-number> <pad-number> <chain-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent run <prompt> [--json]",
      ].join("\n"),
    );
    return 0;
  }

  if (command.name === "chat") {
    if (!input) {
      throw new Error("Interactive input is required for chat");
    }
    return runInteractive(application, io, input);
  }

  await application.start({ startAgent: command.name === "run" });
  const operationFailures: Array<
    Extract<AppEvent, { type: "operation.failed" }>
  > = [];
  const unsubscribe = application.subscribe((event) => {
    if (event.type === "operation.failed") {
      operationFailures.push(event);
    }
  });
  try {
    if (command.name === "status") {
      const status = await application.getStatus();
      const payload = {
        application: application.state,
        ableton: status,
        healthy: application.state === "ready" && status.state === "connected",
      };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : [
              `Application: ${payload.application}`,
              `Ableton: ${status.state}`,
              `Healthy: ${payload.healthy ? "yes" : "no"}`,
            ].join("\n"),
      );
      return payload.healthy ? 0 : 3;
    }

    if (command.name === "doctor") {
      const status = await application.getStatus();
      const ping =
        status.state === "connected" ? await application.ping() : null;
      const payload = {
        application: application.state,
        ableton: status,
        ping,
        healthy: status.state === "connected" && ping?.pong === true,
      };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : [
              `Application: ${payload.application}`,
              `Ableton: ${status.state}`,
              `Ping: ${ping?.pong === true ? "ok" : "unavailable"}`,
              `Healthy: ${payload.healthy ? "yes" : "no"}`,
            ].join("\n"),
      );
      return payload.healthy ? 0 : 3;
    }

    if (command.name === "capabilities") {
      const capabilities = await application.getCapabilities();
      io.write(
        command.json
          ? JSON.stringify(capabilities)
          : Object.entries(capabilities.capabilities)
              .filter(([, supported]) => supported)
              .map(([name]) => name)
              .join("\n"),
      );
      return 0;
    }

    if (command.name === "browser-roots") {
      const result = await application.inspectBrowserRoots();
      io.write(
        command.json
          ? JSON.stringify(result)
          : [
              `Browser roots: ${result.roots.length}`,
              ...result.roots.map(
                (root) =>
                  `  ${root.root}: ${root.name}${root.isBuiltInDevice ? " (built-in device loading allowed)" : ""}`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "browser-category") {
      const roots = await application.inspectBrowserRoots();
      const root = roots.roots.find(
        (candidate) => candidate.root === command.root,
      );
      if (!root) {
        throw new CliUsageError(
          "browser root is unavailable in this Live version",
        );
      }
      const result = await application.inspectBrowserChildren({
        expectedItemReference: root.reference,
        expectedItemRoot: root.root,
        expectedItemPath: root.path,
        expectedItemName: root.name,
        expectedItemUri: root.uri,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(result)
          : [
              `${root.name}: ${result.total}`,
              ...result.items.map(
                (item, index) =>
                  `  ${command.offset + index + 1}. ${item.name}${item.isFolder ? "/" : ""}${item.isLoadable ? " (loadable)" : ""}`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "browser-search") {
      const result = await application.searchBrowser({
        query: command.query,
        roots: command.roots,
        maxNodes: command.maxNodes,
        maxResults: command.maxResults,
        maxDepth: command.maxDepth,
        maxDurationMs: command.maxDurationMs,
      });
      io.write(
        command.json
          ? JSON.stringify(result)
          : [
              `Browser matches: ${result.items.length} (${result.visitedNodes} nodes, ${result.stopReason})`,
              ...result.items.map(
                (item, index) =>
                  `  ${index + 1}. [${item.root}] ${item.path.map((segment) => segment.name).join(" / ")}${item.isLoadable ? " (loadable)" : ""}`,
              ),
              ...(result.truncated
                ? ["  Results truncated by configured limits."]
                : []),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "browser-load") {
      const track = await resolveTrack(application, command.trackNumber);
      const search = await application.searchBrowser({
        query: command.query,
        roots: command.roots,
        maxNodes: command.maxNodes,
        maxResults: command.maxResults,
        maxDepth: command.maxDepth,
        maxDurationMs: command.maxDurationMs,
      });
      const item = search.items[command.resultNumber - 1];
      if (!item) {
        throw new CliUsageError("browser result number is out of range");
      }
      const result = await application.loadBrowserItem({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        expectedItemReference: item.reference,
        expectedItemRoot: item.root,
        expectedItemPath: item.path,
        expectedItemName: item.name,
        expectedItemUri: item.uri,
      });
      io.write(
        command.json
          ? JSON.stringify(result)
          : `Loaded ${result.item.name} on ${result.track.name}; devices ${result.before.deviceCount} → ${result.after.deviceCount} (verified).`,
      );
      return 0;
    }

    if (command.name === "snapshot") {
      const snapshot = await application.inspectSession();
      io.write(
        command.json
          ? JSON.stringify(snapshot)
          : [
              `Tempo: ${snapshot.tempo}`,
              `Time signature: ${snapshot.timeSignature.numerator}/${snapshot.timeSignature.denominator}`,
              `Playing: ${snapshot.isPlaying ? "yes" : "no"}`,
              `Tracks: ${snapshot.trackCount}`,
              ...snapshot.tracks.map(
                (track) => `  ${track.index + 1}. ${track.name}`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "transport") {
      const transport = await application.inspectArrangementTransport({
        offset: 0,
        limit: 100,
      });
      io.write(
        command.json
          ? JSON.stringify(transport)
          : [
              `Arrangement loop: ${transport.loop.enabled ? "enabled" : "disabled"}`,
              `Loop range: ${transport.loop.start} + ${transport.loop.length} beats`,
              `Cue points: ${transport.totalCuePoints}`,
              ...transport.cuePoints.map(
                (cuePoint) => `  ${cuePoint.time}: ${cuePoint.name}`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "devices") {
      const track = await resolveTrack(application, command.trackNumber);
      const devices = await application.inspectDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        offset: 0,
        limit: 128,
      });
      io.write(
        command.json
          ? JSON.stringify(devices)
          : [
              `Devices on track ${command.trackNumber} (${track.name}): ${devices.total}`,
              ...devices.devices.map(
                (device) =>
                  `  ${device.index + 1}. ${device.name} (${device.parameterCount} parameters, ${device.enabled === null ? "enable state unavailable" : device.enabled ? "enabled" : "disabled"})`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "parameters") {
      const track = await resolveTrack(application, command.trackNumber);
      const devicePage = await application.inspectDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        offset: command.deviceNumber - 1,
        limit: 1,
      });
      const device = devicePage.devices[0];
      if (!device) {
        throw new CliUsageError("device number is out of range");
      }
      const parameters = await application.inspectDeviceParameters({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        offset: 0,
        limit: 256,
      });
      io.write(
        command.json
          ? JSON.stringify(parameters)
          : [
              `Parameters for ${device.name}: ${parameters.total}`,
              ...parameters.parameters.map(
                (parameter) =>
                  `  ${parameter.index + 1}. ${parameter.name}: ${parameter.normalizedValue.toFixed(3)}${parameter.isQuantized ? " (quantized)" : ""}${parameter.isEnabled ? "" : " (disabled)"}`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "rack-chains") {
      const { track, device } = await resolveDevice(
        application,
        command.trackNumber,
        command.deviceNumber,
      );
      const chains = await application.inspectRackChains({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(chains)
          : [
              `Chains in ${device.name}: ${chains.total}`,
              ...chains.chains.map(
                (chain) =>
                  `  ${chain.index + 1}. ${chain.name || "(unnamed)"} (${chain.deviceCount} devices)`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "chain-devices") {
      const { track, device, chain } = await resolveRackChain(
        application,
        command.trackNumber,
        command.deviceNumber,
        command.chainNumber,
      );
      const devices = await application.inspectRackChainDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        chainIndex: chain.index,
        expectedChainReference: chain.reference,
        expectedChainName: chain.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(devices)
          : [
              `Devices in chain ${chain.name || command.chainNumber}: ${devices.total}`,
              ...devices.devices.map(
                (nestedDevice) =>
                  `  ${nestedDevice.index + 1}. ${nestedDevice.name} (${nestedDevice.parameterCount} parameters)`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "drum-pads") {
      const { track, device } = await resolveDevice(
        application,
        command.trackNumber,
        command.deviceNumber,
      );
      const pads = await application.inspectDrumRackPads({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(pads)
          : [
              `Pads in ${device.name}: ${pads.total}`,
              ...pads.pads.map(
                (pad) =>
                  `  ${pad.index + 1}. note ${pad.note} ${pad.name || "(unnamed)"} (${pad.chainCount} chains)`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "pad-chains") {
      const { track, device, pad } = await resolveDrumPad(
        application,
        command.trackNumber,
        command.deviceNumber,
        command.padNumber,
      );
      const chains = await application.inspectDrumPadChains({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        padIndex: pad.index,
        expectedPadReference: pad.reference,
        expectedPadNote: pad.note,
        expectedPadName: pad.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(chains)
          : [
              `Chains for pad ${pad.note} ${pad.name || "(unnamed)"}: ${chains.total}`,
              ...chains.chains.map(
                (chain) =>
                  `  ${chain.index + 1}. ${chain.name || "(unnamed)"} (${chain.deviceCount} devices)`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    if (command.name === "pad-chain-devices") {
      const { track, device, pad, chain } = await resolveDrumPadChain(
        application,
        command.trackNumber,
        command.deviceNumber,
        command.padNumber,
        command.chainNumber,
      );
      const devices = await application.inspectDrumPadChainDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        padIndex: pad.index,
        expectedPadReference: pad.reference,
        expectedPadNote: pad.note,
        expectedPadName: pad.name,
        chainIndex: chain.index,
        expectedChainReference: chain.reference,
        expectedChainName: chain.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(devices)
          : [
              `Devices in pad chain ${chain.name || command.chainNumber}: ${devices.total}`,
              ...devices.devices.map(
                (nestedDevice) =>
                  `  ${nestedDevice.index + 1}. ${nestedDevice.name} (${nestedDevice.parameterCount} parameters)`,
              ),
            ].join("\n"),
      );
      return 0;
    }

    const response = await application.send(command.prompt);
    const ok = operationFailures.length === 0;
    io.write(
      command.json
        ? JSON.stringify({ ok, response, operationFailures })
        : response,
    );
    return ok ? 0 : 4;
  } finally {
    unsubscribe();
    await application.stop();
  }

  async function resolveTrack(
    application: HeadlessApplication,
    trackNumber: number,
  ) {
    const snapshot = await application.inspectSession();
    const track = snapshot.tracks[trackNumber - 1];
    if (!track) {
      throw new CliUsageError("track number is out of range");
    }
    return track;
  }

  async function resolveDevice(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
  ) {
    const track = await resolveTrack(application, trackNumber);
    const page = await application.inspectDevices({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      offset: deviceNumber - 1,
      limit: 1,
    });
    const device = page.devices[0];
    if (!device) {
      throw new CliUsageError("device number is out of range");
    }
    return { track, device };
  }

  async function resolveRackChain(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
    chainNumber: number,
  ) {
    const { track, device } = await resolveDevice(
      application,
      trackNumber,
      deviceNumber,
    );
    const page = await application.inspectRackChains({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      offset: chainNumber - 1,
      limit: 1,
    });
    const chain = page.chains[0];
    if (!chain) {
      throw new CliUsageError("chain number is out of range");
    }
    return { track, device, chain };
  }

  async function resolveDrumPad(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
    padNumber: number,
  ) {
    const { track, device } = await resolveDevice(
      application,
      trackNumber,
      deviceNumber,
    );
    const page = await application.inspectDrumRackPads({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      offset: padNumber - 1,
      limit: 1,
    });
    const pad = page.pads[0];
    if (!pad) {
      throw new CliUsageError("pad number is out of range");
    }
    return { track, device, pad };
  }

  async function resolveDrumPadChain(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
    padNumber: number,
    chainNumber: number,
  ) {
    const { track, device, pad } = await resolveDrumPad(
      application,
      trackNumber,
      deviceNumber,
      padNumber,
    );
    const page = await application.inspectDrumPadChains({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      padIndex: pad.index,
      expectedPadReference: pad.reference,
      expectedPadNote: pad.note,
      expectedPadName: pad.name,
      offset: chainNumber - 1,
      limit: 1,
    });
    const chain = page.chains[0];
    if (!chain) {
      throw new CliUsageError("chain number is out of range");
    }
    return { track, device, pad, chain };
  }
}

export async function runInteractive(
  application: HeadlessApplication,
  io: CliIo,
  input: InteractiveInput,
): Promise<number> {
  let turnProducedOutput = false;
  const unsubscribe = application.subscribe((event) => {
    if (event.type === "agent.message_delta") {
      turnProducedOutput = true;
      io.writeRaw(event.content);
    } else if (event.type === "agent.message_complete") {
      if (turnProducedOutput) {
        io.writeRaw("\n");
      } else {
        io.write(event.content);
      }
      turnProducedOutput = true;
    } else if (
      event.type === "operation.started" ||
      event.type === "operation.completed" ||
      event.type === "operation.failed"
    ) {
      const rendered = renderEvent(event);
      if (rendered) {
        io.write(rendered);
      }
    }
  });

  try {
    await application.start({ startAgent: true });
    io.write("Ableton Agent chat. Type /help for commands.");
    while (true) {
      io.writeRaw("> ");
      const next = await input.readLine();
      if (next === undefined) {
        io.writeRaw("\n");
        return 0;
      }
      const line = next.trim();
      if (!line) {
        continue;
      }
      if (line === "/exit") {
        return 0;
      }
      if (line === "/help") {
        io.write(
          [
            "/help      Show commands",
            "/status    Show connection status",
            "/doctor    Ping the Remote Script",
            "/snapshot  Inspect the current Live set",
            "/transport Inspect Arrangement loop and cue points",
            "/exit      End the chat session",
          ].join("\n"),
        );
        continue;
      }

      try {
        if (line === "/status") {
          const status = await application.getStatus();
          io.write(`Ableton: ${status.state}`);
          continue;
        }
        if (line === "/doctor") {
          const ping = await application.ping();
          io.write(`Ping: ${ping.pong ? "ok" : "failed"}`);
          continue;
        }
        if (line === "/snapshot") {
          const snapshot = await application.inspectSession();
          io.write(
            `Snapshot: ${snapshot.trackCount} tracks at ${snapshot.tempo} BPM`,
          );
          continue;
        }
        if (line === "/transport") {
          const transport = await application.inspectArrangementTransport({
            offset: 0,
            limit: 100,
          });
          io.write(
            `Transport: loop ${transport.loop.enabled ? "enabled" : "disabled"}, ${transport.totalCuePoints} cue points`,
          );
          continue;
        }
        if (line.startsWith("/")) {
          io.writeError(`Unknown command: ${line}`);
          continue;
        }

        turnProducedOutput = false;
        const response = await application.send(line);
        if (!turnProducedOutput) {
          io.write(response);
        }
      } catch (error) {
        io.writeError(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    unsubscribe();
    if (application.state !== "stopped") {
      await application.stop();
    }
  }
}
