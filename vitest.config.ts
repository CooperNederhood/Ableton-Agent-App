import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/electron/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    retry: 0,
  },
  resolve: {
    alias: {
      "@ableton-agent/ableton-contracts": source(
        "./packages/ableton-contracts/src/index.ts",
      ),
      "@ableton-agent/application": source(
        "./packages/application/src/index.ts",
      ),
      "@ableton-agent/bridge": source("./packages/bridge/src/index.ts"),
      "@ableton-agent/correlation": source(
        "./packages/correlation/src/index.ts",
      ),
      "@ableton-agent/protocol": source("./packages/protocol/src/index.ts"),
      "@ableton-agent/project-state": source(
        "./packages/project-state/src/index.ts",
      ),
      "@ableton-agent/runtime": source("./packages/runtime/src/index.ts"),
      "@ableton-agent/shared": source("./packages/shared/src/index.ts"),
      "@ableton-agent/test-support": source(
        "./packages/test-support/src/index.ts",
      ),
      "@ableton-agent/tools": source("./packages/tools/src/index.ts"),
    },
  },
});
