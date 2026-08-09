import type { HeadlessApplication } from "@ableton-agent/application";
import type { AppEvent } from "@ableton-agent/shared";

export type CliCommand =
  | { name: "chat"; json: false }
  | { name: "status"; json: boolean }
  | { name: "doctor"; json: boolean }
  | { name: "capabilities"; json: boolean }
  | { name: "snapshot"; json: boolean }
  | { name: "transport"; json: boolean }
  | { name: "devices"; trackNumber: number; json: boolean }
  | {
      name: "parameters";
      trackNumber: number;
      deviceNumber: number;
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
    command === "transport"
  ) {
    if (positional.length !== 1) {
      throw new CliUsageError(
        `${command} does not accept positional arguments`,
      );
    }
    return { name: command, json };
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
        "  ableton-agent devices <track-number> [--json]",
        "  ableton-agent parameters <track-number> <device-number> [--json]",
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
