import { join } from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

import type { DesktopAppEvent } from "../contracts.js";

export function shouldOpenDevelopmentTools(
  development: boolean,
  requested: string | undefined,
): boolean {
  return development && requested === "1";
}

export function createWindowOptions(
  preload: string,
  development: boolean,
  icon: string,
  alwaysOnTop: boolean,
): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 940,
    minWidth: 320,
    minHeight: 360,
    show: false,
    title: "Ableton Agent",
    backgroundColor: "#101214",
    icon,
    alwaysOnTop,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: development,
    },
  };
}

interface PinnableWindow {
  setAlwaysOnTop(enabled: boolean): void;
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean },
  ): void;
}

export function applyAlwaysOnTop(
  window: PinnableWindow,
  enabled: boolean,
  platform = process.platform,
): void {
  window.setAlwaysOnTop(enabled);
  if (platform === "darwin") {
    window.setVisibleOnAllWorkspaces(enabled, {
      visibleOnFullScreen: enabled,
    });
  }
}

export function applyWindowPreferenceEvent(
  window: PinnableWindow,
  event: DesktopAppEvent,
  platform = process.platform,
): void {
  if (event.type === "preferences.changed") {
    applyAlwaysOnTop(window, event.preferences.alwaysOnTop, platform);
  }
}

export function resolveDesktopIconPath(
  packaged: boolean,
  resourcesPath: string,
  mainDirectory: string,
): string {
  return packaged
    ? join(resourcesPath, "icon.png")
    : join(mainDirectory, "../../build/icon.png");
}
