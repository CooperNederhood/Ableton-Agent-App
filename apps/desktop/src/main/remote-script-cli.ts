import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_VERSIONS } from "@ableton-agent/shared";

import {
  detectRemoteScriptLocations,
  inspectRemoteScriptInstallation,
  installRemoteScript,
  normalizeManualRemoteScriptsPath,
} from "./remote-script-install.js";

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const command = process.argv[2] ?? "detect";
const resourcesPath = (
  process as NodeJS.Process & { readonly resourcesPath?: string }
).resourcesPath;
const defaultSource =
  resourcesPath === undefined
    ? fileURLToPath(
        new URL("../../../../remote-script/AbletonAgent", import.meta.url),
      )
    : join(resourcesPath, "remote-script", "AbletonAgent");
const locations = await detectRemoteScriptLocations({
  homeDirectory: homedir(),
});

if (command === "detect") {
  for (const location of locations) {
    const inspection = await inspectRemoteScriptInstallation(
      location.path,
      PRODUCT_VERSIONS.remoteScript,
    );
    console.log(
      JSON.stringify({ ...location, installation: inspection.state }),
    );
  }
} else if (command === "install" || command === "update") {
  if (!process.argv.includes("--confirm")) {
    throw new Error(
      "Remote Script changes require explicit confirmation via --confirm",
    );
  }
  const requestedPath = valueAfter("--path");
  const automaticallyDetected = locations.find(({ available }) => available);
  const target =
    requestedPath === undefined
      ? automaticallyDetected?.path
      : normalizeManualRemoteScriptsPath(requestedPath);
  if (target === undefined) {
    throw new Error(
      "No supported User Library was detected; provide --path <Remote Scripts directory>",
    );
  }
  const source = resolve(valueAfter("--source") ?? defaultSource);
  console.log(
    JSON.stringify(
      await installRemoteScript({
        sourcePath: source,
        remoteScriptsPath: target,
        version: PRODUCT_VERSIONS.remoteScript,
      }),
    ),
  );
} else {
  throw new Error(
    `Unknown command '${command}'; use detect, install, or update`,
  );
}
