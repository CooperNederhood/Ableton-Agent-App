import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type WebContents,
} from "electron";

import type { DesktopPreferences } from "../contracts.js";
import {
  createDesktopComposition,
  type DesktopComposition,
} from "./composition.js";
import { createDesktopDiagnosticsActions } from "./diagnostics-actions.js";
import { forwardEvent, registerIpc, type DiagnosticsActions } from "./ipc.js";
import { DesktopFileLogger, parseLogLevel } from "./logger.js";
import {
  parseDeepLink,
  startDesktopLifecycle,
  stopDesktopLifecycle,
} from "./lifecycle.js";
import { OsCredentialVault } from "./secure-store.js";
import {
  signalDescriptorPath,
  writeSignalSecret,
} from "./signal-credentials.js";
import {
  ensureLiveAgentStorage,
  loadProfileRegistry,
  migrateLegacyStorage,
  resolveLiveAgentStorage,
  type LegacyStorageEntry,
  type StorageMigrationResult,
} from "@ableton-agent/storage";
import {
  applyAlwaysOnTop,
  applyWindowPreferenceEvent,
  createWindowOptions,
  resolveDesktopIconPath,
  shouldOpenDevelopmentTools,
} from "./window-options.js";
import {
  applyAutomationStartup,
  createDesktopAutomationServer,
} from "./automation-host.js";
import { resolvePackagedCopilotRuntimePath } from "./copilot-runtime.js";
import { parseDesktopLaunchOptions } from "./launch-options.js";
import type { AutomationControlServer } from "@ableton-agent/debug-control";
import { DesktopProfileManager } from "./profile-manager.js";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const launchOptions = parseDesktopLaunchOptions(process.argv);
if (launchOptions.automation !== undefined) {
  const normalUserDataPath = app.getPath("userData");
  if (
    resolve(launchOptions.automation.profilePath) ===
    resolve(normalUserDataPath)
  ) {
    throw new Error(
      "Automation profile must be separate from the normal desktop profile",
    );
  }
  app.setPath("userData", launchOptions.automation.profilePath);
  app.setPath(
    "sessionData",
    join(launchOptions.automation.profilePath, "session"),
  );
  app.setPath("logs", join(launchOptions.automation.profilePath, "logs"));
}
const desktopIconPath = resolveDesktopIconPath(
  app.isPackaged,
  process.resourcesPath,
  currentDirectory,
);
let mainWindow: BrowserWindow | undefined;
let shuttingDown = false;
let rendererRestartAttempts = 0;
const maximumRendererRestarts = 3;
const pendingDeepLinks: string[] = [];
let lifecycleStarted = false;
let removeSignalSecret: (() => Promise<void>) | undefined;
let automationServer: AutomationControlServer | undefined;

async function clearSignalSecret(): Promise<void> {
  const remove = removeSignalSecret;
  removeSignalSecret = undefined;
  await remove?.();
}

const legacyUserDataDirectory = app.getPath("userData");
const legacyLogsDirectory = app.getPath("logs");
const storageEnvironment =
  launchOptions.automation === undefined
    ? process.env
    : {
        ...process.env,
        LIVE_AGENT_HOME: join(
          launchOptions.automation.profilePath,
          "live-agent",
        ),
        LIVE_AGENT_PROFILE: "automation",
      };
const explicitProfile =
  process.env.LIVE_AGENT_PROFILE?.trim() === ""
    ? undefined
    : process.env.LIVE_AGENT_PROFILE?.trim();
let storage = resolveLiveAgentStorage({
  homeDirectory: homedir(),
  environment: storageEnvironment,
  development: !app.isPackaged,
});
const bundledAgentsDirectory = app.isPackaged
  ? join(process.resourcesPath, "agents")
  : fileURLToPath(new URL("../../../../agents", import.meta.url));
const bundledSkillsDirectory = app.isPackaged
  ? join(process.resourcesPath, "skills")
  : fileURLToPath(new URL("../../../../skills", import.meta.url));
let logPath = join(
  legacyLogsDirectory,
  app.isPackaged ? "desktop.log" : "desktop-development.log",
);
const environmentLoggingLevel = parseLogLevel(
  process.env.ABLETON_AGENT_LOG_LEVEL,
);
let logger = new DesktopFileLogger(logPath, environmentLoggingLevel ?? "info");
let activeLoggingLevel: DesktopPreferences["loggingLevel"] =
  environmentLoggingLevel ?? "info";
// Constructed here so any application-managed credential remains outside
// preferences and encrypted through Electron's OS-backed safeStorage.
export let credentialVault = new OsCredentialVault(
  storage.credentialsDirectory,
  safeStorage,
);
let diagnostics: DiagnosticsActions | undefined;
// Composed after `app.whenReady()` because preferences and credentials come
// from Electron-managed paths; every handler below runs after that point.
function requireService(): DesktopComposition["service"] {
  if (composition === undefined)
    throw new Error("Desktop composition is not initialized");
  return composition.service;
}

function requireDiagnostics(): DiagnosticsActions {
  if (diagnostics === undefined)
    throw new Error("Desktop diagnostics are not initialized");
  return diagnostics;
}

const serviceProxy = new Proxy({} as DesktopComposition["service"], {
  get: (_target, property): unknown => {
    const service = requireService();
    const member: unknown = Reflect.get(service, property);
    return typeof member === "function" ? member.bind(service) : member;
  },
});

const diagnosticsProxy = new Proxy({} as DiagnosticsActions, {
  get: (_target, property): unknown => {
    const actions = requireDiagnostics();
    const member: unknown = Reflect.get(actions, property);
    return typeof member === "function" ? member.bind(actions) : member;
  },
});

function secureWebContents(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    const current = webContents.getURL();
    if (current && url !== current) event.preventDefault();
  });
}

async function resumeDeepLink(argv: readonly string[]): Promise<void> {
  const sessionId = parseDeepLink(argv);
  if (sessionId === undefined) return;
  try {
    await requireService().resumeSession(sessionId);
  } catch (error) {
    await logger.write("warn", "Deep-link session could not be resumed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createWindow(): Promise<void> {
  const development =
    !app.isPackaged && process.env.VITE_DEV_SERVER_URL !== undefined;
  const preferences = await requireService().getPreferences();
  const window = new BrowserWindow(
    createWindowOptions(
      join(currentDirectory, "../preload/index.cjs"),
      development,
      desktopIconPath,
      preferences.alwaysOnTop,
    ),
  );
  mainWindow = window;
  applyAlwaysOnTop(window, preferences.alwaysOnTop);
  secureWebContents(window.webContents);
  const unsubscribeEvents = requireService().subscribe((event) => {
    applyWindowPreferenceEvent(window, event);
    forwardEvent(window.webContents, event);
  });
  window.once("ready-to-show", () => window.show());
  window.on("unresponsive", () => {
    window.webContents.send("app:event", {
      type: "diagnostic",
      level: "error",
      message:
        "The renderer became unresponsive. Your session is still managed by the main process.",
    });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    void logger.write("error", "Renderer process exited", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (shuttingDown) return;
    if (mainWindow === window) mainWindow = undefined;
    unsubscribeEvents();
    if (!window.isDestroyed()) window.destroy();
    rendererRestartAttempts++;
    if (rendererRestartAttempts > maximumRendererRestarts) {
      void logger.write(
        "error",
        "Renderer restart limit reached; automatic recovery stopped",
        { attempts: rendererRestartAttempts },
      );
      return;
    }
    const delay = 400 * rendererRestartAttempts;
    setTimeout(() => {
      void createWindow()
        .then(() => {
          mainWindow?.webContents.send("app:event", {
            type: "lifecycle.changed",
            state: "crashed",
          });
          setTimeout(
            () =>
              mainWindow?.webContents.send("app:event", {
                type: "lifecycle.changed",
                state: "degraded",
              }),
            1200,
          );
        })
        .catch((error: unknown) =>
          logger.write("error", "Renderer recovery failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }, delay);
  });
  window.on("closed", () => {
    unsubscribeEvents();
    if (mainWindow === window) mainWindow = undefined;
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl && !app.isPackaged) {
    const url = new URL(developmentUrl);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error("Development renderer must be local");
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(join(currentDirectory, "../renderer/index.html"));
  }
  if (
    shouldOpenDevelopmentTools(
      development,
      process.env.ABLETON_AGENT_OPEN_DEVTOOLS,
    )
  ) {
    window.webContents.openDevTools({ mode: "detach" });
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (lifecycleStarted) {
    void resumeDeepLink([url]);
  } else {
    pendingDeepLinks.push(url);
  }
});

let composition: DesktopComposition | undefined;

async function composeProfile(
  layout: typeof storage,
  migration?: StorageMigrationResult,
): Promise<DesktopComposition> {
  credentialVault = new OsCredentialVault(
    layout.credentialsDirectory,
    safeStorage,
  );
  const next = await createDesktopComposition({
    preferencesPath: layout.preferencesPath,
    sessionsPath: layout.sessionsPath,
    projectSessionsPath: layout.projectSessionsPath,
    agentsDirectory: bundledAgentsDirectory,
    skillsDirectory: bundledSkillsDirectory,
    storage: layout,
    agentBaseDirectory: layout.copilotDirectory,
    sessionStateDirectory: layout.sessionStateDirectory,
    eventJournalPath: layout.eventJournalPath,
    ...(migration === undefined
      ? {}
      : { storageMigrationEvents: migration.events }),
    signalDescriptorPath,
    credentialVault,
    homeDirectory: homedir(),
    platform: process.platform,
    environment: process.env,
    logger: {
      debug: (message, context) => void logger.write("debug", message, context),
      info: (message, context) => void logger.write("info", message, context),
      warn: (message, context) => void logger.write("warn", message, context),
      error: (message, context) => void logger.write("error", message, context),
    },
    onError: (message, context) => void logger.write("error", message, context),
    onLoggingLevelChange: (level) => {
      activeLoggingLevel = environmentLoggingLevel ?? level;
      logger.setLevel(activeLoggingLevel);
    },
  });
  if (next.bridgeToken !== undefined) {
    removeSignalSecret = await writeSignalSecret(next.bridgeToken);
  }
  activeLoggingLevel = environmentLoggingLevel ?? next.preferences.loggingLevel;
  logger.setLevel(activeLoggingLevel);
  return next;
}

function createDiagnostics(
  layout: typeof storage,
  migrationStatus: StorageMigrationResult["status"],
): DiagnosticsActions {
  return createDesktopDiagnosticsActions({
    logPath: layout.desktopLogPath,
    storage: {
      version: layout.version,
      root: layout.root,
      profile: layout.profile,
      profileRoot: layout.profileRoot,
      migrationStatus,
    },
    getLoggingLevel: () => activeLoggingLevel,
    environmentOverride: environmentLoggingLevel !== undefined,
    appVersion: app.getVersion(),
    platform: process.platform,
    chooseExportPath: async () => {
      const options = {
        title: "Export support bundle",
        defaultPath: `ableton-agent-support-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const result =
        mainWindow === undefined
          ? await dialog.showSaveDialog(options)
          : await dialog.showSaveDialog(mainWindow, options);
      return result.canceled ? undefined : result.filePath;
    },
    revealItem: (path) => shell.showItemInFolder(path),
    writeClipboard: (text) => clipboard.writeText(text),
  });
}

async function bootstrap(): Promise<void> {
  if (app.isPackaged && (process.env.COPILOT_CLI_PATH?.trim() ?? "") === "") {
    const runtimePath = resolvePackagedCopilotRuntimePath(
      process.resourcesPath,
    );
    await access(runtimePath);
    process.env.COPILOT_CLI_PATH = runtimePath;
  }
  const legacyLogName = app.isPackaged
    ? "desktop.log"
    : "desktop-development.log";
  const desktopCopilotDirectory = join(legacyUserDataDirectory, "copilot");
  const fallbackCopilotDirectory = join(homedir(), ".ableton-agent", "copilot");
  let legacyCopilotDirectory = desktopCopilotDirectory;
  try {
    await access(desktopCopilotDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    legacyCopilotDirectory = fallbackCopilotDirectory;
  }
  const migrationEntries: LegacyStorageEntry[] = [
    {
      label: "preferences",
      source: join(legacyUserDataDirectory, "preferences.json"),
      destination: storage.preferencesPath,
      kind: "json",
    },
    {
      label: "sessions",
      source: join(legacyUserDataDirectory, "sessions.json"),
      destination: storage.sessionsPath,
      kind: "json",
    },
    {
      label: "project-sessions",
      source: join(legacyUserDataDirectory, "project-sessions.json"),
      destination: storage.projectSessionsPath,
      kind: "json",
    },
    {
      label: "credentials",
      source: join(legacyUserDataDirectory, "credentials"),
      destination: storage.credentialsDirectory,
      kind: "directory",
    },
    {
      label: "copilot",
      source: legacyCopilotDirectory,
      destination: storage.copilotDirectory,
      kind: "directory",
    },
    {
      label: "event-history",
      source: join(legacyUserDataDirectory, "event-history.sqlite"),
      destination: storage.eventJournalPath,
      kind: "sqlite",
    },
    {
      label: "desktop-log",
      source: join(legacyLogsDirectory, legacyLogName),
      destination: storage.desktopLogPath,
      kind: "file",
    },
  ];
  const migration: StorageMigrationResult = await migrateLegacyStorage({
    layout: storage,
    entries: migrationEntries,
  });
  if (migration.status === "failed") {
    throw new Error(
      `Local storage migration failed without modifying legacy data: ${migration.error ?? "unknown error"}`,
    );
  }
  if (
    app.isPackaged &&
    launchOptions.automation === undefined &&
    explicitProfile === undefined
  ) {
    const registry = await loadProfileRegistry(storage);
    storage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: storage.root },
      profile: registry.selectedProfile,
    });
  }
  await ensureLiveAgentStorage(storage);
  logPath = storage.desktopLogPath;
  logger = new DesktopFileLogger(logPath, environmentLoggingLevel ?? "info");
  await logger.prune();
  await app.whenReady();
  app.dock?.setIcon(desktopIconPath);
  app.setAsDefaultProtocolClient("ableton-agent");
  if (!app.isPackaged)
    console.info(`Desktop development log (${activeLoggingLevel}): ${logPath}`);
  await logger.write("info", "Desktop startup", {
    packaged: app.isPackaged,
    loggingLevel: activeLoggingLevel,
    environmentOverride: environmentLoggingLevel !== undefined,
    storageProfile: storage.profile,
    storageMigrationStatus: migration.status,
  });
  for (const event of migration.events) {
    await logger.write(
      event.outcome === "failure" ? "error" : "info",
      event.name,
      event.attributes,
    );
  }
  composition = await composeProfile(storage, migration);
  diagnostics = createDiagnostics(storage, migration.status);

  const switchDesktopProfile = async (profile: string): Promise<void> => {
    const previousStorage = storage;
    const previousComposition = requireService();
    await previousComposition.stop();
    await clearSignalSecret();
    const nextStorage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: previousStorage.root },
      profile,
    });
    let nextComposition: DesktopComposition | undefined;
    try {
      await ensureLiveAgentStorage(nextStorage);
      logPath = nextStorage.desktopLogPath;
      logger = new DesktopFileLogger(
        logPath,
        environmentLoggingLevel ?? "info",
      );
      await logger.prune();
      nextComposition = await composeProfile(nextStorage);
      await nextComposition.service.start();
      storage = nextStorage;
      composition = nextComposition;
      diagnostics = createDiagnostics(storage, "not-needed");
      setTimeout(() => {
        const window = mainWindow;
        if (window !== undefined && !window.isDestroyed()) window.close();
        void createWindow();
      }, 50);
    } catch (error) {
      await nextComposition?.service.stop().catch(() => undefined);
      await clearSignalSecret().catch(() => undefined);
      storage = previousStorage;
      logPath = previousStorage.desktopLogPath;
      logger = new DesktopFileLogger(
        logPath,
        environmentLoggingLevel ?? "info",
      );
      const restored = await composeProfile(previousStorage);
      await restored.service.start();
      composition = restored;
      diagnostics = createDiagnostics(previousStorage, "not-needed");
      throw error;
    }
  };
  const profileManager = new DesktopProfileManager({
    rootLayout: storage,
    bundledAgentsDirectory,
    bundledSkillsDirectory,
    ...((explicitProfile ??
      (!app.isPackaged
        ? "development"
        : launchOptions.automation === undefined
          ? undefined
          : "automation")) === undefined
      ? {}
      : {
          environmentProfileOverride:
            explicitProfile ?? (!app.isPackaged ? "development" : "automation"),
        }),
    getActiveProfile: () => storage.profile,
    getActiveSessionId: async () =>
      (await requireService().listOutputs()).activeSessionId,
    refreshActiveCatalog: async () => {
      await requireService().refreshAgentCatalog();
    },
    switchProfile: switchDesktopProfile,
    telemetry: (event) => composition?.telemetry.enqueue(event),
  });
  const unregisterIpc = registerIpc(
    ipcMain,
    serviceProxy,
    diagnosticsProxy,
    (event) =>
      mainWindow !== undefined &&
      event.sender.id === mainWindow.webContents.id &&
      event.senderFrame === event.sender.mainFrame,
    {
      debug: (message, context) => void logger.write("debug", message, context),
      info: (message, context) => void logger.write("info", message, context),
      warn: (message, context) => void logger.write("warn", message, context),
      error: (message, context) => void logger.write("error", message, context),
    },
    profileManager,
  );
  app.on("activate", () => {
    if (!mainWindow) void createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void stopDesktopLifecycle({
      stopServices: async () => {
        await automationServer?.stop();
        automationServer = undefined;
        await requireService().stop();
      },
    }).finally(async () => {
      await removeSignalSecret?.().catch((error: unknown) =>
        logger.write("warn", "Signal ingress secret could not be removed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      void logger.write("info", "Desktop shutdown");
      unregisterIpc();
      app.exit(0);
    });
  });
  await startDesktopLifecycle({
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    onSecondInstance: (handler) =>
      app.on("second-instance", (_event, argv) => handler(argv)),
    handleDeepLink: (sessionId) => {
      void resumeDeepLink([`ableton-agent://session/${sessionId}`]);
    },
    createWindow,
    focusWindow: () => {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.focus();
    },
    startServices: async () => {
      await requireService().start();
      if (launchOptions.automation !== undefined) {
        await applyAutomationStartup(
          requireService(),
          launchOptions.automation,
        );
        automationServer = createDesktopAutomationServer({
          service: requireService(),
          launch: launchOptions.automation,
          telemetry: composition!.telemetry,
        });
        await automationServer.start();
        await logger.write("info", "Desktop automation endpoint started", {
          descriptorPath: launchOptions.automation.descriptorPath,
          agentDefinition: launchOptions.automation.agentDefinition,
          yolo: launchOptions.automation.yolo,
        });
      }
    },
    stopServices: async () => {
      await automationServer?.stop();
      automationServer = undefined;
      await requireService().stop();
    },
    quit: () => app.quit(),
  });
  lifecycleStarted = true;
  await resumeDeepLink(process.argv);
  for (const url of pendingDeepLinks.splice(0)) {
    await resumeDeepLink([url]);
  }
}

void bootstrap().catch(async (error: unknown) => {
  await automationServer?.stop().catch(() => undefined);
  await composition?.service.stop().catch(() => undefined);
  await removeSignalSecret?.().catch(() => undefined);
  await logger.write("error", "Desktop bootstrap failed", {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined
      ? { stack: error.stack }
      : {}),
  });
  app.exit(1);
});
