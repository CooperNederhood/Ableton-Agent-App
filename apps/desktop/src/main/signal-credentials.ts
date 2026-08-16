import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const signalDirectory = join(homedir(), ".ableton-agent");
export const signalDescriptorPath = join(
  signalDirectory,
  "signal-ingress.json",
);
export const signalSecretPath = join(signalDirectory, "signal-ingress.secret");

export async function writeSignalSecret(
  secret: string,
  paths: {
    readonly directory: string;
    readonly secretPath: string;
  } = { directory: signalDirectory, secretPath: signalSecretPath },
): Promise<() => Promise<void>> {
  if (secret.length < 32) {
    throw new Error("Signal ingress secret must be at least 32 characters");
  }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const temporaryPath = `${paths.secretPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${secret}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, paths.secretPath);
  await chmod(paths.secretPath, 0o600);
  return async () => {
    try {
      if ((await readFile(paths.secretPath, "utf8")) === `${secret}\n`) {
        await rm(paths.secretPath);
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  };
}
