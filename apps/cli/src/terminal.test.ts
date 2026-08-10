import { describe, expect, it } from "vitest";

import {
  createColorizer,
  createOutputWriter,
  createTerminalPresentation,
  plainColorizer,
  shouldUseColor,
} from "./terminal.js";

describe("shouldUseColor", () => {
  it("enables color only for a real TTY with no NO_COLOR set", () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
  });

  it("disables color when stdout is not a TTY (redirected output)", () => {
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
    expect(shouldUseColor({}, {})).toBe(false);
  });

  it("disables color whenever NO_COLOR is present, regardless of value", () => {
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
  });

  it("defaults to reading from process.env when no env is supplied", () => {
    const previous = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      expect(shouldUseColor({ isTTY: true })).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previous;
      }
    }
  });
});

describe("createColorizer", () => {
  it("wraps text in ANSI codes when enabled", () => {
    const colors = createColorizer(true);
    expect(colors.enabled).toBe(true);
    expect(colors.green("✓ done")).toBe("\u001b[32m✓ done\u001b[0m");
    expect(colors.red("✗ failed")).toBe("\u001b[31m✗ failed\u001b[0m");
    expect(colors.dim("• started")).toBe("\u001b[2m• started\u001b[0m");
    expect(colors.bold("note")).toBe("\u001b[1mnote\u001b[0m");
  });

  it("passes text through unchanged when disabled", () => {
    const colors = createColorizer(false);
    expect(colors.enabled).toBe(false);
    expect(colors.green("✓ done")).toBe("✓ done");
    expect(colors.red("✗ failed")).toBe("✗ failed");
  });

  it("plainColorizer matches a disabled colorizer", () => {
    expect(plainColorizer().enabled).toBe(false);
    expect(plainColorizer().dim("x")).toBe("x");
  });
});

describe("createTerminalPresentation", () => {
  it("derives rich presentation capabilities from a TTY", () => {
    expect(
      createTerminalPresentation({ isTTY: true, columns: 120 }, {}),
    ).toMatchObject({
      rich: true,
      width: 120,
      unicode: true,
    });
  });

  it("uses deterministic fallback capabilities outside a TTY", () => {
    expect(
      createTerminalPresentation({ isTTY: false }, { TERM: "dumb" }),
    ).toMatchObject({
      rich: false,
      width: 80,
      unicode: false,
    });
  });
});

describe("createOutputWriter", () => {
  function sink() {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      lines,
      errors,
      io: {
        write: (text: string) => lines.push(text),
        writeError: (text: string) => errors.push(text),
      },
    };
  }

  it("emits info lines in human mode", () => {
    const out = sink();
    const writer = createOutputWriter(out.io);
    writer.info("• working");
    writer.result("done");
    writer.error("oops");
    expect(out.lines).toEqual(["• working", "done"]);
    expect(out.errors).toEqual(["oops"]);
  });

  it("suppresses info lines but keeps results in quiet mode", () => {
    const out = sink();
    const writer = createOutputWriter(out.io, { quiet: true });
    writer.info("• working");
    writer.result("done");
    writer.error("oops");
    expect(out.lines).toEqual(["done"]);
    expect(out.errors).toEqual(["oops"]);
    expect(writer.quiet).toBe(true);
  });

  it("exposes the requested json flag and a colorizer matching the color option", () => {
    const out = sink();
    const writer = createOutputWriter(out.io, { json: true, color: true });
    expect(writer.json).toBe(true);
    expect(writer.colors.enabled).toBe(true);
    expect(writer.colors.green("ok")).toBe("\u001b[32mok\u001b[0m");
  });
});
