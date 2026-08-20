import {
  createAgentRuntime,
  RuntimeConfigurationError,
  TOKEN_ENVIRONMENT_VARIABLE,
  type AgentRuntime,
} from "@ableton-agent/runtime";
import type { Logger } from "@ableton-agent/shared";
import {
  abletonToolMetadata,
  type ToolApprovalRequest,
} from "@ableton-agent/tools";

import { preferencesSchema, type DesktopPreferences } from "../contracts.js";
import { AgentCatalogService } from "./agent-catalog.js";
import { ApprovalCoordinator, ApprovalPolicyController } from "./approvals.js";
import { JsonPreferencesStore, JsonSessionStore } from "./desktop-service.js";
import { HeadlessDesktopService } from "./headless-desktop-service.js";

export interface DesktopCompositionOptions {
  preferencesPath: string;
  sessionsPath: string;
  agentsDirectory: string;
  skillsDirectory: string;
  signalDescriptorPath?: string;
  /** Copilot session storage owned by the desktop app. */
  agentBaseDirectory: string;
  /** Token from OS-backed secure storage, when one has been provisioned. */
  storedToken?: string | undefined;
  environment?: Readonly<Partial<Record<string, string>>>;
  logger?: Logger;
  onError?: (message: string, context: Record<string, unknown>) => void;
  onLoggingLevelChange?: (level: DesktopPreferences["loggingLevel"]) => void;
}

export interface DesktopComposition {
  service: HeadlessDesktopService;
  runtime: AgentRuntime;
  preferences: DesktopPreferences;
}

const missingTokenDetail =
  "No Remote Script token is configured. Store one in the desktop credential vault or set ABLETON_AGENT_TOKEN, then restart.";

async function loadPreferences(
  store: JsonPreferencesStore,
  notices: Notice[],
): Promise<DesktopPreferences> {
  try {
    return await store.load();
  } catch (error) {
    notices.push({
      label: "Preferences",
      status: "warn",
      detail: `Stored preferences could not be read (${error instanceof Error ? error.message : String(error)}); defaults are in use.`,
    });
    return preferencesSchema.parse({});
  }
}

interface Notice {
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/**
 * Composes the Electron main process on the same headless application the CLI
 * uses. Bridge port, model, and reasoning come from persisted preferences; the
 * bridge token comes from OS-backed storage or the environment.
 */
export async function createDesktopComposition(
  options: DesktopCompositionOptions,
): Promise<DesktopComposition> {
  const environment = options.environment ?? {};
  const preferencesStore = new JsonPreferencesStore(options.preferencesPath);
  const sessionStore = new JsonSessionStore(options.sessionsPath);
  const agentCatalog = new AgentCatalogService({
    agentsDirectory: options.agentsDirectory,
    skillsDirectory: options.skillsDirectory,
    availableTools: abletonToolMetadata.map((tool) => tool.name),
  });
  const notices: Notice[] = [];
  const preferences = await loadPreferences(preferencesStore, notices);
  const token =
    options.storedToken ?? environment[TOKEN_ENVIRONMENT_VARIABLE] ?? undefined;
  const approvals = new ApprovalCoordinator();
  const approvalPolicy = new ApprovalPolicyController(
    preferences.approvalPolicy,
    approvals,
  );
  // Preferences already constrain the port to a valid TCP range.
  const port = preferences.abletonPort;

  const runtimeOptions = {
    ableton: {
      port,
      unconfiguredMessage: missingTokenDetail,
      ...(token === undefined || token === "" ? {} : { token }),
    },
    agent: {
      // "auto" means "do not override the Copilot runtime default".
      ...(preferences.model === "auto" ? {} : { model: preferences.model }),
      ...(preferences.reasoning === "auto"
        ? {}
        : { reasoningEffort: preferences.reasoning }),
      baseDirectory: options.agentBaseDirectory,
    },
    requestToolApproval: (request: ToolApprovalRequest) =>
      approvalPolicy.request(request),
    askForReadApproval: approvalPolicy.askForReads,
    signal: {
      port: preferences.signalPort,
      ...(options.signalDescriptorPath === undefined
        ? {}
        : { descriptorPath: options.signalDescriptorPath }),
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
  let runtime: AgentRuntime;
  try {
    runtime = createAgentRuntime(runtimeOptions);
  } catch (error) {
    if (!(error instanceof RuntimeConfigurationError)) throw error;
    notices.push({
      label: "Bridge credentials",
      status: "fail",
      detail: `${error.message} Running without a bridge connection.`,
    });
    runtime = createAgentRuntime({
      ...runtimeOptions,
      ableton: {
        port,
        unconfiguredMessage: `${error.message} ${missingTokenDetail}`,
      },
    });
  }
  if (
    !runtime.abletonConfigured &&
    !notices.some((notice) => notice.label === "Bridge credentials")
  ) {
    notices.push({
      label: "Bridge credentials",
      status: "warn",
      detail: missingTokenDetail,
    });
  }

  const service = new HeadlessDesktopService({
    application: runtime.application,
    approvals,
    preferencesStore,
    sessionStore,
    agentCatalog,
    signals: runtime.signals,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    startupNotices: notices,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onLoggingLevelChange === undefined
      ? {}
      : { onLoggingLevelChange: options.onLoggingLevelChange }),
    onApprovalPolicyChange: (policy) => approvalPolicy.setPolicy(policy),
    onAutoApprovedAgentIdsChange: (ids) =>
      approvalPolicy.setAutoApprovedAgentInstanceIds(ids),
  });
  return { service, runtime, preferences };
}
