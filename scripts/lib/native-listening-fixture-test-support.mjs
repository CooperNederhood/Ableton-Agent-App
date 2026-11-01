import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";

const hash = (value) => createHash("sha256").update(value).digest("hex");

// The caller owns these roots and disposes them after runner shutdown.
export async function disposeNativeFixtureRoots(roots) {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

export async function nativeFixtureInput(roots, { nativeVersion = 1 } = {}) {
  const root = resolve(".test-artifacts", `native-unit-${randomUUID()}`);
  roots.push(root);
  const directory = join(root, "Native-Listener-Candidate");
  await mkdir(directory, { recursive: true });
  const device = Buffer.from(
    "test-only native candidate, never loaded in Live",
  );
  const resource = Buffer.from("test-only code");
  const manifest = JSON.stringify({
    nativeMode: true,
    nativeScope:
      nativeVersion === 4
        ? "mode-negotiated-transport/v1"
        : nativeVersion === 3
          ? "session-transport-coupled/v1"
          : nativeVersion === 2
            ? "arrangement-descriptive/v2"
            : "arrangement-beat0-120bpm-48000hz-vector64/v1",
    ...(nativeVersion >= 2
      ? {
          nativeVersion,
          ...(nativeVersion === 4
            ? {
                nativeAbiVersion: 2,
                supportedModes: ["arrangement", "session"],
                modeNegotiation: "explicit-per-pass",
              }
            : {}),
          ...(nativeVersion === 3
            ? {
                nativeAbiVersion: 2,
                sourceEvidence: "expected-context-only",
                synchronization: "transport-coupled-first-iteration",
                maxDurationBeats: 4,
              }
            : {}),
          algorithmVersion: "2.0.0",
          observationSchema: "audio-observation/v2",
          providerLimits: { durationMs: 30000, maxWindows: 300 },
          tempoPolicy: "constant-tempo-assumed",
          tempoAutomationSupported: false,
        }
      : {}),
    realLiveValidated: false,
    deviceFile: "Candidate.amxd",
    deviceSha256: hash(device),
    externalAuthoringBridge: false,
    resources: [
      { name: "engine.js", sha256: hash(resource), bytes: resource.length },
    ],
  });
  await writeFile(join(directory, "Candidate.amxd"), device);
  await writeFile(join(directory, "engine.js"), resource);
  await writeFile(join(directory, "audio-listener-manifest.json"), manifest);
  await writeFile(
    join(directory, "agent_signal_storage.js"),
    "test-only old discovery, never executed",
  );
  const source = gzipSync(
    `<Ableton MajorVersion="5"><FileRef><RelativePathType Value="3" /><RelativePath Value="Native-Listener-Candidate/Candidate.amxd" /><Path Value="${directory}/Candidate.amxd" /></FileRef></Ableton>`,
  );
  const sourceSet = join(root, "Source.als");
  await writeFile(sourceSet, source);
  const input = {
    formatVersion: 1,
    ...(nativeVersion >= 2 ? { nativeVersion } : {}),
    sourceSet,
    sourceSetSha256: hash(source),
    candidateDirectory: directory,
    candidateManifestSha256: hash(manifest),
    deviceFile: "Candidate.amxd",
    deviceSha256: hash(device),
    audioFiles: [],
    artifactPrefix: "AA_SMOKE_NATIVE_TEST",
    canonicalPath: "live_set tracks 0 devices 0",
    trackName: "Fixture",
    deviceName: "Candidate",
  };
  const storage = resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(root, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
    },
  });
  return {
    root,
    input,
    storage,
    source,
    nativeVersion,
    destination: join(root, "copied-set"),
  };
}
