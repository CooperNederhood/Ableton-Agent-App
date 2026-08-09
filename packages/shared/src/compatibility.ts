import { PRODUCT_VERSIONS } from "./product-versions.generated.js";

export type CompatibilityResult =
  | { compatible: true }
  | {
      compatible: false;
      reason:
        "protocol-incompatible" | "remote-script-outdated" | "live-unsupported";
      message: string;
    };

function numericVersion(value: string): readonly number[] | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(left: string, right: string): number | undefined {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  if (leftParts === undefined || rightParts === undefined) return undefined;
  for (let index = 0; index < 3; index++) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function checkProductCompatibility(input: {
  readonly liveVersion: string;
  readonly protocolVersion: number;
  readonly remoteScriptVersion: string;
}): CompatibilityResult {
  if (input.protocolVersion !== PRODUCT_VERSIONS.protocol) {
    return {
      compatible: false,
      reason: "protocol-incompatible",
      message: `Remote Script protocol ${input.protocolVersion} is incompatible with protocol ${PRODUCT_VERSIONS.protocol}.`,
    };
  }
  const remoteComparison = compareVersions(
    input.remoteScriptVersion,
    PRODUCT_VERSIONS.minimumRemoteScript,
  );
  if (remoteComparison === undefined || remoteComparison < 0) {
    return {
      compatible: false,
      reason: "remote-script-outdated",
      message: `Remote Script ${input.remoteScriptVersion} must be updated to ${PRODUCT_VERSIONS.minimumRemoteScript} or newer.`,
    };
  }
  const parsedLive = numericVersion(input.liveVersion);
  const minimum =
    parsedLive === undefined
      ? undefined
      : PRODUCT_VERSIONS.supportedLive[
          String(parsedLive[0]) as keyof typeof PRODUCT_VERSIONS.supportedLive
        ];
  if (
    minimum === undefined ||
    compareVersions(input.liveVersion, minimum)! < 0
  ) {
    return {
      compatible: false,
      reason: "live-unsupported",
      message: `Ableton Live ${input.liveVersion} is not in the supported version matrix.`,
    };
  }
  return { compatible: true };
}
