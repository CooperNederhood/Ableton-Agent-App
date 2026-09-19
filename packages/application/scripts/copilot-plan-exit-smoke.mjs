import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { z } from "zod";

if (process.env.RUN_COPILOT_PLAN_EXIT_SMOKE !== "1") {
  throw new Error(
    "Set RUN_COPILOT_PLAN_EXIT_SMOKE=1 to run the authenticated Copilot plan-exit smoke.",
  );
}

const baseDirectory = await mkdtemp(
  join(tmpdir(), "ableton-agent-plan-exit-smoke-"),
);
const client = new CopilotClient({ mode: "empty", baseDirectory });
let exitRequested = false;
let session;
const planPath = join(
  baseDirectory,
  "session-state",
  "smoke-production",
  "artifacts",
  "plan.md",
);

try {
  session = await client.createSession({
    clientName: "ableton-agent-plan-exit-smoke",
    tools: [
      defineTool("write_plan", {
        description: "Write the fixed smoke-test plan artifact.",
        parameters: z.object({ content: z.string().min(1).max(10_000) }),
        skipPermission: true,
        handler: async ({ content }) => {
          await mkdir(dirname(planPath), { recursive: true });
          await writeFile(planPath, content, "utf8");
          return { written: true };
        },
      }),
    ],
    availableTools: ["custom:write_plan", "builtin:exit_plan_mode"],
    toolSearch: { enabled: false },
    customAgents: [
      {
        name: "plan-exit-smoke",
        prompt:
          "Create a concise one-step plan, save the complete Markdown with write_plan, then call exit_plan_mode with only a short summary.",
        tools: ["write_plan", "exit_plan_mode"],
        infer: false,
      },
    ],
    agent: "plan-exit-smoke",
    systemMessage: {
      content:
        "This is a read-only compatibility smoke. The fixed write_plan tool is the only writable surface. Save plan.md before invoking exit_plan_mode.",
    },
    onExitPlanModeRequest: async () => {
      const content = await readFile(planPath, "utf8");
      if (!content.includes("Plan")) {
        return {
          approved: false,
          feedback: "The canonical plan artifact was not written.",
        };
      }
      exitRequested = true;
      return { approved: true, selectedAction: "exit_only" };
    },
  });
  await session.sendAndWait(
    {
      prompt:
        "Plan how to inspect the current Ableton session, then request exit from plan mode.",
      agentMode: "plan",
    },
    120_000,
  );
  if (!exitRequested) {
    throw new Error(
      "Copilot completed without invoking the exit_plan_mode approval callback.",
    );
  }
  process.stdout.write("Copilot exit-plan callback observed.\n");
} finally {
  try {
    await session?.disconnect();
  } finally {
    try {
      await client.stop();
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  }
}
