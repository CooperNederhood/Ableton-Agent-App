export interface LifecycleDependencies {
  requestSingleInstanceLock(): boolean;
  onSecondInstance(handler: (argv: string[]) => void): void;
  handleDeepLink?(sessionId: string): void;
  createWindow(): Promise<void>;
  focusWindow(): void;
  startServices(): Promise<void>;
  stopServices(): Promise<void>;
  quit(): void;
}

export function parseDeepLink(argv: readonly string[]): string | undefined {
  const link = argv.find((value) => value.startsWith("ableton-agent://"));
  if (!link) return undefined;
  return /^ableton-agent:\/\/session\/([a-zA-Z0-9_-]{1,128})$/u.exec(link)?.[1];
}

export async function startDesktopLifecycle(
  deps: LifecycleDependencies,
): Promise<boolean> {
  if (!deps.requestSingleInstanceLock()) {
    deps.quit();
    return false;
  }
  deps.onSecondInstance((argv) => {
    deps.focusWindow();
    const sessionId = parseDeepLink(argv);
    if (sessionId) deps.handleDeepLink?.(sessionId);
  });
  await deps.startServices();
  await deps.createWindow();
  return true;
}

export async function stopDesktopLifecycle(
  deps: Pick<LifecycleDependencies, "stopServices">,
): Promise<void> {
  await deps.stopServices();
}
