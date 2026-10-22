/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  ARCHIVED_NATIVE_ASSEMBLER,
  ARCHIVED_NATIVE_V1_SOURCES,
  historicalNativeSourceURL,
} from "./native-assembler-archive.mjs";

const require = createRequire(import.meta.url);
const controller = require("./fixtures/native-controller-capture.json");
const sdk = require("./fixtures/native-sdk-capture.json");
const sourceHash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("bounded archived assembler bytes retain source commit/path provenance and both unchanged historical manifest hashes", async () => {
  const bytes = await readFile(new URL(ARCHIVED_NATIVE_ASSEMBLER.fixtureURL));
  assert.equal(
    ARCHIVED_NATIVE_ASSEMBLER.sourceCommit,
    "0a0159882589333640144769e502ecc135803279",
  );
  assert.equal(
    ARCHIVED_NATIVE_ASSEMBLER.sourcePath,
    "max-patches/audio-listener/audio_listener_native_assembler.js",
  );
  assert.equal(bytes.length, ARCHIVED_NATIVE_ASSEMBLER.bytes);
  assert(bytes.length <= 16384);
  assert.equal(sourceHash(bytes), ARCHIVED_NATIVE_ASSEMBLER.sha256);
  for (const evidence of [controller, sdk]) {
    assert.equal(
      sourceHash(bytes),
      evidence.codeSha256["audio_listener_native_assembler.js"],
    );
    assert.equal(evidence.calibrationOnly, true);
    assert.equal(evidence.productionReady, false);
  }
  assert.notEqual(
    sourceHash(bytes),
    sourceHash(
      await readFile(
        new URL("./audio_listener_native_assembler.js", import.meta.url),
      ),
    ),
  );
});

test("archived pre-v2 native CJS blobs retain exact foundation commit provenance without qualifying current runtime", async () => {
  assert.equal(
    ARCHIVED_NATIVE_V1_SOURCES.sourceCommit,
    "6cceef606aa3d557853db3795303006f22f6acbc",
  );
  const revisions = require("./fixtures/native-acquisition-recovery.json");
  let total = 0;
  for (const [name, expected] of Object.entries(
    ARCHIVED_NATIVE_V1_SOURCES.sha256,
  )) {
    const bytes = await readFile(historicalNativeSourceURL(name));
    total += bytes.length;
    assert.equal(sourceHash(bytes), expected);
    const revision = revisions.currentSourceSnapshot[name];
    assert.equal(
      expected,
      revision?.sha256 ??
        controller.codeSha256[name] ??
        sdk.sdkCodeSha256[name],
    );
  }
  assert(total <= 150000);
});
