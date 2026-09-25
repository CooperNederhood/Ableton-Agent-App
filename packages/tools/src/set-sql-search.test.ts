import { describe, expect, it } from "vitest";

import {
  SET_HISTORY_PUBLIC_VIEWS,
  bindSetSqlParameters,
  boundSetSqlSearchResult,
  validateSetSqlParameters,
  validateSetSqlSearch,
} from "./set-sql-search.js";

describe("Set History SQL validation", () => {
  it("accepts one SELECT or CTE over public views", () => {
    expect(
      validateSetSqlSearch(
        "WITH recent AS (SELECT snapshot_id FROM set_history_snapshots) SELECT snapshot_id FROM recent;",
      ),
    ).toBe(
      "WITH recent AS (SELECT snapshot_id FROM set_history_snapshots) SELECT snapshot_id FROM recent",
    );
    expect(
      validateSetSqlSearch(
        "SELECT name FROM set_history_tracks WHERE live_set_id = :live_set_id LIMIT 20",
      ),
    ).toBe(
      "SELECT name FROM set_history_tracks WHERE live_set_id = :live_set_id LIMIT 20",
    );
  });

  it.each([
    "DELETE FROM set_history_snapshots",
    "SELECT * FROM private_snapshots",
    "SELECT * FROM set_history",
    "SELECT * FROM agent_history",
    "SELECT * FROM set_history_snapshots; SELECT * FROM set_history_tracks",
    "SELECT * FROM set_history_snapshots -- hide a second statement",
    "WITH RECURSIVE snapshots AS (SELECT * FROM set_history_snapshots) SELECT * FROM snapshots",
    "WITH generated AS (SELECT 1 AS value) SELECT value FROM generated",
    "PRAGMA table_info(set_history_snapshots)",
    "SELECT 1",
  ])("rejects unsafe or out-of-surface SQL: %s", (sql) => {
    expect(() => validateSetSqlSearch(sql)).toThrow();
  });

  it("keeps the public view surface explicit and stable", () => {
    expect(SET_HISTORY_PUBLIC_VIEWS).toEqual([
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
    ]);
  });

  it("accepts bounded named scalar parameters", () => {
    expect(
      validateSetSqlParameters({
        live_set_id: "set-1",
        after: "2026-09-01T00:00:00.000Z",
        minimum_tempo: 110,
        consistent: true,
        optional_id: null,
      }),
    ).toEqual({
      live_set_id: "set-1",
      after: "2026-09-01T00:00:00.000Z",
      minimum_tempo: 110,
      consistent: true,
      optional_id: null,
    });
  });

  it.each([
    { "not-valid!": "value" },
    { infinite: Number.POSITIVE_INFINITY },
    { oversized: "x".repeat(4_097) },
  ])("rejects invalid named scalar parameters: %o", (parameters) => {
    expect(() => validateSetSqlParameters(parameters)).toThrow();
  });

  it("binds repeated named parameters to positional database values", () => {
    expect(
      bindSetSqlParameters(
        "SELECT snapshot_id FROM set_history_snapshots WHERE live_set_id = :live_set_id OR live_project_id = @live_set_id AND captured_at >= $after",
        {
          live_set_id: "set-1",
          after: "2026-09-01T00:00:00.000Z",
        },
      ),
    ).toEqual({
      sql: "SELECT snapshot_id FROM set_history_snapshots WHERE live_set_id = ? OR live_project_id = ? AND captured_at >= ?",
      parameters: ["set-1", "set-1", "2026-09-01T00:00:00.000Z"],
    });
  });

  it("does not bind placeholder-like text inside SQL strings or identifiers", () => {
    expect(
      bindSetSqlParameters(
        "SELECT ':ignored' AS literal, \"$ignored\" AS quoted FROM set_history_snapshots WHERE live_set_id = :live_set_id",
        { live_set_id: "set-1" },
      ),
    ).toEqual({
      sql: "SELECT ':ignored' AS literal, \"$ignored\" AS quoted FROM set_history_snapshots WHERE live_set_id = ?",
      parameters: ["set-1"],
    });
  });

  it.each([
    [
      "SELECT snapshot_id FROM set_history_snapshots WHERE live_set_id = :missing",
      undefined,
    ],
    ["SELECT snapshot_id FROM set_history_snapshots", { unused: "set-1" }],
    [
      "SELECT snapshot_id FROM set_history_snapshots WHERE live_set_id = ?",
      undefined,
    ],
  ])("rejects missing, unused, or positional parameters", (sql, parameters) => {
    expect(() => bindSetSqlParameters(sql, parameters)).toThrow();
  });

  it("bounds rows and scalar text returned by the injected service", () => {
    const result = boundSetSqlSearchResult(
      {
        schemaVersion: 3,
        columns: ["name"],
        rows: [{ name: "x".repeat(5_000) }, { name: "second" }],
        rowCount: 2,
        truncated: false,
        elapsedMs: 12.5,
      },
      1,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toHaveLength(4_096);
    expect(result).toMatchObject({
      schemaVersion: 3,
      rowCount: 1,
      truncated: true,
      elapsedMs: 12.5,
    });
  });
});
