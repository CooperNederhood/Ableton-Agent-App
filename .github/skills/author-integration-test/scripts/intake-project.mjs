import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { describeScenarioError } from "../../../../scripts/lib/scenario-receipts.mjs";

try {
  const { intakeCli } = await tsImport("./intake-project.ts", {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(
      new URL("../../../../tsconfig.test-runtime.json", import.meta.url),
    ),
  });
  process.exitCode = await intakeCli(process.argv.slice(2));
} catch (error) {
  console.error(describeScenarioError(error));
  process.exitCode = 1;
}
