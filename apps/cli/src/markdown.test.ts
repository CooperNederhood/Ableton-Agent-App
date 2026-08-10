import { describe, expect, it } from "vitest";

import {
  renderMarkdown,
  sanitizeTerminalText,
  StreamingMarkdownRenderer,
} from "./markdown.js";
import { createColorizer, type TerminalPresentation } from "./terminal.js";

function presentation(
  overrides: Partial<TerminalPresentation> = {},
): TerminalPresentation {
  return {
    rich: true,
    width: 100,
    unicode: true,
    colors: createColorizer(false),
    ...overrides,
  };
}

const projectStatus = `# Project status

## Transport

- Tempo: **128 BPM**
- Playback: currently playing

## Tracks

| Idx | Name | Type | Muted | Soloed | Armed |
|---|---|---|---|---|---|
| 0 | LIVE SYNTHS | Audio | | | |
| 1 | DFAM-synth | MIDI | | | |
| 4 | 0-coast-cap | Audio | yes | | yes |`;

describe("terminal Markdown rendering", () => {
  it("renders headings, lists, emphasis, and wide tables", () => {
    const rendered = renderMarkdown(projectStatus, presentation());

    expect(rendered).toContain("Project status");
    expect(rendered).toContain("• Tempo: 128 BPM");
    expect(rendered).toContain("LIVE SYNTHS");
    expect(rendered).toContain("DFAM-synth");
    expect(rendered).not.toContain("|---|");
    expect(rendered).not.toContain("\u001b");
  });

  it("falls back to labeled records for narrow multi-column tables", () => {
    const rendered = renderMarkdown(
      projectStatus,
      presentation({ width: 48, unicode: false }),
    );

    expect(rendered).toContain("# 1");
    expect(rendered).toContain("Idx:");
    expect(rendered).toContain("Name: LIVE SYNTHS");
    expect(rendered).not.toContain("|---|");
  });

  it("wraps prose to the terminal width", () => {
    const rendered = renderMarkdown(
      "This is a deliberately long paragraph that must wrap without losing any words or introducing terminal control sequences.",
      presentation({ width: 40 }),
    );

    expect(rendered.split("\n").every((line) => line.length <= 40)).toBe(true);
    expect(rendered).toContain("terminal control");
  });

  it("removes model-supplied ANSI and control sequences", () => {
    const rendered = renderMarkdown(
      "safe \u001b[31mred\u001b[0m\u0007 text",
      presentation(),
    );

    expect(rendered).toBe("safe red text");
    expect(sanitizeTerminalText("\u001b[2Jhello")).toBe("hello");
    expect(sanitizeTerminalText("before\rafter")).toBe("beforeafter");
  });
});

describe("streaming terminal Markdown", () => {
  it("emits completed blocks and flushes an unfinished table once", () => {
    const blocks: string[] = [];
    const renderer = new StreamingMarkdownRenderer(presentation(), (text) =>
      blocks.push(text),
    );

    renderer.push("# Status\n\n");
    renderer.push("| Name | State |\n|---|---|\n");
    renderer.push("| Ableton | Connected |");
    expect(blocks).toEqual(["Status\n━━━━━━"]);

    renderer.complete(
      "# Status\n\n| Name | State |\n|---|---|\n| Ableton | Connected |",
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain("\n");
    expect(blocks[1]).toContain("Ableton");
    expect(blocks[1]).toContain("Connected");
  });

  it("renders the complete response when no deltas were received", () => {
    const blocks: string[] = [];
    const renderer = new StreamingMarkdownRenderer(presentation(), (text) =>
      blocks.push(text),
    );

    renderer.complete("**Ready**");

    expect(blocks).toEqual(["Ready"]);
  });
});
