import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "apps/*/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "vitest.config.ts",
            "playwright.config.ts",
            "tests/electron/*.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importPlugin,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "import-x/no-cycle": "error",
    },
  },
  {
    files: ["packages/protocol/**/*.{ts,tsx}", "packages/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@ableton-agent/*"],
              message:
                "Protocol and shared foundations cannot depend on higher-level workspace packages.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/bridge/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@ableton-agent/application",
                "@ableton-agent/runtime",
                "@ableton-agent/tools",
                "@ableton-agent/workflows",
                "@ableton-agent/project-state",
              ],
              message:
                "The bridge may depend only on inward-facing contracts, protocol, and shared utilities.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/application/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@ableton-agent/bridge", "@ableton-agent/runtime"],
              message:
                "The application core depends on the Ableton service contract, not on a transport or the composition root.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "electron",
                "@ableton-agent/application",
                "@ableton-agent/bridge",
                "@ableton-agent/runtime",
                "@ableton-agent/tools",
                "@ableton-agent/workflows",
                "@ableton-agent/project-state",
              ],
              message:
                "The sandboxed renderer may use only presentation contracts exposed by preload.",
            },
          ],
        },
      ],
    },
  },
);
