import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function hasRunningLive11(processes: string): boolean {
  return processes
    .replaceAll('"', "")
    .split(/\r?\n/u)
    .some((line) =>
      /(?:^|\s|[/\\])(?:Ableton Live 11[^/\\\r\n]*\.app\/Contents\/MacOS\/Live(?:\s|$)|Ableton Live 11[^/\\\r\n]*\.exe(?:[\s,]|$))/iu.test(
        line,
      ),
    );
}

export async function assertAbletonLive11Stopped(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly readProcessList?: () => Promise<string>;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  let processes: string;
  if (platform !== "darwin" && platform !== "win32")
    throw new Error(
      "Cannot safely inspect Ableton Live processes on this platform",
    );
  if (options.readProcessList !== undefined) {
    processes = await options.readProcessList();
  } else if (platform === "darwin") {
    processes = (
      await execute("/bin/ps", ["-ww", "-axo", "command="], {
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } else {
    processes = (
      await execute("tasklist", ["/FO", "CSV", "/NH"], {
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  }
  if (hasRunningLive11(processes)) {
    throw new Error("Quit Ableton Live 11 before installing integrations");
  }
}
