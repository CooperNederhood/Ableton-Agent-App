import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import {
  sanitizeTelemetryAttributes,
  type NonBlockingObservabilityRecorder,
  type TelemetryEventEnvelope,
  type TraceContext,
} from "@ableton-agent/observability";
import { TOKEN_ENVIRONMENT_VARIABLE } from "@ableton-agent/runtime";

import {
  detectRemoteScriptLocations,
  normalizeManualRemoteScriptsPath,
  remoteScriptTokenPath,
} from "./remote-script-install.js";

export const bridgeTokenKey = "ableton-bridge-token";
const maximumTokenBytes = 4 * 1024;
const minimumTokenLength = 32;

export interface BridgeCredentialVault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface BridgeCredentialNotice {
  readonly status: "pass" | "warn" | "fail";
  readonly detail: string;
}

export interface BridgeCredentialResolution {
  readonly token?: string;
  readonly source?: "vault" | "environment" | "remote-script";
  readonly notices: readonly BridgeCredentialNotice[];
  readonly traceId: string;
}

interface TokenReadResult {
  readonly status: "missing" | "invalid" | "unreadable" | "valid";
  readonly token?: string;
}

export interface ResolveBridgeCredentialOptions {
  readonly storedToken?: string;
  readonly vault?: BridgeCredentialVault;
  readonly environment?: Readonly<Partial<Record<string, string>>>;
  readonly remoteScriptLocation?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly now?: () => Date;
}

function usableToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token !== undefined && token.length >= minimumTokenLength
    ? token
    : undefined;
}

function record(
  telemetry: Pick<NonBlockingObservabilityRecorder, "enqueue"> | undefined,
  input: {
    readonly name: string;
    readonly trace: TraceContext;
    readonly occurredAt: string;
    readonly level?: TelemetryEventEnvelope["level"];
    readonly outcome?: TelemetryEventEnvelope["outcome"];
    readonly durationMs?: number;
    readonly attributes?: Readonly<Record<string, unknown>>;
  },
): void {
  if (telemetry === undefined) return;
  try {
    telemetry.enqueue({
      version: 2,
      id: randomUUID(),
      occurredAt: input.occurredAt,
      name: input.name,
      source: "desktop",
      level: input.level ?? "info",
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: Math.max(0, input.durationMs) }),
      correlationId: input.trace.traceId,
      trace: input.trace,
      attributes: sanitizeTelemetryAttributes(input.attributes ?? {}),
    });
  } catch {
    // Credential provisioning must not fail because instrumentation is unavailable.
  }
}

async function readInstalledToken(path: string): Promise<TokenReadResult> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maximumTokenBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > maximumTokenBytes) return { status: "invalid" };
    const token = usableToken(buffer.subarray(0, bytesRead).toString("utf8"));
    return token === undefined
      ? { status: "invalid" }
      : { status: "valid", token };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable" };
  } finally {
    await handle?.close();
  }
}

function explicitTokenPath(
  location: string,
  platform: NodeJS.Platform,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = normalizeManualRemoteScriptsPath(location, platform);
  return pathApi.basename(normalized).toLowerCase() === "abletonagent"
    ? pathApi.join(normalized, ".ableton-agent-token")
    : remoteScriptTokenPath(normalized, platform);
}

async function candidateTokenPaths(
  options: ResolveBridgeCredentialOptions,
): Promise<string[]> {
  const location = options.remoteScriptLocation?.trim();
  const platform = options.platform ?? process.platform;
  if (
    location !== undefined &&
    location !== "" &&
    location.toLowerCase() !== "auto-detect"
  ) {
    return [explicitTokenPath(location, platform)];
  }
  const environmentLibrary = options.environment?.ABLETON_USER_LIBRARY?.trim();
  if (environmentLibrary !== undefined && environmentLibrary !== "") {
    const pathApi = platform === "win32" ? win32 : posix;
    return [
      remoteScriptTokenPath(
        pathApi.join(pathApi.normalize(environmentLibrary), "Remote Scripts"),
        platform,
      ),
    ];
  }
  if (options.homeDirectory === undefined && options.vault === undefined) {
    return [];
  }
  const locations = await detectRemoteScriptLocations({
    platform,
    homeDirectory: options.homeDirectory ?? homedir(),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
  });
  return locations.map(({ path }) => remoteScriptTokenPath(path, platform));
}

export async function resolveBridgeCredential(
  options: ResolveBridgeCredentialOptions,
): Promise<BridgeCredentialResolution> {
  const telemetry =
    options.vault === undefined && options.homeDirectory === undefined
      ? undefined
      : options.telemetry;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const traceId = randomUUID();
  const rootTrace: TraceContext = { traceId, spanId: traceId };
  record(telemetry, {
    name: "desktop.bridge_credentials.queued",
    trace: rootTrace,
    occurredAt: startedAt.toISOString(),
    attributes: {},
  });
  const startedTrace: TraceContext = {
    traceId,
    spanId: randomUUID(),
    parentSpanId: rootTrace.spanId,
  };
  record(telemetry, {
    name: "desktop.bridge_credentials.started",
    trace: startedTrace,
    occurredAt: now().toISOString(),
    attributes: {},
  });

  const notices: BridgeCredentialNotice[] = [];
  const complete = (
    result: Omit<BridgeCredentialResolution, "notices" | "traceId">,
    outcome: "success" | "failure",
    attributes: Readonly<Record<string, unknown>>,
  ): BridgeCredentialResolution => {
    const completedAt = now();
    record(telemetry, {
      name:
        outcome === "success"
          ? "desktop.bridge_credentials.completed"
          : "desktop.bridge_credentials.failed",
      trace: {
        traceId,
        spanId: randomUUID(),
        parentSpanId: startedTrace.spanId,
      },
      occurredAt: completedAt.toISOString(),
      outcome,
      level: outcome === "failure" ? "warn" : "info",
      durationMs: completedAt.getTime() - startedAt.getTime(),
      attributes,
    });
    return {
      ...result,
      notices:
        outcome === "success"
          ? notices.map((notice) =>
              notice.status === "fail"
                ? { ...notice, status: "warn" as const }
                : notice,
            )
          : notices,
      traceId,
    };
  };

  let storedToken = usableToken(options.storedToken);
  if (options.storedToken !== undefined && storedToken === undefined) {
    notices.push({
      status: "fail",
      detail:
        "The stored Remote Script token is invalid; attempting another configured credential source.",
    });
  }
  if (storedToken === undefined && options.vault !== undefined) {
    try {
      const vaultValue = await options.vault.get(bridgeTokenKey);
      storedToken = usableToken(vaultValue);
      if (vaultValue !== undefined && storedToken === undefined) {
        notices.push({
          status: "fail",
          detail:
            "The Remote Script token in the desktop credential vault is invalid; attempting another configured credential source.",
        });
      }
    } catch {
      notices.push({
        status: "fail",
        detail:
          "The desktop credential vault could not be read; attempting another configured credential source.",
      });
    }
  }
  if (storedToken !== undefined) {
    return complete({ token: storedToken, source: "vault" }, "success", {
      source: "vault",
      candidateCount: 0,
    });
  }

  const environmentValue =
    options.environment?.[TOKEN_ENVIRONMENT_VARIABLE] ?? undefined;
  const environmentToken = usableToken(environmentValue);
  if (environmentValue !== undefined && environmentToken === undefined) {
    notices.push({
      status: "fail",
      detail: `${TOKEN_ENVIRONMENT_VARIABLE} is present but is shorter than ${minimumTokenLength} characters; attempting installed Remote Script discovery.`,
    });
  }
  if (environmentToken !== undefined) {
    return complete(
      { token: environmentToken, source: "environment" },
      "success",
      { source: "environment", candidateCount: 0 },
    );
  }

  let paths: string[];
  try {
    paths = await candidateTokenPaths(options);
  } catch {
    notices.push({
      status: "fail",
      detail:
        "Remote Script locations could not be resolved. Select the installed Remote Scripts directory in Settings.",
    });
    return complete({}, "failure", {
      source: "none",
      candidateCount: 0,
      failureCategory: "location-resolution",
    });
  }

  const reads = await Promise.all(
    paths.map((path) => readInstalledToken(path)),
  );
  const validTokens = reads.flatMap((result) =>
    result.status === "valid" && result.token !== undefined
      ? [result.token]
      : [],
  );
  const uniqueTokens = [...new Set(validTokens)];
  const invalidCount = reads.filter(
    ({ status }) => status === "invalid",
  ).length;
  const unreadableCount = reads.filter(
    ({ status }) => status === "unreadable",
  ).length;

  if (uniqueTokens.length > 1) {
    notices.push({
      status: "fail",
      detail:
        "Multiple Remote Script installations contain different tokens. Select the intended Remote Script location in Settings, then restart.",
    });
    return complete({}, "failure", {
      source: "none",
      candidateCount: paths.length,
      validCandidateCount: validTokens.length,
      failureCategory: "conflicting-tokens",
    });
  }

  const discoveredToken = uniqueTokens[0];
  if (discoveredToken === undefined) {
    const detail =
      invalidCount > 0 || unreadableCount > 0
        ? "The detected Remote Script token is invalid or unreadable. Reinstall the Remote Script, restart Ableton Live, then restart the desktop app."
        : "No Remote Script token was found. Install the Remote Script, restart Ableton Live, then restart the desktop app.";
    notices.push({
      status: invalidCount > 0 || unreadableCount > 0 ? "fail" : "warn",
      detail,
    });
    return complete({}, "failure", {
      source: "none",
      candidateCount: paths.length,
      invalidCandidateCount: invalidCount,
      unreadableCandidateCount: unreadableCount,
      failureCategory:
        invalidCount > 0 || unreadableCount > 0
          ? "invalid-or-unreadable"
          : "missing",
    });
  }

  if (options.vault !== undefined) {
    try {
      await options.vault.set(bridgeTokenKey, discoveredToken);
      notices.push({
        status: "pass",
        detail:
          "The installed Remote Script token was discovered and stored in the desktop credential vault.",
      });
    } catch {
      notices.push({
        status: "warn",
        detail:
          "The installed Remote Script token was found and will be used now, but it could not be saved to the desktop credential vault.",
      });
    }
  }
  return complete(
    { token: discoveredToken, source: "remote-script" },
    "success",
    {
      source: "remote-script",
      candidateCount: paths.length,
      validCandidateCount: validTokens.length,
      persisted: notices.some(({ status }) => status === "pass"),
    },
  );
}
