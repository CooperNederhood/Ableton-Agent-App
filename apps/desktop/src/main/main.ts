import { join } from "node:path";
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
import { forwardEvent, registerIpc } from "./ipc.js";
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
  createWindowOptions,
  shouldOpenDevelopmentTools,
} from "./window-options.js";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: BrowserWindow | undefined;
let shuttingDown = false;
let rendererRestartAttempts = 0;
const maximumRendererRestarts = 3;
const pendingDeepLinks: string[] = [];
let lifecycleStarted = false;
let removeSignalSecret: (() => Promise<void>) | undefined;

const logPath = join(
  app.getPath("logs"),
  app.isPackaged ? "desktop.log" : "desktop-development.log",
);
const environmentLoggingLevel = parseLogLevel(
  process.env.ABLETON_AGENT_LOG_LEVEL,
);
const logger = new DesktopFileLogger(
  logPath,
  environmentLoggingLevel ?? "info",
);
let activeLoggingLevel: DesktopPreferences["loggingLevel"] =
  environmentLoggingLevel ?? "info";
// Constructed here so any application-managed credential remains outside
// preferences and encrypted through Electron's OS-backed safeStorage.
export const credentialVault = new OsCredentialVault(
  join(app.getPath("userData"), "credentials"),
  safeStorage,
);
/** Key holding the Remote Script shared secret in the OS-backed vault. */
const bridgeTokenKey = "ableton-bridge-token";

async function readStoredToken(): Promise<string | undefined> {
  try {
    return await credentialVault.get(bridgeTokenKey);
  } catch (error) {
    await logger.write("warn", "Stored bridge token could not be read", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

// Composed after `app.whenReady()` because preferences and credentials come
// from Electron-managed paths; every handler below runs after that point.
function requireService(): DesktopComposition["service"] {
  if (composition === undefined)
    throw new Error("Desktop composition is not initialized");
  return composition.service;
}

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
  const window = new BrowserWindow(
    createWindowOptions(
      join(currentDirectory, "../preload/index.cjs"),
      development,
    ),
  );
  mainWindow = window;
  secureWebContents(window.webContents);
  const unsubscribeEvents = requireService().subscribe((event) => {
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

async function bootstrap(): Promise<void> {
  await logger.prune();
  await app.whenReady();
  app.setAsDefaultProtocolClient("ableton-agent");
  if (!app.isPackaged)
    console.info(`Desktop development log (${activeLoggingLevel}): ${logPath}`);
  await logger.write("info", "Desktop startup", {
    packaged: app.isPackaged,
    loggingLevel: activeLoggingLevel,
    environmentOverride: environmentLoggingLevel !== undefined,
  });
  const storedToken = await readStoredToken();
  const signalSecret = storedToken ?? process.env.ABLETON_AGENT_TOKEN;
  if (signalSecret !== undefined) {
    removeSignalSecret = await writeSignalSecret(signalSecret);
  }
  composition = await createDesktopComposition({
    preferencesPath: join(app.getPath("userData"), "preferences.json"),
    sessionsPath: join(app.getPath("userData"), "sessions.json"),
    agentBaseDirectory: join(app.getPath("userData"), "copilot"),
    signalDescriptorPath,
    storedToken,
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
  activeLoggingLevel =
    environmentLoggingLevel ?? composition.preferences.loggingLevel;
  logger.setLevel(activeLoggingLevel);
  const diagnostics = createDesktopDiagnosticsActions({
    logPath,
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
  const unregisterIpc = registerIpc(
    ipcMain,
    composition.service,
    diagnostics,
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
      stopServices: () => requireService().stop(),
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
    startServices: () => requireService().start(),
    stopServices: () => requireService().stop(),
    quit: () => app.quit(),
  });
  lifecycleStarted = true;
  await resumeDeepLink(process.argv);
  for (const url of pendingDeepLinks.splice(0)) {
    await resumeDeepLink([url]);
  }
}

void bootstrap().catch(async (error: unknown) => {
  await removeSignalSecret?.().catch(() => undefined);
  await logger.write("error", "Desktop bootstrap failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  app.exit(1);
});
