import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Match Vitest's Node-subpath aliases without changing parent process state. */
export async function runRestrictiveUmaskChild(
  script: string,
): Promise<string> {
  const aliases = {
    "@ableton-agent/shared/m4l-devices": new URL(
      "../../packages/shared/dist/m4l-devices.js",
      import.meta.url,
    ).href,
    "@ableton-agent/test-support/integration": new URL(
      "../../packages/test-support/dist/integration/index.js",
      import.meta.url,
    ).href,
  };
  const hook = `export function resolve(specifier, context, next) {
    const aliases = ${JSON.stringify(aliases)};
    return next(Object.hasOwn(aliases, specifier) ? aliases[specifier] : specifier, context);
  }`;
  const preload = `import { register } from "node:module";
    process.umask(0o077);
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});
  `;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: process.cwd(), timeout: 30_000 },
    );
    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? error.stderr
        : undefined;
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown";
    const detail = typeof stderr === "string" ? stderr : String(error);
    throw new Error(
      `Restrictive-umask child failed (${code}): ${detail.slice(0, 8192)}`,
    );
  }
}
