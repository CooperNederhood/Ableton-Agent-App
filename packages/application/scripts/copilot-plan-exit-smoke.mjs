import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { CopilotClient } from "@github/copilot-sdk";

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

try {
  session = await client.createSession({
    clientName: "ableton-agent-plan-exit-smoke",
    availableTools: ["builtin:exit_plan_mode"],
    customAgents: [
      {
        name: "plan-exit-smoke",
        prompt:
          "Create a concise plan only. Do not edit files or call any tool except exit_plan_mode. When the plan is complete, call exit_plan_mode.",
        tools: ["exit_plan_mode"],
        infer: false,
      },
    ],
    agent: "plan-exit-smoke",
    systemMessage: {
      content:
        "This is a read-only compatibility smoke. Produce a one-step plan, then invoke exit_plan_mode. No mutation or host tools are available.",
    },
    onExitPlanModeRequest: async () => {
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
