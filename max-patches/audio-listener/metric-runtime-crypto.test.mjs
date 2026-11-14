import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("./audio_listener_metric_runtime.js", import.meta.url),
  "utf8",
);

test("Node for Max without global WebCrypto or TextEncoder uses real built-in SHA256", async () => {
  const context = { module: { exports: {} }, require };
  runInNewContext(source, context);
  assert.equal(context.crypto, undefined);
  assert.equal(context.TextEncoder, undefined);
  context.module.exports.ensureMetricStreamCrypto();
  const digest = await context.crypto.subtle.digest(
    "SHA-256",
    new context.TextEncoder().encode("abc"),
  );
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const provider = context.crypto;
  context.module.exports.ensureMetricStreamCrypto();
  assert.equal(context.crypto, provider);
});

test("unavailable built-in crypto fails explicitly rather than skipping hashes", () => {
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === "node:crypto") return {};
      return require(name);
    },
  };
  runInNewContext(source, context);
  assert.throws(
    () => context.module.exports.ensureMetricStreamCrypto(),
    /metric_stream_crypto_unavailable/,
  );
});
