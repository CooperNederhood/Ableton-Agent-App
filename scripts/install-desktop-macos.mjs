import { spawnSync } from "node:child_process";
import { access, readFile, rename, rm } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseRoot = join(repositoryRoot, "release");
const applicationPath = "/Applications/Ableton Agent.app";

export function parseInstallArguments(argv) {
  const options = {
    checks: true,
    launch: true,
    remoteScript: true,
  };
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument === "--skip-checks") options.checks = false;
    else if (argument === "--no-launch") options.launch = false;
    else if (argument === "--skip-remote-script") options.remoteScript = false;
    else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

export function desktopProcesses(processTable) {
  return processTable
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.includes("/Ableton Agent.app/Contents/MacOS/Ableton Agent") &&
        !line.includes("--type="),
    );
}

export function liveProcesses(processTable) {
  return processTable
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /\/Ableton Live 11[^/]*\.app\/Contents\/MacOS\/Live$/u.test(line),
    );
}

export function hostPackageDirectory(hostArchitecture = arch()) {
  if (hostArchitecture === "arm64") return "mac-arm64";
  if (hostArchitecture === "x64") return "mac";
  throw new Error(`Unsupported macOS architecture: ${hostArchitecture}`);
}

function run(command, args, options = {}) {
  process.stdout.write(`\n> ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stderr || result.stdout}`.trimEnd()
      : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`,
    );
  }
  return result.stdout ?? "";
}

function processTable() {
  return run("ps", ["-axo", "pid=,command="], { capture: true });
}

function assertProcessesStopped({ remoteScript }) {
  const table = processTable();
  const desktop = desktopProcesses(table);
  if (desktop.length > 0) {
    throw new Error(
      `Quit every Ableton Agent copy before installing:\n${desktop.join("\n")}`,
    );
  }
  if (!remoteScript) return;
  const live = liveProcesses(table);
  if (live.length > 0) {
    throw new Error(
      `Fully quit Ableton Live before updating the Remote Script:\n${live.join("\n")}`,
    );
  }
}

async function verifyRepository() {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  if (manifest.name !== "ableton-agent-app") {
    throw new Error(`Unexpected repository root: ${repositoryRoot}`);
  }
}

async function packageHostApplication() {
  const hostArchitecture = arch();
  const architectureFlag = hostArchitecture === "arm64" ? "--arm64" : "--x64";
  hostPackageDirectory(hostArchitecture);
  run("pnpm", [
    "--filter",
    "@ableton-agent/desktop",
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.yml",
    "--publish",
    "never",
    "--mac",
    "dir",
    architectureFlag,
  ]);
  const packagedPath = join(
    releaseRoot,
    hostPackageDirectory(hostArchitecture),
    "Ableton Agent.app",
  );
  await access(packagedPath);
  return packagedPath;
}

async function installApplication(packagedPath) {
  const stagingPath = `/Applications/.Ableton Agent.app.install-${process.pid}`;
  const previousPath = `/Applications/.Ableton Agent.app.previous-${process.pid}`;
  await rm(stagingPath, { recursive: true, force: true });
  await rm(previousPath, { recursive: true, force: true });
  run("ditto", [packagedPath, stagingPath]);
  run("codesign", ["--force", "--deep", "--sign", "-", stagingPath]);
  run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    stagingPath,
  ]);

  let previousMoved = false;
  try {
    try {
      await access(applicationPath);
      await rename(applicationPath, previousPath);
      previousMoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagingPath, applicationPath);
    run("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      applicationPath,
    ]);
    await rm(previousPath, { recursive: true, force: true });
  } catch (error) {
    await rm(applicationPath, { recursive: true, force: true });
    if (previousMoved) await rename(previousPath, applicationPath);
    throw error;
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

async function verifyLaunch() {
  run("open", ["-n", applicationPath]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    const exactProcess = processTable()
      .split("\n")
      .some((line) =>
        line.trim().endsWith(`${applicationPath}/Contents/MacOS/Ableton Agent`),
      );
    if (exactProcess) return;
  }
  throw new Error(
    `The installed application did not start from ${applicationPath}`,
  );
}

export async function installDesktopMacos(
  options = parseInstallArguments(process.argv.slice(2)),
) {
  if (platform() !== "darwin") {
    throw new Error("desktop:install:mac is supported only on macOS");
  }
  await verifyRepository();
  assertProcessesStopped(options);
  await rm(releaseRoot, { recursive: true, force: true });
  run("pnpm", ["clean"]);
  run("pnpm", ["install", "--frozen-lockfile"]);
  if (options.checks) {
    run("pnpm", ["check"]);
    run("pnpm", ["exec", "playwright", "test", "--project=electron"]);
  } else {
    run("pnpm", ["build"]);
  }
  const packagedPath = await packageHostApplication();
  run("pnpm", [
    "exec",
    "playwright",
    "test",
    "--project=electron-packaged",
    "--grep",
    "launches the generated production application",
  ]);
  if (options.remoteScript) {
    run("pnpm", [
      "--filter",
      "@ableton-agent/desktop",
      "remote-script",
      "update",
      "--confirm",
    ]);
  }
  await installApplication(packagedPath);
  if (options.launch) await verifyLaunch();
  process.stdout.write(
    `\nInstalled the verified ${arch()} application at ${applicationPath}.\n` +
      (options.remoteScript
        ? "The Remote Script was updated; start Ableton Live to load it.\n"
        : ""),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installDesktopMacos().catch((error) => {
    process.stderr.write(
      `\nDesktop installation failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
