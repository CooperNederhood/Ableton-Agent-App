import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const result = JSON.parse(
  await readFile(fixture("arrangement-start-marker-probe.json"), "utf8"),
);

test("the instrumented fractional-marker probe is not native capture acceptance", async () => {
  const source = await readFile(fixture("arrangement-start-marker-probe.py"));
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "a15ab0c5b071280780f432ba649c9c03dd78c49460467653c7d9774e7eb06765",
  );
  assert.equal(result.productionAcceptance, false);
  assert.equal(result.sourceOnset, "unverified");
  assert.equal(result.classification, "instrumented-capability-probe");
  assert.equal(result.requestedStartBeat, 5.25);
  assert.equal(result.events[0].stage, "queued");
  assert.equal(result.events.at(-1).stage, "completed");
  assert.equal(
    result.events.some((event) => event.stage === "failed"),
    false,
  );
  assert.equal(
    result.events.some((event) => "observation" in event.values),
    false,
  );
});

test("independent scheduler reads distinguish the insert marker from stopped position", () => {
  const events = result.events;
  const before = events.find((event) => event.stage === "started").values
    .before;
  assert.equal(before.playing, false);
  assert.equal(before.marker, 128);
  assert.ok(before.position > 800);
  const progress = events.filter((event) => event.stage === "progress");
  const marker = progress.find(
    (event) => event.values.stage === "independent_marker_readback",
  );
  const position = progress.find(
    (event) => event.values.stage === "independent_position_readback",
  );
  const playing = progress.find(
    (event) => event.values.stage === "independent_play_readback",
  );
  assert.deepEqual(marker.values, {
    stage: "independent_marker_readback",
    marker: 5.25,
    position: before.position,
    playing: false,
  });
  assert.deepEqual(position.values, {
    stage: "independent_position_readback",
    marker: 5.25,
    position: 5.25,
    playing: false,
  });
  assert.equal(playing.values.marker, 5.25);
  assert.equal(playing.values.playing, true);
  assert.ok(playing.values.position > 5.25 && playing.values.position < 7.25);
  assert.ok(marker.elapsedMs < position.elapsedMs);
  assert.ok(position.elapsedMs < playing.elapsedMs);
  assert.deepEqual(events.at(-1).values.restored, before);
  const inventory = progress.find(
    (event) => event.values.stage === "property_inventory",
  ).values.properties;
  assert.deepEqual(inventory.file_path, { saved: false });
  for (const field of [
    "is_playing",
    "loop",
    "back_to_arranger",
    "record_mode",
    "session_record",
    "session_automation_record",
    "overdub",
  ])
    assert.deepEqual(inventory[field], { value: false });
});

test("the earlier empty-name denial is retained separately, not relabelled as a pass", async () => {
  const denied = JSON.parse(
    await readFile(
      fixture("arrangement-start-marker-probe-denied.json"),
      "utf8",
    ),
  );
  assert.equal(denied.events.at(-1).stage, "failed");
  assert.equal(
    denied.events.some((event) => event.stage === "started"),
    false,
  );
  assert.equal(
    denied.events.some((event) => event.stage === "completed"),
    false,
  );
  assert.notEqual(denied.events[0].traceId, result.events[0].traceId);
  const inventory = denied.events.find(
    (event) => event.values.stage === "property_inventory",
  ).values.properties;
  assert.deepEqual(inventory.name, { untitled: false, empty: true });
  assert.deepEqual(inventory.file_path, { saved: false });
});

test("probe lifecycle and exact process identity stay bounded and attributed", async () => {
  const process = JSON.parse(
    await readFile(
      fixture("arrangement-start-marker-probe-process.json"),
      "utf8",
    ),
  );
  assert.equal(process.pid, 85822);
  assert.equal(process.runId, "99702c3a-d7af-4fd9-adaa-d4caeea1f500");
  assert.equal(
    process.command,
    `${process.applicationPath}/Contents/MacOS/Live`,
  );
  const trace = result.events[0].traceId;
  const ids = new Set();
  let elapsed = -1;
  for (const event of result.events) {
    assert.equal(event.traceId, trace);
    assert.equal(ids.has(event.eventId), false);
    ids.add(event.eventId);
    assert.ok(event.elapsedMs >= elapsed && event.elapsedMs < 60_000);
    elapsed = event.elapsedMs;
  }
  assert.ok(JSON.stringify(result).length < 16_384);
});
