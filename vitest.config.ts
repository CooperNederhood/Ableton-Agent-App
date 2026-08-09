import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ableton-agent/application": source(
        "./packages/application/src/index.ts",
      ),
      "@ableton-agent/bridge": source("./packages/bridge/src/index.ts"),
      "@ableton-agent/protocol": source("./packages/protocol/src/index.ts"),
      "@ableton-agent/shared": source("./packages/shared/src/index.ts"),
    },
  },
});
