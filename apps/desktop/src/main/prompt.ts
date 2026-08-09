import type { ContextChip, ProductMode } from "../contracts.js";

const modeGuidance: Record<ProductMode, string> = {
  explore: "Explore the Live set and explain what is actually there.",
  compose: "Work on musical material: clips, notes, and parts.",
  arrange: "Work on arrangement structure, sections, and transitions.",
  sound: "Work on instruments, devices, and sound design.",
  mix: "Work on mixing: levels, panning, and mix-oriented devices.",
};

/**
 * Builds the prompt sent to the shared agent. Selected context is passed as
 * explicit references so the model resolves them through Ableton tools rather
 * than assuming any project state.
 */
export function composeAgentPrompt(
  message: string,
  context: readonly ContextChip[],
  mode: ProductMode,
): string {
  const sections = [`Mode: ${mode}. ${modeGuidance[mode]}`];
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
