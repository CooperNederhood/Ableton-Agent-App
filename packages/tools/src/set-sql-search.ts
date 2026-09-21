export const SET_HISTORY_PUBLIC_VIEWS = [
  "agent_history_sessions",
  "agent_history_turns",
  "agent_history_messages",
  "agent_history_tool_calls",
  "agent_history_tool_results",
  "agent_history_approvals",
  "set_history_saves",
  "set_history_snapshots",
  "set_history_tracks",
  "set_history_devices",
  "set_history_session_clips",
  "set_history_arrangement_clips",
  "set_history_scenes",
  "set_history_cue_points",
  "set_history_trajectories",
  "set_history_agent_links",
] as const;
export const SET_SQL_SEARCH_TOOL_NAME = "set_sql_search";

export type SetHistoryPublicView = (typeof SET_HISTORY_PUBLIC_VIEWS)[number];
export type SetSqlValue = string | number | boolean | null;
export type SetSqlRow = Readonly<Record<string, SetSqlValue>>;
export type SetSqlParameters = Readonly<Record<string, SetSqlValue>>;

export interface SetSqlSearchRequest {
  readonly sql: string;
  readonly parameters: readonly SetSqlValue[];
  readonly maxRows: number;
  readonly signal?: AbortSignal;
}

export interface SetSqlSearchResult {
  readonly schemaVersion: number;
  readonly columns: readonly string[];
  readonly rows: readonly SetSqlRow[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export interface SetHistoryQueryService {
  query(request: SetSqlSearchRequest): Promise<SetSqlSearchResult>;
}

export const SET_SQL_DEFAULT_MAX_ROWS = 100;
export const SET_SQL_MAX_ROWS = 200;
export const SET_SQL_MAX_LENGTH = 20_000;
export const SET_SQL_MAX_COLUMNS = 64;
export const SET_SQL_MAX_CELL_CHARACTERS = 4_096;
export const SET_SQL_MAX_PARAMETERS = 128;
export const SET_SQL_MAX_PARAMETER_NAME_LENGTH = 64;

const forbiddenKeyword =
  /\b(?:alter|analyze|attach|begin|commit|create|delete|detach|drop|insert|pragma|reindex|release|replace|rollback|savepoint|update|vacuum)\b/iu;
const sourceReference = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/giu;
const cteName = /(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/giu;

function normalizedSql(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/**
 * Validates the deliberately small SQL surface exposed to agents. The backing
 * service must still open its database read-only and enforce maxRows.
 */
export function validateSetSqlSearch(sql: string): string {
  if (sql.length === 0 || sql.length > SET_SQL_MAX_LENGTH) {
    throw new TypeError(`SQL must contain 1-${SET_SQL_MAX_LENGTH} characters`);
  }
  if (/--|\/\*|\*\//u.test(sql)) {
    throw new TypeError("SQL comments are not allowed");
  }
  const statement = normalizedSql(sql);
  if (statement.includes(";")) {
    throw new TypeError("Exactly one SQL statement is allowed");
  }
  if (!/^(?:select|with)\b/iu.test(statement)) {
    throw new TypeError("Only a SELECT or CTE query is allowed");
  }
  if (/^with\s+recursive\b/iu.test(statement)) {
    throw new TypeError("Recursive CTEs are not allowed");
  }
  if (forbiddenKeyword.test(statement)) {
    throw new TypeError("SQL contains a prohibited statement keyword");
  }

  const ctes = new Set<string>();
  for (const match of statement.matchAll(cteName)) {
    const name = match[1];
    if (name !== undefined) ctes.add(name.toLowerCase());
  }

  const allowed = new Set<string>(SET_HISTORY_PUBLIC_VIEWS);
  let sourceCount = 0;
  let publicSourceCount = 0;
  for (const match of statement.matchAll(sourceReference)) {
    const source = match[1]?.toLowerCase();
    if (source === undefined) continue;
    sourceCount++;
    if (allowed.has(source)) {
      publicSourceCount++;
    } else if (!ctes.has(source)) {
      throw new TypeError(
        `SQL source '${source}' is not an allowlisted Set History view`,
      );
    }
  }
  if (sourceCount === 0) {
    throw new TypeError("SQL must read from an allowlisted Set History view");
  }
  if (publicSourceCount === 0) {
    throw new TypeError(
      "SQL must reference at least one allowlisted Set History view",
    );
  }
  return statement;
}

export function validateSetSqlParameters(
  parameters: SetSqlParameters | undefined,
): SetSqlParameters | undefined {
  if (parameters === undefined) return undefined;
  const entries = Object.entries(parameters);
  if (entries.length > SET_SQL_MAX_PARAMETERS) {
    throw new TypeError(
      `SQL parameters must contain at most ${SET_SQL_MAX_PARAMETERS} entries`,
    );
  }
  const validated: Record<string, SetSqlValue> = {};
  for (const [name, value] of entries) {
    if (
      name.length > SET_SQL_MAX_PARAMETER_NAME_LENGTH ||
      !/^[a-z_][a-z0-9_]*$/iu.test(name)
    ) {
      throw new TypeError(
        "SQL parameter names must start with a letter or underscore and contain only letters, numbers, or underscores",
      );
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError("SQL parameters must be scalar values");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Numeric SQL parameters must be finite");
    }
    if (
      typeof value === "string" &&
      value.length > SET_SQL_MAX_CELL_CHARACTERS
    ) {
      throw new TypeError(
        `String SQL parameters must not exceed ${SET_SQL_MAX_CELL_CHARACTERS} characters`,
      );
    }
    validated[name] = value;
  }
  return validated;
}

export function bindSetSqlParameters(
  sql: string,
  parameters: SetSqlParameters | undefined,
): { sql: string; parameters: readonly SetSqlValue[] } {
  const validated = validateSetSqlParameters(parameters) ?? {};
  const used = new Set<string>();
  const values: SetSqlValue[] = [];
  let boundSql = "";
  let quote: "'" | '"' | "`" | "]" | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote !== undefined) {
      boundSql += character;
      const closingQuote = quote === "]" ? "]" : quote;
      if (character === closingQuote) {
        if (sql[index + 1] === closingQuote) {
          boundSql += closingQuote;
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      boundSql += character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      boundSql += character;
      continue;
    }
    if (character === "?") {
      throw new TypeError(
        "Positional SQL placeholders are not allowed; use named parameters",
      );
    }
    if (
      (character === ":" || character === "@" || character === "$") &&
      /^[a-z_]$/iu.test(sql[index + 1] ?? "")
    ) {
      let end = index + 2;
      while (/^[a-z0-9_]$/iu.test(sql[end] ?? "")) end++;
      const name = sql.slice(index + 1, end);
      if (!Object.prototype.hasOwnProperty.call(validated, name)) {
        throw new TypeError(`SQL parameter '${name}' is not provided`);
      }
      used.add(name);
      values.push(validated[name]!);
      boundSql += "?";
      index = end - 1;
      continue;
    }
    boundSql += character;
  }

  const unused = Object.keys(validated).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new TypeError(`SQL parameter '${unused[0]}' is not used`);
  }
  return { sql: boundSql, parameters: values };
}

export function boundSetSqlSearchResult(
  result: SetSqlSearchResult,
  maxRows: number,
): SetSqlSearchResult {
  if (
    !Number.isInteger(result.schemaVersion) ||
    result.schemaVersion < 0 ||
    !Number.isFinite(result.elapsedMs) ||
    result.elapsedMs < 0
  ) {
    throw new TypeError(
      "Set History result metadata must contain a non-negative schemaVersion and elapsedMs",
    );
  }
  const boundedLimit = Math.min(Math.max(1, maxRows), SET_SQL_MAX_ROWS);
  const columns = result.columns.slice(0, SET_SQL_MAX_COLUMNS).map((column) => {
    if (typeof column !== "string" || column.length === 0) {
      throw new TypeError(
        "Set History result columns must be non-empty strings",
      );
    }
    return column.slice(0, 256);
  });
  const allowedColumns = new Set(columns);
  const sourceRows = result.rows.slice(0, boundedLimit);
  const rows = sourceRows.map((row) => {
    const bounded: Record<string, SetSqlValue> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!allowedColumns.has(key)) continue;
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new TypeError("Set History result cells must be scalar values");
      }
      bounded[key] =
        typeof value === "string"
          ? value.slice(0, SET_SQL_MAX_CELL_CHARACTERS)
          : value;
    }
    return bounded;
  });
  return {
    schemaVersion: result.schemaVersion,
    columns,
    rows,
    rowCount: rows.length,
    truncated:
      result.truncated ||
      result.rows.length > boundedLimit ||
      result.columns.length > SET_SQL_MAX_COLUMNS,
    elapsedMs: result.elapsedMs,
  };
}
