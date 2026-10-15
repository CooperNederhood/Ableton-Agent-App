/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveNativeProtocolSource } from "./native-protocol-test-loader.mjs";

const parentURL = new URL(
  "../../packages/protocol/src/audio-observation-schemas.ts",
  import.meta.url,
).href;
const context = { parentURL };
const specifier = "./listening-timing-schemas.js";
const requested = new URL(specifier, parentURL).href;
const missing = (url = requested) =>
  Object.assign(new Error("missing source"), {
    code: "ERR_MODULE_NOT_FOUND",
    url,
  });

test("native protocol tests resolve emitted .js imports to actual TS source dependencies", async () => {
  const calls = [];
  const resolved = {
    url: requested.slice(0, -3) + ".ts",
    format: "module-typescript",
  };
  assert.equal(
    resolveNativeProtocolSource(specifier, context, (id, actualContext) => {
      calls.push(id);
      assert.equal(actualContext, context);
      if (id === specifier) throw missing();
      return resolved;
    }),
    resolved,
  );
  assert.deepEqual(calls, [specifier, resolved.url]);
  const { audioObservationV2Schema } =
    await import("../../packages/protocol/src/audio-observation-schemas.ts");
  const { listeningAlignmentQualitySchema } =
    await import("../../packages/protocol/src/listening-timing-schemas.ts");
  assert.equal(
    audioObservationV2Schema.shape.alignment,
    listeningAlignmentQualitySchema,
  );
});

test("existing JS modules and imports outside protocol TS sources retain normal resolution", () => {
  for (const [id, actualContext] of [
    [specifier, context],
    ["zod", context],
    ["node:fs", context],
    ["./listening-timing-schemas.ts", context],
    ["./listening-timing-schemas.js?query", context],
    ["../../shared/src/missing.js", context],
    [specifier, {}],
    [specifier, { parentURL: parentURL.replace(".ts", ".js") }],
    [
      specifier,
      {
        parentURL: parentURL.replace("/protocol/src/", "/protocol/src-other/"),
      },
    ],
    [
      specifier,
      {
        parentURL: new URL("./schema-contract.test.mjs", import.meta.url).href,
      },
    ],
  ]) {
    const calls = [];
    const resolved = { url: "unchanged" };
    assert.equal(
      resolveNativeProtocolSource(
        id,
        actualContext,
        (value, receivedContext) => {
          calls.push(value);
          assert.equal(receivedContext, actualContext);
          return resolved;
        },
      ),
      resolved,
    );
    assert.deepEqual(calls, [id]);
  }
});

test("unrelated resolution failures and missing TS fallbacks are never hidden", () => {
  for (const cause of [
    new Error("loader failed"),
    Object.assign(new Error("denied"), {
      code: "ERR_ACCESS_DENIED",
      url: requested,
    }),
    missing(new URL("./different.js", parentURL).href),
  ]) {
    let calls = 0;
    assert.throws(
      () =>
        resolveNativeProtocolSource(specifier, context, () => {
          calls++;
          throw cause;
        }),
      (actual) => actual === cause,
    );
    assert.equal(calls, 1);
  }
  const missingTS = missing(requested.slice(0, -3) + ".ts");
  const calls = [];
  assert.throws(
    () =>
      resolveNativeProtocolSource(specifier, context, (id) => {
        calls.push(id);
        throw id === specifier ? missing() : missingTS;
      }),
    (actual) => actual === missingTS,
  );
  assert.deepEqual(calls, [specifier, missingTS.url]);
});
