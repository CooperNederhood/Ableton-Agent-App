import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  type WebContents,
} from "electron";

import {
  createDesktopComposition,
  type DesktopComposition,
} from "./composition.js";
import { forwardEvent, registerIpc } from "./ipc.js";
import { DesktopFileLogger } from "./logger.js";
import {
  parseDeepLink,
  startDesktopLifecycle,
  stopDesktopLifecycle,
} from "./lifecycle.js";
import { OsCredentialVault } from "./secure-store.js";
import { createWindowOptions } from "./window-options.js";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: BrowserWindow | undefined;
let shuttingDown = false;
let rendererRestartAttempts = 0;
const maximumRendererRestarts = 3;
const pendingDeepLinks: string[] = [];
let lifecycleStarted = false;

const logger = new DesktopFileLogger(
  join(
    app.getPath("logs"),
    app.isPackaged ? "desktop.log" : "desktop-development.log",
  ),
);
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
  const window = new BrowserWindow(
    createWindowOptions(
      join(currentDirectory, "../preload/index.cjs"),
      !app.isPackaged,
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
  await logger.write("info", "Desktop startup", { packaged: app.isPackaged });
  composition = await createDesktopComposition({
    preferencesPath: join(app.getPath("userData"), "preferences.json"),
    sessionsPath: join(app.getPath("userData"), "sessions.json"),
    agentBaseDirectory: join(app.getPath("userData"), "copilot"),
    storedToken: await readStoredToken(),
    environment: process.env,
    logger: {
      debug: (message, context) => void logger.write("debug", message, context),
      info: (message, context) => void logger.write("info", message, context),
      warn: (message, context) => void logger.write("warn", message, context),
      error: (message, context) => void logger.write("error", message, context),
    },
    onError: (message, context) => void logger.write("error", message, context),
  });
  const unregisterIpc = registerIpc(
    ipcMain,
    composition.service,
    (event) =>
      mainWindow !== undefined &&
      event.sender.id === mainWindow.webContents.id &&
      event.senderFrame === event.sender.mainFrame,
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
    }).finally(() => {
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
  await logger.write("error", "Desktop bootstrap failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  app.exit(1);
});
