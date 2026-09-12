import { join } from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

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
): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    title: "Ableton Agent",
    backgroundColor: "#101214",
    icon,
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

export function resolveDesktopIconPath(
  packaged: boolean,
  resourcesPath: string,
  mainDirectory: string,
): string {
  return packaged
    ? join(resourcesPath, "icon.png")
    : join(mainDirectory, "../../build/icon.png");
}
