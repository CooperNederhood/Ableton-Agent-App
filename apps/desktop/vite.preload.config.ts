import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    outDir: "dist/preload",
    emptyOutDir: true,
    rollupOptions: {
      external: ["electron"],
    },
    sourcemap: true,
    minify: false,
  },
});
