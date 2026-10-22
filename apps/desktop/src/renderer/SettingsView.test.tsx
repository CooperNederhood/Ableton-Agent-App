// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preferencesSchema, type DesktopPreferences } from "../contracts.js";
import { SettingsView } from "./App.js";
import { initialState } from "./state.js";

let root: Root;
let container: HTMLDivElement;
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
};
const previousActFlag = environment.IS_REACT_ACT_ENVIRONMENT;
const dispatch = vi.fn();
const set = vi.fn(async (preferences: DesktopPreferences) =>
  preferencesSchema.parse(preferences),
);

beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatch.mockClear();
  set.mockClear();
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { preferences: { set } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = previousActFlag;
});
async function render() {
  await act(async () =>
    root.render(<SettingsView state={initialState} dispatch={dispatch} />),
  );
}
function mode() {
  return container.querySelector<HTMLSelectElement>(
    ".listening-settings select",
  )!;
}
function limit() {
  return container.querySelector<HTMLInputElement>(
    ".listening-settings input",
  )!;
}
async function choose(value: string) {
  await act(async () => {
    mode().value = value;
    mode().dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function changeLimit(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(limit(), value);
    limit().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(
      new Event("submit", {
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe("listening Settings interactions", () => {
  it("shows default sample acceptance independently of measured/unknown absolute accuracy", async () => {
    await render();
    expect(mode().value).toBe("descriptive");
    expect(limit().value).toBe("64");
    expect(limit().disabled).toBe(false);
    expect(limit().min).toBe("0");
    expect(limit().max).toBe("480");
    expect(limit().step).toBe("1");
    expect(container.textContent).toContain("not physical timing uncertainty");
    expect(container.textContent).toContain("actual observation sample rate");
    expect(container.textContent).toContain(
      "an active pass keeps its starting policy",
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("saves advanced descriptive limits and enforces strict zero with no fallback", async () => {
    await render();
    await changeLimit("480");
    await submit();
    expect(set.mock.calls.at(-1)?.[0].listening).toEqual({
      mode: "descriptive",
      maxClockDisagreementSamples: 480,
    });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "event",
      event: {
        type: "preferences.changed",
        preferences: set.mock.calls.at(-1)?.[0],
      },
    });
    expect(container.textContent).toContain("Settings saved.");
    await choose("strict");
    expect(limit().value).toBe("0");
    expect(limit().disabled).toBe(true);
    await submit();
    expect(set.mock.calls.at(-1)?.[0].listening).toEqual({
      mode: "strict",
      maxClockDisagreementSamples: 0,
    });
    await choose("descriptive");
    expect(limit().value).toBe("64");
    expect(limit().disabled).toBe(false);
  });

  it.each(["-1", "481", "1.5", ""])(
    "guards invalid advanced input %s",
    async (value) => {
      await render();
      await changeLimit(value);
      expect(container.querySelector("form")!.checkValidity()).toBe(false);
      expect(set).not.toHaveBeenCalled();
    },
  );

  it("keeps failed saves retryable without publishing draft policy or exposing raw errors", async () => {
    await render();
    await choose("strict");
    set.mockRejectedValueOnce(
      new Error("synthetic private persistence detail"),
    );
    await submit();
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "could not be",
    );
    expect(container.textContent).not.toContain("synthetic private");
    expect(mode().value).toBe("strict");
    await submit();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("disables duplicate submission while the existing persistence request is pending", async () => {
    let finish: ((value: DesktopPreferences) => void) | undefined;
    set.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await submit();
    const button = container.querySelector<HTMLButtonElement>(
      "button[type=submit]",
    )!;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("Saving settings");
    await act(async () => finish?.(initialState.preferences));
    expect(button.disabled).toBe(false);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not label later unsaved edits as saved", async () => {
    await render();
    await submit();
    expect(container.textContent).toContain("Settings saved.");
    await changeLimit("128");
    expect(container.textContent).not.toContain("Settings saved.");
    expect(set).toHaveBeenCalledOnce();
  });

  it("keeps edits made during persistence unsaved after the older request completes", async () => {
    let finish: ((value: DesktopPreferences) => void) | undefined;
    set.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await submit();
    await changeLimit("128");
    expect(
      container.querySelector<HTMLButtonElement>("button[type=submit]")!
        .disabled,
    ).toBe(true);
    await act(async () => finish?.(initialState.preferences));
    expect(container.textContent).not.toContain("Settings saved.");
    expect(limit().value).toBe("128");
    expect(set.mock.calls[0]?.[0].listening.maxClockDisagreementSamples).toBe(
      64,
    );
    await submit();
    expect(set.mock.calls[1]?.[0].listening.maxClockDisagreementSamples).toBe(
      128,
    );
    expect(container.textContent).toContain("Settings saved.");
  });
});
