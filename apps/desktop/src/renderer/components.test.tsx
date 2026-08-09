import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ApprovalPanel, Arrangement, Inspector, OperationCard } from "./App";
import { initialState } from "./state";

describe("desktop components", () => {
  it("renders operation recovery details without color-only status", () => {
    const html = renderToStaticMarkup(
      <OperationCard
        operation={{
          id: "1",
          label: "Place clips",
          status: "partial",
          detail: "2 of 3",
          warnings: ["Track locked"],
          changed: ["Intro"],
          unchanged: ["Verse"],
          retryable: true,
          undoable: true,
          timestamp: 1,
        }}
      />,
    );
    expect(html).toContain("partial");
    expect(html).toContain("Retry safely");
    expect(html).toContain("Not changed:");
  });

  it("renders approval preview and semantic actions", () => {
    const state = {
      ...initialState,
      approval: {
        id: "a",
        title: "Place arrangement",
        risk: "medium" as const,
        summary: "Place clips",
        changes: ["Add eight clips"],
        destructive: false,
      },
    };
    const html = renderToStaticMarkup(
      <ApprovalPanel state={state} dispatch={vi.fn()} />,
    );
    expect(html).toContain("Approve");
    expect(html).toContain("Add eight clips");
  });

  it("renders plan and empty inspector states", () => {
    expect(
      renderToStaticMarkup(
        <Arrangement state={initialState} dispatch={vi.fn()} />,
      ),
    ).toContain("Production plan");
    expect(
      renderToStaticMarkup(
        <Inspector state={initialState} dispatch={vi.fn()} />,
      ),
    ).toContain("Nothing selected");
  });
});
