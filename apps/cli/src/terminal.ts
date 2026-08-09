/**
 * TTY detection, `NO_COLOR` handling, and output-writer helpers shared by the
 * interactive and non-interactive CLI entry points.
 *
 * Behavior follows the terminal client specification
 * (docs/cli/terminal-client.md#output-formats-and-exit-codes):
 * - Color is only enabled for an actual TTY stream.
 * - `NO_COLOR` (any value, including empty string) always disables color,
 *   matching the https://no-color.org convention.
 * - Redirected output (a non-TTY stdout, e.g. piped to a file) never
 *   receives ANSI color codes regardless of `NO_COLOR`.
 */

export interface ColorStream {
  readonly isTTY?: boolean;
}

export interface ColorEnv {
  readonly NO_COLOR?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Determines whether ANSI color output should be emitted for the given
 * stream and environment. Redirected (non-TTY) output and any `NO_COLOR`
 * value both disable color.
 */
export function shouldUseColor(
  stream: ColorStream,
  env: ColorEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  return stream.isTTY === true;
}

export interface Colorizer {
  readonly enabled: boolean;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  bold(text: string): string;
}

const ANSI_CODES = {
  dim: "2",
  green: "32",
  red: "31",
  bold: "1",
} as const;

/** Creates a colorizer that either wraps text in ANSI codes or passes it through unchanged. */
export function createColorizer(enabled: boolean): Colorizer {
  const wrap =
    (code: string) =>
    (text: string): string =>
      enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
  return {
    enabled,
    dim: wrap(ANSI_CODES.dim),
    green: wrap(ANSI_CODES.green),
    red: wrap(ANSI_CODES.red),
    bold: wrap(ANSI_CODES.bold),
  };
}

const noColor = createColorizer(false);

/** Shared no-op colorizer, useful as a default for plain (non-TTY) rendering. */
export function plainColorizer(): Colorizer {
  return noColor;
}

export interface CliIoLike {
  write(text: string): void;
  writeError(text: string): void;
}

export interface OutputWriter {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly colors: Colorizer;
  /** Ambient/informational text (banners, operation progress). Suppressed in quiet mode. */
  info(text: string): void;
  /** The final result of a command. Always shown, in every mode. */
  result(text: string): void;
  /** Error text. Always shown, in every mode, on the error stream. */
  error(text: string): void;
}

export interface OutputWriterOptions {
  json?: boolean;
  quiet?: boolean;
  color?: boolean;
}

/**
 * Builds an output writer that mediates human/quiet/JSON behavior on top of
 * a raw `CliIo`-like sink. `info` lines are ambient/progress text that quiet
 * mode suppresses; `result` lines are the final answer to a command and are
 * always emitted.
 */
export function createOutputWriter(
  io: CliIoLike,
  options: OutputWriterOptions = {},
): OutputWriter {
  const json = options.json ?? false;
  const quiet = options.quiet ?? false;
  const colors = createColorizer(options.color ?? false);
  return {
    json,
    quiet,
    colors,
    info(text: string): void {
      if (!quiet) {
        io.write(text);
      }
    },
    result(text: string): void {
      io.write(text);
    },
    error(text: string): void {
      io.writeError(text);
    },
  };
}
