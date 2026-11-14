export async function awaitElectronLaunch<T>(
  start: () => Promise<T>,
): Promise<T> {
  const onUnhandled = (reason: unknown) => {
    // Playwright starts parallel stderr waits but awaits them sequentially.
    // Early process exit rejects secondary waits before it attaches handlers.
    if (
      reason instanceof Error &&
      reason.message === "Process failed to launch!" &&
      /at waitForLine \([^\n]*[/\\]playwright-core[/\\]lib[/\\]coreBundle\.js:\d+:\d+\)/u.test(
        reason.stack ?? "",
      )
    )
      return;
    if (
      !process
        .listeners("unhandledRejection")
        .some((listener) => listener !== onUnhandled)
    )
      throw reason instanceof Error
        ? reason
        : new Error("Unhandled rejection during Electron launch", {
            cause: reason,
          });
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    return await start();
  } finally {
    // Node reports these orphaned rejections after the awaited launch has rejected.
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", onUnhandled);
  }
}
