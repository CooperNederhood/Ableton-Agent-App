import { describe, expect, it } from "vitest";

import { selectScenarioGroups } from "./scenario-suite.mjs";

const suite = {
  formatVersion: 1,
  groups: [
    { id: "inspection", scenarios: ["connection", "browser"] },
    { id: "tracks", scenarios: ["track-life", "track-stale"] },
  ],
};

describe("scenario suite selection", () => {
  it("preserves suite group and scenario order by default", () => {
    expect(selectScenarioGroups(suite)).toEqual(suite.groups);
  });

  it("selects groups and individual scenarios", () => {
    expect(selectScenarioGroups(suite, { group: "tracks" })).toEqual([
      { id: "tracks", scenarios: ["track-life", "track-stale"] },
    ]);
    expect(selectScenarioGroups(suite, { scenario: "browser" })).toEqual([
      { id: "inspection", scenarios: ["browser"] },
    ]);
  });

  it("resumes from a scenario while retaining later groups", () => {
    expect(selectScenarioGroups(suite, { resumeFrom: "browser" })).toEqual([
      { id: "inspection", scenarios: ["browser"] },
      { id: "tracks", scenarios: ["track-life", "track-stale"] },
    ]);
  });

  it("rejects unknown and empty selections", () => {
    expect(() => selectScenarioGroups(suite, { group: "devices" })).toThrow(
      "Unknown scenario group",
    );
    expect(() =>
      selectScenarioGroups(suite, {
        group: "inspection",
        resumeFrom: "track-life",
      }),
    ).toThrow("outside the selected group");
  });
});
