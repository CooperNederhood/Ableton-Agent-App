import { clearInterval, setInterval } from "node:timers";

import {
  LiveProcessController,
  createComputerUseLiveController,
} from "./lib/live-process-controller.mjs";
import { waitForRunnerOwnedLiveReady } from "./lib/live-ux-host.mjs";

const applicationPath =
  process.env.ABLETON_LIVE_APP ?? "/Applications/Ableton Live 11 Suite.app";
const coordinatedStartup = process.argv.includes("--computer-use");
const controller = coordinatedStartup
  ? createComputerUseLiveController()
  : new LiveProcessController();
let launched = false;
let stopRequested;
const stopped = new Promise((resolve) => {
  stopRequested = resolve;
});
const keepAlive = setInterval(() => undefined, 60_000);

process.once("SIGINT", stopRequested);
process.once("SIGTERM", stopRequested);

try {
  const liveProcess = await controller.launch(applicationPath);
  launched = true;
  console.log(JSON.stringify({ type: "runner.process_owned", liveProcess }));
  const readiness = await waitForRunnerOwnedLiveReady(controller, {
    coordinatedStartup,
    discardRecovery: !coordinatedStartup,
  });
  console.log(
    JSON.stringify({
      ready: true,
      liveProcess,
      dismissedDialogs: readiness.dismissedDialogs,
    }),
  );
  await stopped;
  await controller.gracefulStop();
} catch (error) {
  if (launched) {
    try {
      await controller.discardAfterFailure();
    } catch (cleanupError) {
      console.error(
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
      );
    }
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
