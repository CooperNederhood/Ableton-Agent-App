import { spawn } from "node:child_process";

const debug = process.argv.includes("--debug");
const environment = {
  ...process.env,
  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
  ...(debug
    ? {
        ABLETON_AGENT_LOG_LEVEL: "debug",
        ABLETON_AGENT_OPEN_DEVTOOLS: "1",
      }
    : {}),
};
const children = new Set();

console.log(
  debug
    ? "Starting desktop development with debug logging and DevTools enabled."
    : "Starting desktop development.",
);
console.log(
  "Renderer changes hot reload; main and preload changes require restarting this command.",
);
console.log(
  "The desktop process will print the development log path at startup.",
);

function run(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    cwd: new URL("..", import.meta.url),
    env: environment,
    stdio: "inherit",
    ...options,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

for (const build of ["build:preload", "build:electron"]) {
  const child = run("pnpm", [build]);
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) process.exit(code ?? 1);
}

run("pnpm", [
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  "5173",
  "--strictPort",
]);
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const response = await fetch(environment.VITE_DEV_SERVER_URL);
    if (response.ok) break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (attempt === 99) {
    stop();
    throw new Error("Vite development server did not become ready");
  }
}
const electron = run("pnpm", ["exec", "electron", "."]);
const exitCode = await new Promise((resolve) => electron.once("exit", resolve));
stop();
process.exitCode = exitCode ?? 1;
