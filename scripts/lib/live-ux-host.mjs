import { connect } from "node:net";

export async function waitForRunnerOwnedLiveReady(
  controller,
  {
    discardRecovery = true,
    host = "127.0.0.1",
    port = 8765,
    timeoutMs = 120_000,
    isReady = () => canConnect(host, port),
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
  } = {},
) {
  const deadline = now() + timeoutMs;
  const dismissedDialogs = [];
  while (now() < deadline) {
    const dismissed = await controller.dismissKnownStartupDialogs({
      discardRecovery,
    });
    if (dismissed !== "none" && !dismissedDialogs.includes(dismissed)) {
      dismissedDialogs.push(dismissed);
    }
    if (await isReady()) return { dismissedDialogs };
    await sleep(1_000);
  }
  throw new Error(
    `Runner-owned Live did not expose the Remote Script port ${host}:${port}`,
  );
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
