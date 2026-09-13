import type { ContextChip } from "../contracts.js";

/**
 * Builds the prompt sent to the shared agent. Selected context is passed as
 * explicit references so the model resolves them through Ableton tools rather
 * than assuming any project state.
 */
export function composeAgentPrompt(
  message: string,
  context: readonly ContextChip[],
): string {
  const sections: string[] = [];
  if (context.length > 0) {
    sections.push(
      [
        "Selected context (verify with Ableton tools before acting):",
        ...context.map((chip) => `- ${chip.kind}: ${chip.label} (${chip.id})`),
      ].join("\n"),
    );
  }
  sections.push(message);
  return sections.join("\n\n");
}
