import type { DesktopApi } from "../contracts.js";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};
