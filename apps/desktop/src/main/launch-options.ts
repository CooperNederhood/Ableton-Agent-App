import { isAbsolute, join } from "node:path";

export interface DesktopLaunchOptions {
  automation:
    | {
        profilePath: string;
        descriptorPath: string;
        agentDefinition?: string;
        yolo: boolean;
      }
    | undefined;
}

export function parseDesktopLaunchOptions(
  argv: readonly string[],
): DesktopLaunchOptions {
  const automationEnabled = argv.includes("--automation");
  const profilePath = valueAfter(argv, "--automation-profile");
  const descriptorPath = valueAfter(argv, "--automation-descriptor");
  const agentDefinition = valueAfter(argv, "--automation-agent");
  const yolo = argv.includes("--automation-yolo");
  const hasAutomationOption =
    profilePath !== undefined ||
    descriptorPath !== undefined ||
    agentDefinition !== undefined ||
    yolo;
  if (!automationEnabled) {
    if (hasAutomationOption) {
      throw new Error("Automation options require --automation");
    }
    return { automation: undefined };
  }
  if (profilePath === undefined || !isAbsolute(profilePath)) {
    throw new Error(
      "--automation-profile requires an absolute path in automation mode",
    );
  }
  if (
    agentDefinition !== undefined &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(agentDefinition)
  ) {
    throw new Error(
      "--automation-agent must be a lowercase agent definition name",
    );
  }
  if (yolo && agentDefinition === undefined) {
    throw new Error("--automation-yolo requires --automation-agent");
  }
  if (descriptorPath !== undefined && !isAbsolute(descriptorPath)) {
    throw new Error("--automation-descriptor must be an absolute path");
  }
  return {
    automation: {
      profilePath,
      descriptorPath:
        descriptorPath ?? join(profilePath, "automation-endpoint.json"),
      ...(agentDefinition === undefined ? {} : { agentDefinition }),
      yolo,
    },
  };
}

function valueAfter(
  argv: readonly string[],
  option: string,
): string | undefined {
  const indexes = argv.flatMap((value, index) =>
    value === option ? [index] : [],
  );
  if (indexes.length > 1)
    throw new Error(`${option} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}
