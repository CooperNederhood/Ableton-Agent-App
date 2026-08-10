/* eslint-disable no-control-regex -- terminal escape filtering requires explicit control ranges */
import Table from "cli-table3";
import { Lexer, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

import {
  createColorizer,
  type Colorizer,
  type TerminalPresentation,
} from "./terminal.js";

const controlSequence =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;
const unsafeControlCharacter = new RegExp(
  "[\\x00-\\x08\\x0B\\x0C\\x0D\\x0E-\\x1F\\x7F]",
  "gu",
);

export interface MarkdownRenderOptions {
  readonly width?: number;
  readonly unicode?: boolean;
  readonly colors?: Colorizer;
}

interface RenderContext {
  readonly width: number;
  readonly unicode: boolean;
  readonly colors: Colorizer;
}

function tokenField(token: Token, name: string): unknown {
  return (token as unknown as Record<string, unknown>)[name];
}

function tokenText(token: Token): string {
  const value = tokenField(token, "text");
  return typeof value === "string" ? value : token.raw;
}

function tokenTokens(token: Token): Token[] {
  const value = tokenField(token, "tokens");
  return Array.isArray(value) ? (value as Token[]) : [];
}

export function sanitizeTerminalText(text: string): string {
  return text.replace(controlSequence, "").replace(unsafeControlCharacter, "");
}

function wrap(text: string, width: number): string {
  return wrapAnsi(text, Math.max(10, width), {
    hard: false,
    trim: false,
    wordWrap: true,
  });
}

function renderInline(tokens: Token[], context: RenderContext): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "escape":
        case "text":
          return sanitizeTerminalText(tokenText(token));
        case "strong":
          return context.colors.bold(renderInline(tokenTokens(token), context));
        case "em":
          return context.colors.cyan(renderInline(tokenTokens(token), context));
        case "del":
          return `~${renderInline(tokenTokens(token), context)}~`;
        case "codespan":
          return context.colors.yellow(
            `\`${sanitizeTerminalText(tokenText(token))}\``,
          );
        case "br":
          return "\n";
        case "link": {
          const label = renderInline(tokenTokens(token), context);
          const hrefValue = tokenField(token, "href");
          const href =
            typeof hrefValue === "string"
              ? sanitizeTerminalText(hrefValue)
              : "";
          return label === href
            ? href
            : `${label} (${context.colors.dim(href)})`;
        }
        case "image":
          return `[image: ${sanitizeTerminalText(tokenText(token))}]`;
        case "html":
          return sanitizeTerminalText(
            tokenText(token).replace(/<[^>]*>/gu, ""),
          );
        default:
          return tokenTokens(token).length > 0
            ? renderInline(tokenTokens(token), context)
            : sanitizeTerminalText(token.raw);
      }
    })
    .join("");
}

function indentWrapped(
  text: string,
  prefix: string,
  continuation: string,
  width: number,
): string {
  const available = Math.max(10, width - stringWidth(prefix));
  const lines = wrap(text, available).split("\n");
  return lines
    .map((line, index) => `${index === 0 ? prefix : continuation}${line}`)
    .join("\n");
}

function renderList(token: Tokens.List, context: RenderContext): string {
  return token.items
    .map((item, index) => {
      const marker = token.ordered
        ? `${Number(token.start || 1) + index}. `
        : `${context.unicode ? "•" : "-"} `;
      const task = item.task ? `${item.checked ? "[x]" : "[ ]"} ` : "";
      const body = renderBlocks(item.tokens, context, false).trim();
      return indentWrapped(
        `${task}${body}`,
        marker,
        " ".repeat(stringWidth(marker)),
        context.width,
      );
    })
    .join("\n");
}

function tableMinimumWidth(columnCount: number): number {
  return columnCount * 12 + columnCount + 1;
}

function renderTableCards(token: Tokens.Table, context: RenderContext): string {
  const labels = token.header.map((cell, index) => {
    const rendered = renderInline(cell.tokens, context).trim();
    return rendered || `Column ${index + 1}`;
  });
  return token.rows
    .map((row, rowIndex) => {
      const heading = context.colors.bold(
        `${context.unicode ? "◆" : "#"} ${rowIndex + 1}`,
      );
      const fields = row.map((cell, index) =>
        indentWrapped(
          renderInline(cell.tokens, context).trim() || "—",
          `${context.colors.dim(`${labels[index] ?? `Column ${index + 1}`}:`)} `,
          "  ",
          context.width,
        ),
      );
      return [heading, ...fields].join("\n");
    })
    .join("\n\n");
}

function distributeColumnWidths(rows: string[][], width: number): number[] {
  const columnCount = rows[0]?.length ?? 0;
  const borderWidth = columnCount * 3 + 1;
  const available = Math.max(columnCount * 8, width - borderWidth);
  const desired = Array.from({ length: columnCount }, (_, index) =>
    Math.max(
      8,
      ...rows.map((row) => Math.min(36, stringWidth(row[index] ?? ""))),
    ),
  );
  const total = desired.reduce((sum, value) => sum + value, 0);
  if (total <= available) {
    return desired.map((value) => value + 2);
  }
  const minimum = 8;
  let remaining = available - minimum * columnCount;
  const result = desired.map(() => minimum);
  while (remaining > 0) {
    const candidate = result
      .map((value, index) => ({
        index,
        gap: (desired[index] ?? minimum) - value,
      }))
      .sort((left, right) => right.gap - left.gap)[0];
    if (!candidate || candidate.gap <= 0) break;
    result[candidate.index] = (result[candidate.index] ?? minimum) + 1;
    remaining -= 1;
  }
  return result.map((value) => value + 2);
}

function renderTable(token: Tokens.Table, context: RenderContext): string {
  const columnCount = token.header.length;
  if (columnCount === 0 || context.width < tableMinimumWidth(columnCount)) {
    return renderTableCards(token, context);
  }
  const header = token.header.map((cell) =>
    renderInline(cell.tokens, context).trim(),
  );
  const rows = token.rows.map((row) =>
    row.map((cell) => renderInline(cell.tokens, context).trim()),
  );
  const table = new Table({
    head: header.map((value) => context.colors.bold(value)),
    colWidths: distributeColumnWidths([header, ...rows], context.width),
    colAligns: token.align.map((alignment) => alignment ?? "left"),
    wordWrap: true,
    wrapOnWordBoundary: true,
    style: {
      compact: true,
      head: [],
      border: [],
    },
    ...(context.unicode
      ? {}
      : {
          chars: {
            top: "-",
            "top-mid": "+",
            "top-left": "+",
            "top-right": "+",
            bottom: "-",
            "bottom-mid": "+",
            "bottom-left": "+",
            "bottom-right": "+",
            left: "|",
            "left-mid": "+",
            mid: "-",
            "mid-mid": "+",
            right: "|",
            "right-mid": "+",
            middle: "|",
          },
        }),
  });
  table.push(...rows);
  const rendered = table.toString();
  return context.colors.enabled ? rendered : sanitizeTerminalText(rendered);
}

function renderBlock(token: Token, context: RenderContext): string {
  switch (token.type) {
    case "space":
      return "";
    case "heading": {
      const marker = context.unicode ? "━" : "=";
      const text = context.colors.bold(
        renderInline(tokenTokens(token), context),
      );
      return token.depth <= 2
        ? `${text}\n${context.colors.dim(marker.repeat(Math.min(context.width, Math.max(3, stringWidth(text)))))}`
        : text;
    }
    case "paragraph":
      return wrap(renderInline(tokenTokens(token), context), context.width);
    case "text":
      return wrap(
        tokenTokens(token).length > 0
          ? renderInline(tokenTokens(token), context)
          : sanitizeTerminalText(tokenText(token)),
        context.width,
      );
    case "list":
      return renderList(token as Tokens.List, context);
    case "blockquote":
      return renderBlocks(tokenTokens(token), context)
        .split("\n")
        .map(
          (line) =>
            `${context.colors.dim(context.unicode ? "│ " : "> ")}${line}`,
        )
        .join("\n");
    case "code": {
      const language = tokenField(token, "lang");
      const label =
        typeof language === "string"
          ? `${context.colors.dim(`[${sanitizeTerminalText(language)}]`)}\n`
          : "";
      return `${label}${sanitizeTerminalText(tokenText(token))
        .split("\n")
        .map(
          (line) =>
            `${context.colors.dim(context.unicode ? "│ " : "| ")}${line}`,
        )
        .join("\n")}`;
    }
    case "hr":
      return context.colors.dim(
        (context.unicode ? "─" : "-").repeat(Math.min(context.width, 72)),
      );
    case "table":
      return renderTable(token as Tokens.Table, context);
    case "html":
      return wrap(
        sanitizeTerminalText(tokenText(token).replace(/<[^>]*>/gu, "")),
        context.width,
      );
    default:
      return tokenTokens(token).length > 0
        ? renderBlocks(tokenTokens(token), context)
        : sanitizeTerminalText(token.raw);
  }
}

function renderBlocks(
  tokens: Token[],
  context: RenderContext,
  separate = true,
): string {
  return tokens
    .map((token) => renderBlock(token, context).trimEnd())
    .filter(Boolean)
    .join(separate ? "\n\n" : "\n");
}

export function renderMarkdown(
  markdown: string,
  options: MarkdownRenderOptions = {},
): string {
  const context: RenderContext = {
    width: Math.max(40, options.width ?? 80),
    unicode: options.unicode ?? true,
    colors: options.colors ?? createColorizer(false),
  };
  return renderBlocks(
    Lexer.lex(sanitizeTerminalText(markdown), { gfm: true }),
    context,
  );
}

function stableMarkdownPrefix(markdown: string): {
  readonly stable: string;
  readonly remainder: string;
} {
  const lines = markdown.split(/(?<=\n)/u);
  let inFence = false;
  let stableEnd = 0;
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^(```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
    }
    offset += line.length;
    if (!inFence && /^\s*$/u.test(line)) {
      stableEnd = offset;
    }
  }
  return {
    stable: markdown.slice(0, stableEnd),
    remainder: markdown.slice(stableEnd),
  };
}

export class StreamingMarkdownRenderer {
  #buffer = "";
  #receivedDelta = false;
  #emittedBlock = false;

  public constructor(
    private readonly presentation: TerminalPresentation,
    private readonly emit: (text: string) => void,
  ) {}

  public push(delta: string): void {
    this.#receivedDelta = true;
    this.#buffer += delta;
    const { stable, remainder } = stableMarkdownPrefix(this.#buffer);
    this.#buffer = remainder;
    if (stable.trim()) {
      this.writeBlock(stable);
    }
  }

  public complete(content: string): void {
    if (!this.#receivedDelta) {
      this.writeBlock(content);
    } else {
      this.flush();
    }
  }

  public flush(): void {
    if (this.#buffer.trim()) {
      this.writeBlock(this.#buffer);
    }
    this.#buffer = "";
  }

  private writeBlock(markdown: string): void {
    const rendered = renderMarkdown(markdown, this.presentation);
    if (rendered) {
      this.emit(`${this.#emittedBlock ? "\n" : ""}${rendered}`);
      this.#emittedBlock = true;
    }
  }
}
