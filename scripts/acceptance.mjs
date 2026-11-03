import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { describeScenarioError } from "./lib/scenario-receipts.mjs";

try {
  const { acceptanceCli } = await tsImport("./lib/acceptance-cli.ts", {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(
      new URL("../tsconfig.test-runtime.json", import.meta.url),
    ),
  });
  process.exitCode = await acceptanceCli(process.argv.slice(2), {
    root: fileURLToPath(new URL("../", import.meta.url)),
  });
} catch (error) {
  console.error(describeScenarioError(error));
  process.exitCode = 1;
}
