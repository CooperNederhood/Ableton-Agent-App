/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build, checkArtifact, ALL_RESOURCES, PROFILE_CONFIGURATION, SOURCE_DIRECTORY } from "../../scripts/audio-listener-device.mjs";

// Each child loads only the staged companions and the REAL shared reader.
// No Max/Live process, sockets, descriptor reads, or secret-content reads occur.
const STARTUP = `
const { AgentSignalClient } = require("./agent_signal_client_common.js");
const { createRuntime } = require("./audio_listener_runtime.js");
const handlers = {}, output = [], created = [];
class OfflineClient extends AgentSignalClient {
  constructor(options) {
    super({...options,
      readText: async () => { throw new Error("unexpected discovery/credential I/O"); },
      createConnection: () => { throw new Error("unexpected network connection"); }});
    created.push(this);
  }
  start() { this.started = true; }
}
const runtime = createRuntime({
  maxApi: { addHandler(name,fn) { handlers[name]=fn; }, outlet(...args) { output.push(args); } },
  Client: OfflineClient, env: JSON.parse(process.argv[2]), clock: () => 0,
  interval: () => 1, clear() {}
});
handlers.identity(JSON.stringify({canonicalPath:"live_set tracks 0 devices 0",
  track:{id:"1",name:"fixture"},device:{id:"2",name:"Audio-Listener"}}));
handlers.dsp(1,48000,64); handlers.host(0,4,10000,3);
let readiness = null;
if (runtime.engine) {
  try { runtime.engine.prepare({passId:"pass",connectionEpoch:"epoch",startBeat:4,endBeat:8}); }
  catch (error) { readiness = error.message; }
}
const result = {readerAvailable:typeof AgentSignalClient === "function" &&
  typeof require("./agent_signal_client_common.js").installedDiscoveryPaths === "function",
  started:created.length,descriptorPath:runtime.client?.descriptorPath,
  secretPath:runtime.client?.secretPath,legacyDiscovery:runtime.client?.legacyDiscovery,
  deviceCanonicalPath:runtime.client?.listener?.deviceCanonicalPath,
  trackCanonicalPath:runtime.client?.listener?.trackCanonicalPath,
  nativeStatus:runtime.client?.listener?.nativeStatus,
  readiness,diagnostics:output.filter(v=>v[0]==="diagnostic").map(v=>v[1]),
  analysisOff:output.some(v=>v[0]==="analysis" && v[1]===0 && v[2]===1)};
runtime.stop();
console.log(JSON.stringify(result));
`;

async function staging(configured, action) {
  const directory = await mkdtemp(join(SOURCE_DIRECTORY, ".profile-test-"));
  const storage = {
    signalIngressDescriptorPath: join(directory, "profile", "state", "signal-ingress.json"),
    signalIngressSecretPath: join(directory, "profile", "credentials", "signal-ingress-secret.json"),
  };
  try {
    const manifest = await build(directory, configured ? { discoveryStorage: storage } : {});
    await action(directory, storage, manifest);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function startup(directory, env = {}) {
  const run = spawnSync(process.execPath, ["-e", STARTUP, directory, JSON.stringify(env)],
    { cwd: directory, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.readerAvailable, true, "shared installedDiscoveryPaths export must be implemented");
  return result;
}

test("isolated artifact consumes shared generated profile configuration without env overrides", async () => {
  await staging(true, async (directory, storage, manifest) => {
    assert.equal(manifest.discoveryConfigured, true);
    assert.deepEqual(manifest.resources.map(r => r.name), [...ALL_RESOURCES, PROFILE_CONFIGURATION]);
    assert.equal(manifest.resources.at(-1).scope, "profile");
    await checkArtifact(directory);
    const configPath = join(directory, PROFILE_CONFIGURATION);
    if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o077, 0);
    const result = startup(directory);
    assert.equal(result.started, 1);
    assert.equal(result.descriptorPath, storage.signalIngressDescriptorPath);
    assert.equal(result.secretPath, storage.signalIngressSecretPath);
    assert.equal(result.legacyDiscovery, false);
    assert.equal(result.deviceCanonicalPath, "live_set tracks 0 devices 0");
    assert.equal(result.trackCanonicalPath, "live_set tracks 0");
    assert.deepEqual(result.nativeStatus, { version: 1, timing: "UNVERIFIED",
      readiness: "BLOCKED", reason: "real_live_timing_validation_required" });
    assert.equal(result.readiness, "real_live_timing_validation_required");
    assert.equal(result.analysisOff, true);
    assert.deepEqual(result.diagnostics, []);
    const saved = await readFile(configPath);
    await rm(configPath);
    await assert.rejects(() => checkArtifact(directory), /ENOENT/);
    await writeFile(configPath, saved);
    await writeFile(configPath, `${saved.toString("utf8")}\n// changed\n`);
    await assert.rejects(() => checkArtifact(directory), /hash mismatch/);
  });
});
test("missing installed configuration fails explicitly; no MIDI legacy profile fallback", async () => {
  await staging(false, async directory => {
    const result = startup(directory);
    assert.equal(result.started, 0);
    assert.equal(result.readiness, null);
    assert.ok(result.diagnostics.includes("explicit_profile_discovery_required"));
    assert.equal(result.analysisOff, true);
  });
});
test("malformed installed config fails closed, even with otherwise valid full env overrides", async () => {
  await staging(true, async directory => {
    for (const text of [
      "module.exports = {",
      'module.exports = {version:2,descriptorPath:"/profile/descriptor",secretPath:"/profile/secret"};',
      'module.exports = {version:1,descriptorPath:"relative",secretPath:"/profile/secret"};',
      'module.exports = {version:1,descriptorPath:"/profile/descriptor"};',
    ]) {
      await writeFile(join(directory, PROFILE_CONFIGURATION), text);
      for (const env of [{}, {
        ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: join(directory, "override", "descriptor.json"),
        ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: join(directory, "override", "secret.json"),
      }]) {
        const result = startup(directory, env);
        assert.equal(result.started, 0);
        assert.ok(result.diagnostics.includes("invalid_installed_profile_configuration"));
        assert.equal(result.analysisOff, true);
      }
    }
  });
});
test("absolute env overrides win; partial overrides merge with validated installed config", async () => {
  await staging(true, async (directory, storage) => {
    const descriptor = join(directory, "override", "descriptor.json");
    const secret = join(directory, "override", "secret.json");
    const full = startup(directory, { ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: descriptor,
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: secret });
    assert.equal(full.started, 1);
    assert.equal(full.descriptorPath, descriptor); assert.equal(full.secretPath, secret);
    assert.equal(full.readiness, "real_live_timing_validation_required");
    const descriptorOnly = startup(directory, { ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: descriptor });
    assert.equal(descriptorOnly.started, 1);
    assert.equal(descriptorOnly.descriptorPath, descriptor);
    assert.equal(descriptorOnly.secretPath, storage.signalIngressSecretPath);
    const secretOnly = startup(directory, { ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: secret });
    assert.equal(secretOnly.started, 1);
    assert.equal(secretOnly.descriptorPath, storage.signalIngressDescriptorPath);
    assert.equal(secretOnly.secretPath, secret);
  });
});
test("malformed explicit overrides never silently fall back to a valid installed profile", async () => {
  await staging(true, async directory => {
    for (const env of [
      { ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "relative" },
      { ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "" },
      { ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "relative" },
      { ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "" },
    ]) {
      const result = startup(directory, env);
      assert.equal(result.started, 0);
      assert.ok(result.diagnostics.includes("explicit_profile_discovery_required"));
      assert.equal(result.analysisOff, true);
    }
  });
});
test("complete absolute env overrides still work without installed configuration", async () => {
  await staging(false, async directory => {
    const result = startup(directory, {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: join(directory, "override", "descriptor.json"),
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: join(directory, "override", "secret.json"),
    });
    assert.equal(result.started, 1);
    assert.equal(result.readiness, "real_live_timing_validation_required");
  });
});
