import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveLiveAgentStorage } from "../../packages/storage/src/index.js";
import { preferencesSchema } from "../../apps/desktop/src/contracts.js";

const operatingSystemKeys = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "SystemRoot",
  "WINDIR",
  "__CF_USER_TEXT_ENCODING",
] as const;
const fixtureOverrideKeys = new Set([
  "ABLETON_AGENT_TOKEN",
  "ABLETON_AGENT_PORT",
]);

/** Only OS launch settings and explicit synthetic fixtures may enter the child. */
export function createDesktopTestEnvironment(
  options: {
    profile: string;
    bridgePort: number;
    automation?: boolean;
    overrides?: Readonly<Record<string, string>>;
  },
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
): Record<string, string> {
  const location = relative(process.cwd(), options.profile);
  if (
    !isAbsolute(options.profile) ||
    location === "" ||
    location === ".." ||
    location.startsWith(`..${sep}`) ||
    isAbsolute(location)
  )
    throw new Error(
      "Electron fixture profiles must be owned directories below the workspace",
    );
  const overrides = options.overrides ?? {};
  if (Object.keys(overrides).some((key) => !fixtureOverrideKeys.has(key)))
    throw new Error(
      "Only explicit synthetic bridge credentials and ports may override Electron fixtures",
    );
  const port =
    overrides.ABLETON_AGENT_PORT === undefined
      ? options.bridgePort
      : Number(overrides.ABLETON_AGENT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Electron fixtures require an explicit owned bridge port");
  const environment: Record<string, string> = {};
  for (const key of operatingSystemKeys) {
    const value = inherited[key];
    if (value !== undefined) environment[key] = value;
  }

  return {
    ...environment,
    HOME: join(options.profile, "home"),
    USERPROFILE: join(options.profile, "home"),
    XDG_CONFIG_HOME: join(options.profile, "home", ".config"),
    XDG_CACHE_HOME: join(options.profile, "home", ".cache"),
    XDG_DATA_HOME: join(options.profile, "home", ".local", "share"),
    TMPDIR: join(options.profile, "runtime-temp"),
    TMP: join(options.profile, "runtime-temp"),
    TEMP: join(options.profile, "runtime-temp"),
    LIVE_AGENT_HOME: join(options.profile, "live-agent"),
    LIVE_AGENT_PROFILE: options.automation === true ? "automation" : "default",
    ABLETON_AGENT_PORT: String(port),
    ABLETON_AGENT_TOKEN:
      overrides.ABLETON_AGENT_TOKEN ??
      "synthetic-electron-rejecting-bridge-only",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    NODE_ENV: "test",
  };
}

export function createDesktopTestPreferences(
  environment: Readonly<Record<string, string>>,
  signalPort: number,
) {
  return preferencesSchema.parse({
    abletonPort: Number(environment.ABLETON_AGENT_PORT),
    signalPort,
  });
}

export async function writeDesktopTestPreferences(
  environment: Readonly<Record<string, string>>,
  signalPort: number,
) {
  const storage = resolveLiveAgentStorage({
    environment,
    ...(environment.HOME === undefined
      ? {}
      : { homeDirectory: environment.HOME }),
  });
  const location = relative(process.cwd(), storage.preferencesPath);
  if (
    isAbsolute(location) ||
    location === ".." ||
    location.startsWith(`..${sep}`)
  )
    throw new Error(
      "Electron fixture preferences must remain below the workspace",
    );
  await mkdir(dirname(storage.preferencesPath), { recursive: true });
  await writeFile(
    storage.preferencesPath,
    JSON.stringify(createDesktopTestPreferences(environment, signalPort)),
    { mode: 0o600 },
  );
  return storage;
}
