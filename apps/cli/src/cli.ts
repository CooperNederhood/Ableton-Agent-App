import type { HeadlessApplication } from "@ableton-agent/application";
import type { AppEvent } from "@ableton-agent/shared";

export type CliCommand =
  | { name: "status"; json: boolean }
  | { name: "doctor"; json: boolean }
  | { name: "capabilities"; json: boolean }
  | { name: "snapshot"; json: boolean }
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
  if (
    command === "status" ||
    command === "doctor" ||
    command === "capabilities" ||
    command === "snapshot"
  ) {
    if (positional.length !== 1) {
      throw new CliUsageError(
        `${command} does not accept positional arguments`,
      );
    }
    return { name: command, json };
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

export interface CliIo {
  write(text: string): void;
  writeError(text: string): void;
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
): Promise<number> {
  if (command.name === "help") {
    io.write(
      [
        "Ableton Agent",
        "",
        "Usage:",
        "  ableton-agent status [--json]",
        "  ableton-agent doctor [--json]",
        "  ableton-agent capabilities [--json]",
        "  ableton-agent snapshot [--json]",
        "  ableton-agent run <prompt> [--json]",
      ].join("\n"),
    );
    return 0;
  }

  await application.start({ startAgent: command.name === "run" });
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

    const response = await application.send(command.prompt);
    io.write(command.json ? JSON.stringify({ ok: true, response }) : response);
    return 0;
  } finally {
    await application.stop();
  }
}
