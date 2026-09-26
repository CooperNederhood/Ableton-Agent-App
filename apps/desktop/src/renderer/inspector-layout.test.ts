import { describe, expect, it } from "vitest";
import {
  createInspectorLayout,
  inspectorLayoutReducer,
  openInspectorModules,
} from "./inspector-layout";

describe("inspector layout", () => {
  it("closes and re-adds available modules without reopening them on reconcile", () => {
    const initial = createInspectorLayout(["selection", "plan"]);
    const closed = inspectorLayoutReducer(initial, {
      type: "close",
      moduleId: "plan",
    });
    expect(openInspectorModules(closed)).toEqual(["selection"]);
    expect(
      inspectorLayoutReducer(closed, {
        type: "reconcile",
        available: ["selection", "plan"],
      }),
    ).toMatchObject({
      closed: ["plan"],
      panes: [{ tabs: ["selection"] }],
    });

    const reopened = inspectorLayoutReducer(closed, {
      type: "add",
      moduleId: "plan",
    });
    expect(openInspectorModules(reopened)).toEqual(["selection", "plan"]);
    expect(reopened.closed).toEqual([]);
  });

  it("auto-opens modules only when they become available", () => {
    const initial = createInspectorLayout(["selection"]);
    const next = inspectorLayoutReducer(initial, {
      type: "reconcile",
      available: ["selection", "approval"],
    });
    expect(openInspectorModules(next)).toEqual(["selection", "approval"]);

    const unavailable = inspectorLayoutReducer(next, {
      type: "reconcile",
      available: ["selection"],
    });
    expect(openInspectorModules(unavailable)).toEqual(["selection"]);
    expect(
      openInspectorModules(
        inspectorLayoutReducer(unavailable, {
          type: "reconcile",
          available: ["selection", "approval"],
        }),
      ),
    ).toEqual(["selection", "approval"]);
  });

  it("splits modules into uniform panes and moves them between panes", () => {
    const initial = createInspectorLayout(["selection", "plan", "approval"]);
    const split = inspectorLayoutReducer(initial, {
      type: "split",
      moduleId: "plan",
      paneId: "inspector-pane-0",
      edge: "after",
    });
    expect(split.panes).toMatchObject([
      { tabs: ["selection", "approval"], weight: 0.5 },
      { tabs: ["plan"], weight: 0.5 },
    ]);

    const merged = inspectorLayoutReducer(split, {
      type: "move",
      moduleId: "plan",
      paneId: "inspector-pane-0",
      index: 1,
    });
    expect(merged.panes).toMatchObject([
      { tabs: ["selection", "plan", "approval"], weight: 1 },
    ]);
  });

  it("resizes adjacent panes while respecting the minimum weight", () => {
    const initial = inspectorLayoutReducer(
      createInspectorLayout(["selection", "plan"]),
      {
        type: "split",
        moduleId: "plan",
        paneId: "inspector-pane-0",
        edge: "after",
      },
    );
    const resized = inspectorLayoutReducer(initial, {
      type: "resize",
      dividerIndex: 0,
      delta: 0.2,
      minimumWeight: 0.15,
    });
    expect(resized.panes.map(({ weight }) => weight)).toEqual([0.7, 0.3]);
  });

  it("preserves manual weights when closing a tab without removing its pane", () => {
    const split = inspectorLayoutReducer(
      createInspectorLayout(["selection", "plan", "approval"]),
      {
        type: "split",
        moduleId: "plan",
        paneId: "inspector-pane-0",
        edge: "after",
      },
    );
    const resized = inspectorLayoutReducer(split, {
      type: "resize",
      dividerIndex: 0,
      delta: 0.2,
      minimumWeight: 0.15,
    });
    const closed = inspectorLayoutReducer(resized, {
      type: "close",
      moduleId: "approval",
    });
    expect(closed.panes.map(({ weight }) => weight)).toEqual([0.7, 0.3]);
  });
});
