import { join } from "node:path";

export function resolvePackagedCopilotRuntimePath(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): string {
  const runtimePlatform = `${platform}-${architecture}`;
  const executable =
    platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
  return join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@github",
    `copilot-sdk-${runtimePlatform}`,
    "prebuilds",
    runtimePlatform,
    executable,
  );
}
