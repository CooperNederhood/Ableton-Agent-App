import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

const liveVersion = argument("live-version");
const output = resolve(
  argument("output") ??
    `.test-artifacts/live-validation/live-${new Date().toISOString().replaceAll(":", "-")}.json`,
);
if (!liveVersion) {
  console.error(
    "Usage: pnpm live:validate -- --live-version <version> [--output <path>]",
  );
  process.exit(2);
}
if (!process.env.ABLETON_AGENT_TOKEN) {
  console.error(
    "ABLETON_AGENT_TOKEN must contain the installed Remote Script token.",
  );
  process.exit(2);
}

const cli = resolve("apps/cli/dist/main.js");
const commands = [
  ["doctor"],
  ["snapshot", "--json"],
  ["transport", "--json"],
  ["browser-roots", "--json"],
];
const results = commands.map((args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  return {
    command: `ableton-agent ${args.join(" ")}`,
    status: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    passed: result.status === 0,
  };
});
const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
const evidence = {
  formatVersion: 1,
  recordedAt: new Date().toISOString(),
  commit,
  platform: process.platform,
  architecture: process.arch,
  liveVersion,
  automatedSmoke: results,
  manualChecks: {
    sessionClips: "pending",
    arrangementAndCuePoints: "pending",
    devicesAndParameters: "pending",
    racksAndDrumRacks: "pending",
    browserAndLoading: "pending",
    nativeUndo: "pending",
  },
  notes: [],
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, undefined, 2)}\n`, "utf8");
console.log(`Wrote real-Live validation evidence to ${output}`);
if (results.some((result) => !result.passed)) process.exit(1);
