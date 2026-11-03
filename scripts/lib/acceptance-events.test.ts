import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { AcceptanceEvents } from "../../tests/electron/acceptance-events.js";

describe("bounded acceptance event collection", () => {
  it("attaches and detaches through serialized callbacks using the actual CLI transpiler", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { tsImport } from "tsx/esm/api";
      import vm from "node:vm";
      import { resolve } from "node:path";
      const { AcceptanceEvents } = await tsImport("./tests/electron/acceptance-events.ts", {
        parentURL: import.meta.url, tsconfig: resolve("tsconfig.test-runtime.json")
      });
      let stopped = false;
      const window = { desktop: { events: { subscribe(callback) {
        callback({type:"lifecycle.changed",state:"ready"});
        return () => { stopped = true; };
      } } } };
      const page = {
        exposeFunction: async (name, callback) => { window[name] = callback; },
        evaluate: async (callback, arg) => vm.runInNewContext("(" + callback.toString() + ")(arg)", {window, arg}),
        isClosed: () => false
      };
      const events = new AcceptanceEvents();
      const stop = await events.attach(page);
      await stop();
      if (!stopped || events.read().length !== 1) throw Error("Incomplete subscription lifecycle");
    `,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });
  it("preserves order and does not infer a turn from unrelated events", () => {
    const events = new AcceptanceEvents();
    events.receive({ type: "lifecycle.changed", state: "ready" });
    events.receive({
      type: "agent.message_complete",
      messageId: "other",
      content: "(B)",
    });
    expect(events.read().map(({ type }) => type)).toEqual([
      "lifecycle.changed",
      "agent.message_complete",
    ]);
  });
  it("fails explicitly on malformed data", () => {
    const events = new AcceptanceEvents();
    events.receive({ type: "made-up.event" });
    expect(() => events.read()).toThrow();
  });
  it("never silently truncates required event evidence", () => {
    const events = new AcceptanceEvents(1);
    events.receive({ type: "lifecycle.changed", state: "ready" });
    events.receive({ type: "lifecycle.changed", state: "ready" });
    expect(() => events.read()).toThrow("exceeded");
    const bytes = new AcceptanceEvents(10, 1);
    bytes.receive({ type: "lifecycle.changed", state: "ready" });
    expect(() => bytes.read()).toThrow("exceeded");
  });
});
