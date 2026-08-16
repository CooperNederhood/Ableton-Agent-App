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
): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    title: "Ableton Agent",
    backgroundColor: "#101214",
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
