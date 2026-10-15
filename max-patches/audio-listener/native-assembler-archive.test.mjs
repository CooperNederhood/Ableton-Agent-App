/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { ARCHIVED_NATIVE_ASSEMBLER } from "./native-assembler-archive.mjs";

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
