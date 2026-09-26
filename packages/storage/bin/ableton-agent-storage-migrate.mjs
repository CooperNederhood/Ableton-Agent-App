#!/usr/bin/env node

import { existsSync } from "node:fs";

const entryPoint = new URL("../dist/migrate-storage.js", import.meta.url);

if (!existsSync(entryPoint)) {
  console.error(
    "The storage migration CLI has not been built. Run " +
      "'pnpm --filter @ableton-agent/storage build' and try again.",
  );
  process.exitCode = 1;
} else {
  await import(entryPoint.href);
}
