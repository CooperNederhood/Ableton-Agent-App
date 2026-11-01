import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LocalObservabilityJournal,
  sanitizeTelemetryAttributes,
  telemetryIdSchema,
} from "@ableton-agent/observability";
import { PRODUCT_VERSIONS } from "@ableton-agent/shared";
import {
  ensureLiveAgentStorage,
  loadProfileRegistry,
  resolveLiveAgentStorage,
} from "@ableton-agent/storage";

import {
  inspectAbletonIntegrations,
  installAbletonIntegrations,
  type IntegrationComponent,
} from "./ableton-integrations-install.js";
import {
  createIntegrationTelemetry,
  type IntegrationTrace,
} from "./ableton-integrations-observability.js";
import {
  detectRemoteScriptLocations,
  normalizeManualRemoteScriptsPath,
} from "./remote-script-install.js";
import { JsonPreferencesStore } from "./desktop-service.js";

export interface IntegrationArguments {
  readonly command: "detect" | "install" | "update";
  readonly confirmed: boolean;
  readonly dryRun: boolean;
  readonly userLibrary?: string;
  readonly profile?: string;
  readonly resources?: string;
  readonly payload?: string;
  readonly remoteScriptSource?: string;
  readonly components?: readonly IntegrationComponent[];
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

const valueFlags = new Map([
  ["--user-library", "userLibrary"],
  ["--profile", "profile"],
  ["--resources", "resources"],
  ["--payload", "payload"],
  ["--remote-script-source", "remoteScriptSource"],
  ["--trace-id", "traceId"],
  ["--correlation-id", "correlationId"],
  ["--causation-id", "causationId"],
] as const);

function isComponent(value: string): value is IntegrationComponent {
  return ["remote-script", "machine-listening", "midi-capture"].includes(value);
}

function validIdentity(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u.test(value);
}

export class IntegrationHistoryError extends AggregateError {
  public constructor(
    errors: readonly unknown[],
    public readonly components: unknown,
  ) {
    super(
      errors,
      "Integration history could not be persisted; inspect component outcomes before retrying",
    );
    this.name = "IntegrationHistoryError";
  }
}

export function integrationFailureResult(error: unknown, cancelled: boolean) {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  const messages: string[] = [];
  for (let count = 0; pending.length > 0 && count < 32; count += 1) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (typeof current === "string") messages.push(current);
    if (current === null || typeof current !== "object") continue;
    if ("message" in current && typeof current.message === "string")
      messages.push(current.message);
    if ("cause" in current) pending.push(current.cause);
    for (const nested of [
      "failures" in current ? current.failures : undefined,
      "errors" in current ? current.errors : undefined,
    ]) {
      if (Array.isArray(nested)) {
        const values: readonly unknown[] = nested;
        pending.push(...values.slice(0, 8));
      }
    }
  }
  const [message, ...details] = [...new Set(messages)].slice(0, 8);
  return sanitizeTelemetryAttributes({
    status: cancelled ? "cancelled" : "failed",
    message: message ?? "Integration installation failed",
    ...(details.length === 0 ? {} : { details }),
    ...(error !== null && typeof error === "object" && "components" in error
      ? { components: error.components }
      : {}),
  });
}

export function parseIntegrationArguments(
  argv: readonly string[],
): IntegrationArguments {
  const args = argv.filter((value) => value !== "--");
  const command = args[0] ?? "detect";
  if (command !== "detect" && command !== "install" && command !== "update")
    throw new Error("Use integrations detect, install, or update");
  if (args.length > 40) throw new Error("Too many integration options");
  const values: Partial<
    Record<
      | "userLibrary"
      | "profile"
      | "resources"
      | "payload"
      | "remoteScriptSource"
      | "traceId"
      | "correlationId"
      | "causationId",
      string
    >
  > = {};
  let confirmed = false;
  let dryRun = false;
  let components: IntegrationComponent[] | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) throw new Error("Missing integration option");
    if (seen.has(flag)) throw new Error("Repeated integration option");
    seen.add(flag);
    if (flag === "--confirm") {
      confirmed = true;
      continue;
    }
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--components") {
      const selected = args[++index]?.split(",");
      if (
        selected === undefined ||
        selected.length === 0 ||
        !selected.every(isComponent) ||
        new Set(selected).size !== selected.length
      )
        throw new Error("Select distinct supported integration components");
      components = selected;
      continue;
    }
    const entry = [...valueFlags].find(([name]) => name === flag);
    if (entry === undefined) throw new Error("Unknown integration option");
    const value = args[++index];
    if (
      value === undefined ||
      value.length === 0 ||
      value.length > 4096 ||
      value.startsWith("--") ||
      value.includes("\0")
    )
      throw new Error(`A bounded value is required for ${entry[0]}`);
    if (entry[1].endsWith("Id") && !validIdentity(value))
      throw new Error("Invalid integration trace identity");
    if (entry[1] === "traceId" && !telemetryIdSchema.safeParse(value).success)
      throw new Error("Integration trace identity must be a UUID");
    values[entry[1]] = value;
  }
  return {
    command,
    confirmed,
    dryRun,
    ...values,
    ...(components === undefined ? {} : { components }),
  };
}

export async function resolveIntegrationStorage(options: {
  readonly profile?: string;
  readonly homeDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const base = resolveLiveAgentStorage(options);
  if (
    options.profile !== undefined ||
    options.environment?.LIVE_AGENT_PROFILE?.trim()
  )
    return base;
  const registry = await loadProfileRegistry(base, undefined, {
    readOnly: true,
  });
  return resolveLiveAgentStorage({
    ...options,
    profile: registry.selectedProfile,
  });
}

export async function resolveIntegrationLibrary(options: {
  readonly userLibrary?: string;
  readonly configuredRemoteScriptLocation?: string;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): Promise<string> {
  const pathApi =
    (options.platform ?? process.platform) === "win32" ? win32 : posix;
  if (options.userLibrary !== undefined)
    return pathApi.resolve(options.userLibrary);
  const locations = await detectRemoteScriptLocations(options);
  const explicit = locations.find(({ source }) => source === "environment");
  if (explicit !== undefined) {
    if (!explicit.available)
      throw new Error("Configured Ableton User Library does not exist");
    return pathApi.dirname(explicit.path);
  }
  const configured = options.configuredRemoteScriptLocation?.trim();
  if (configured && configured.toLowerCase() !== "auto-detect") {
    const scriptsPath = normalizeManualRemoteScriptsPath(
      configured,
      options.platform,
    );
    if (
      !pathApi.isAbsolute(scriptsPath) ||
      pathApi.basename(scriptsPath).toLowerCase() !== "remote scripts"
    )
      throw new Error(
        "Configured Remote Script location is not a User Library or Remote Scripts directory; provide --user-library",
      );
    return pathApi.dirname(scriptsPath);
  }
  const available = locations.filter(({ available }) => available);
  const location = available[0];
  if (location === undefined || available.length !== 1)
    throw new Error(
      available.length === 0
        ? "No Ableton User Library found; provide --user-library"
        : "Multiple Ableton User Libraries found; select --user-library explicitly",
    );
  return pathApi.dirname(location.path);
}

export function integrationSourcePaths(options: {
  readonly resources?: string;
  readonly payload?: string;
  readonly remoteScriptSource?: string;
  readonly runtimeResourcesPath?: string;
}) {
  const resources = options.resources ?? options.runtimeResourcesPath;
  return {
    payloadDirectory: resolve(
      options.payload ??
        (resources === undefined
          ? fileURLToPath(
              new URL("../../build/ableton-integrations", import.meta.url),
            )
          : join(resources, "ableton-integrations")),
    ),
    remoteScriptSourcePath: resolve(
      options.remoteScriptSource ??
        (resources === undefined
          ? fileURLToPath(
              new URL(
                "../../../../remote-script/AbletonAgent",
                import.meta.url,
              ),
            )
          : join(resources, "remote-script", "AbletonAgent")),
    ),
  };
}

export async function runIntegrationCommand(
  argv: readonly string[],
  context: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly homeDirectory?: string;
    readonly runtimeResourcesPath?: string;
    readonly signal?: AbortSignal;
  } = {},
) {
  const options = parseIntegrationArguments(argv);
  if (options.command !== "detect" && !options.dryRun && !options.confirmed)
    throw new Error("Integration changes require explicit --confirm");
  const environment = context.environment ?? process.env;
  const homeDirectory = context.homeDirectory ?? homedir();
  const storage = await resolveIntegrationStorage({
    ...options,
    environment,
    homeDirectory,
  });
  const configuredRemoteScriptLocation =
    options.userLibrary === undefined &&
    !environment.ABLETON_USER_LIBRARY?.trim()
      ? (await new JsonPreferencesStore(storage.preferencesPath).load())
          .remoteScriptLocation
      : undefined;
  const userLibraryPath = await resolveIntegrationLibrary({
    ...options,
    environment,
    homeDirectory,
    ...(configuredRemoteScriptLocation === undefined
      ? {}
      : { configuredRemoteScriptLocation }),
  });
  const sources = integrationSourcePaths({
    ...options,
    ...(context.runtimeResourcesPath === undefined
      ? {}
      : { runtimeResourcesPath: context.runtimeResourcesPath }),
  });
  const input = {
    ...sources,
    userLibraryPath,
    storage,
    remoteScriptVersion: PRODUCT_VERSIONS.remoteScript,
    confirmed: options.confirmed,
    dryRun: options.dryRun,
    ...(options.components === undefined
      ? {}
      : { components: options.components }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
  if (options.command === "detect")
    return {
      profile: storage.profile,
      userLibraryPath,
      ...(await inspectAbletonIntegrations(input)),
    };
  if (options.dryRun)
    return {
      profile: storage.profile,
      userLibraryPath,
      ...(await installAbletonIntegrations(input)),
    };

  const traceId = options.traceId ?? randomUUID();
  const trace: IntegrationTrace = {
    traceId,
    correlationId: options.correlationId ?? traceId,
    causationId: options.causationId ?? traceId,
  };
  await ensureLiveAgentStorage(storage);
  const journal = await LocalObservabilityJournal.open({
    path: storage.eventJournalPath,
  });
  const failures: unknown[] = [];
  const onEvent = createIntegrationTelemetry({
    sink: journal,
    trace,
    profile: storage.profile,
    onFailure: (error) => failures.push(error),
  });
  let outcome:
    | {
        readonly ok: true;
        readonly result: Awaited<ReturnType<typeof installAbletonIntegrations>>;
      }
    | { readonly ok: false; readonly error: unknown };
  try {
    outcome = {
      ok: true,
      result: await installAbletonIntegrations({ ...input, onEvent }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  await new Promise<void>((done) => setImmediate(done));
  try {
    await journal.shutdown();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new IntegrationHistoryError(
      [...(outcome.ok ? [] : [outcome.error]), ...failures],
      outcome.ok
        ? outcome.result.components
        : outcome.error !== null &&
            typeof outcome.error === "object" &&
            "components" in outcome.error
          ? outcome.error.components
          : undefined,
    );
  if (!outcome.ok) throw outcome.error;
  return {
    profile: storage.profile,
    userLibraryPath,
    traceId,
    ...outcome.result,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      new DOMException("Integration installation cancelled", "AbortError"),
    );
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const runtimeResourcesPath = (
      process as NodeJS.Process & { readonly resourcesPath?: string }
    ).resourcesPath;
    const result = await runIntegrationCommand(process.argv.slice(2), {
      runtimeResourcesPath,
      signal: controller.signal,
    });
    console.log(JSON.stringify(sanitizeTelemetryAttributes(result)));
  } catch (error) {
    console.error(
      JSON.stringify(
        integrationFailureResult(error, controller.signal.aborted),
      ),
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
