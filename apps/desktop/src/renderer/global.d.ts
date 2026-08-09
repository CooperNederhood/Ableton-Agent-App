import type { DesktopApi } from "../contracts";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};
