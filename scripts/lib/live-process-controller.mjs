import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearTimeout } from "node:timers";

const LIVE_EXECUTABLE_SUFFIX = ".app/Contents/MacOS/Live";

export async function listLiveProcesses() {
  const result = await runProcess("ps", ["-axo", "pid=,lstart=,command="], {
    timeoutMs: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect processes: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map(parseProcessLine)
    .filter(
      (process) =>
        process !== undefined &&
        process.command.includes(LIVE_EXECUTABLE_SUFFIX),
    );
}

function parseProcessLine(line) {
  const match = line.match(
    /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/,
  );
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    startedAt: match[2],
    command: match[3],
  };
}

export class LiveProcessController {
  #owned;
  #listProcesses;
  #run;
  #kill;
  #sleep;
  #randomUUID;
  #requestQuit;
  #handleStartupDialogs;

  constructor({
    listProcesses = listLiveProcesses,
    run = runProcess,
    kill = process.kill.bind(process),
    sleep = delay,
    randomUUID: createRunId = randomUUID,
    requestQuit = requestLiveQuit,
    handleStartupDialogs = dismissKnownLiveStartupDialogs,
  } = {}) {
    this.#listProcesses = listProcesses;
    this.#run = run;
    this.#kill = kill;
    this.#sleep = sleep;
    this.#randomUUID = createRunId;
    this.#requestQuit = requestQuit;
    this.#handleStartupDialogs = handleStartupDialogs;
  }

  publicRecord() {
    return this.#owned === undefined ? undefined : { ...this.#owned };
  }

  async assertNoPreExistingLive() {
    const existing = await this.#listProcesses();
    if (existing.length > 0) {
      throw new Error(
        `Ableton Live is already running (PID${existing.length === 1 ? "" : "s"} ${existing.map(({ pid }) => pid).join(", ")}). Close it before starting mutation smoke tests.`,
      );
    }
  }

  async launch(applicationPath, timeoutMs = 90_000) {
    if (this.#owned !== undefined) {
      throw new Error("This controller already owns a Live process");
    }
    await this.assertNoPreExistingLive();
    const before = new Set((await this.#listProcesses()).map(({ pid }) => pid));
    const launched = await this.#run("open", ["-n", "-a", applicationPath], {
      timeoutMs: 15_000,
    });
    if (launched.status !== 0) {
      throw new Error(`Unable to launch Live: ${launched.stderr.trim()}`);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidates = (await this.#listProcesses()).filter(
        ({ pid }) => !before.has(pid),
      );
      if (candidates.length === 1) {
        this.#owned = {
          ...candidates[0],
          applicationPath,
          runId: this.#randomUUID(),
          recordedAt: new Date().toISOString(),
        };
        return this.publicRecord();
      }
      if (candidates.length > 1) {
        throw new Error(
          "Live launch produced multiple candidate processes; ownership is ambiguous",
        );
      }
      await this.#sleep(500);
    }
    throw new Error("Timed out waiting for the runner-launched Live process");
  }

  async validateOwnership() {
    if (this.#owned === undefined) {
      throw new Error("No runner-owned Live process is recorded");
    }
    const current = (await this.#listProcesses()).find(
      ({ pid }) => pid === this.#owned.pid,
    );
    if (
      current === undefined ||
      current.startedAt !== this.#owned.startedAt ||
      current.command !== this.#owned.command
    ) {
      throw new Error(
        "Runner-owned Live process identity no longer matches; refusing process control",
      );
    }
    return current;
  }

  async dismissKnownStartupDialogs(options = {}) {
    await this.validateOwnership();
    return this.#handleStartupDialogs({
      ...options,
      launchedAt: this.#owned.recordedAt,
      pid: this.#owned.pid,
    });
  }

  async gracefulStop(timeoutMs = 20_000) {
    const owned = await this.validateOwnership();
    await this.#requestQuit(owned);
    if (!(await this.#waitForExit(owned.pid, timeoutMs))) {
      throw new Error(
        `Runner-owned Live PID ${owned.pid} did not exit gracefully; manual intervention is required`,
      );
    }
    this.#owned = undefined;
  }

  async discardAfterFailure(timeoutMs = 5_000) {
    const owned = await this.validateOwnership();
    try {
      await this.#requestQuit(owned);
    } catch {
      this.#kill(owned.pid, "SIGTERM");
    }
    if (!(await this.#waitForExit(owned.pid, timeoutMs))) {
      await this.validateOwnership();
      this.#kill(owned.pid, "SIGTERM");
    }
    if (!(await this.#waitForExit(owned.pid, timeoutMs))) {
      await this.validateOwnership();
      this.#kill(owned.pid, "SIGKILL");
      if (!(await this.#waitForExit(owned.pid, 5_000))) {
        throw new Error(
          `Unable to terminate runner-owned Live PID ${owned.pid}`,
        );
      }
    }
    this.#owned = undefined;
  }

  async #waitForExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        this.#kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        throw error;
      }
      await this.#sleep(250);
    }
    return false;
  }
}

async function requestLiveQuit() {
  const script = `
ignoring application responses
  tell application id "com.ableton.live" to quit
end ignoring
delay 1
try
  tell application "System Events"
    if exists process "Live" then
      tell process "Live"
        set handled to false
        repeat 20 times
          if exists sheet 1 of window 1 then
            if exists button "Don't Save" of sheet 1 of window 1 then
              click button "Don't Save" of sheet 1 of window 1
              set handled to true
              exit repeat
            end if
          else if exists button "Don't Save" of window 1 then
            click button "Don't Save" of window 1
            set handled to true
            exit repeat
          end if
          delay 0.1
        end repeat
        if not handled then
          set frontmost to true
          key code 48 using shift down
          key code 48 using shift down
          key code 49
        end if
      end tell
    end if
  end tell
end try
`;
  const result = await runProcess("osascript", ["-e", script], {
    timeoutMs: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to request a clean Live quit: ${result.stderr}`);
  }
}

async function dismissKnownLiveStartupDialogs({
  discardRecovery = false,
  launchedAt,
  pid,
} = {}) {
  const recoveryAvailable =
    discardRecovery &&
    (await hasUnresolvedRecentLiveLogMessage(
      "Live unexpectedly quit while you were working on the Live Set",
      launchedAt,
      [
        "Message Box: Audio is disabled.",
        "Ableton Agent listening",
        "Default App: End ExchangeDocument",
      ],
    ));
  const audioDisabled = await hasUnresolvedRecentLiveLogMessage(
    "Audio is disabled. Please choose an audio output device in the Audio Preferences.",
    launchedAt,
    [
      "Ableton Agent listening",
      "Default App: End ExchangeDocument",
      "Finish building application",
    ],
  );
  const script = `
use framework "AppKit"

set liveApplication to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:${pid}
if liveApplication is missing value then return "none"
liveApplication's activateWithOptions:3
delay 0.25

tell application "System Events"
  if not (exists process "Live") then return "none"
  tell process "Live"
    if ${recoveryAvailable ? "true" : "false"} then
      set frontmost to true
      delay 0.25
      if exists button "No" of window 1 then
        click button "No" of window 1
      else
        key code 48 using shift down
        key code 49
      end if
      return "recovery-discarded"
    end if
    if ${audioDisabled ? "true" : "false"} then
      set frontmost to true
      delay 0.25
      if exists button 1 of window 1 then
        click button 1 of window 1
      else
        key code 36
      end if
      return "audio-disabled"
    end if
    repeat with liveWindow in windows
      set dialogText to ""
      try
        set dialogText to (value of static texts of liveWindow) as text
      end try
    end repeat
  end tell
end tell
return "none"
`;
  const result = await runProcess("osascript", ["-e", script], {
    timeoutMs: 5_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect Live startup dialogs. Grant Accessibility permission to the terminal running the suite. ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim() || "none";
}

async function hasUnresolvedRecentLiveLogMessage(
  message,
  launchedAt,
  resolvedBy,
) {
  if (typeof launchedAt !== "string") return false;
  const preferences = join(homedir(), "Library", "Preferences", "Ableton");
  let directories;
  try {
    directories = await readdir(preferences, { withFileTypes: true });
  } catch {
    return false;
  }
  const logs = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("Live "))
      .map(async (entry) => {
        const path = join(preferences, entry.name, "Log.txt");
        try {
          return { path, modifiedAt: (await stat(path)).mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );
  const newest = logs
    .filter((entry) => entry !== undefined)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
  if (newest === undefined) return false;
  const lines = (await readRecentFile(newest.path)).split("\n");
  const matchingIndex = lines.findLastIndex((line) => line.includes(message));
  const matchingLine = lines[matchingIndex];
  if (matchingLine === undefined) return false;
  const timestamp = matchingLine.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
  )?.[1];
  if (timestamp === undefined) return false;
  const normalizedTimestamp = timestamp.replace(/(\.\d{3})\d+$/, "$1");
  const recent =
    new Date(normalizedTimestamp).getTime() >=
    new Date(launchedAt).getTime() - 2_000;
  if (!recent) return false;
  return !lines
    .slice(matchingIndex + 1)
    .some((line) => resolvedBy.some((marker) => line.includes(marker)));
}

async function readRecentFile(path, maximumBytes = 256_000) {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export function runProcess(
  command,
  args,
  { env = process.env, timeoutMs = 30_000, maxOutputBytes = 2_000_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) =>
      `${current}${String(chunk)}`.slice(-maxOutputBytes);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
