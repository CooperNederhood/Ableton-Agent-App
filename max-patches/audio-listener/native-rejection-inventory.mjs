import { readFileSync } from "node:fs";
import { URL } from "node:url";

export const nativeRejectionCoverage = Object.freeze([
  {
    phase: "preparation",
    owner: "controller",
    methods: ["prepare", "prepareOwned", "checkOwner", "commandScope"],
    evidence: [
      "generation",
      "checkEvidence.rejected",
      "checkEvidence.coverage",
    ],
    tests: ["native-check-evidence.test.mjs", "native-v2.test.mjs"],
  },
  {
    phase: "preflight",
    owner: "controller",
    methods: ["clock", "metadata", "tryPreflight", "deadline", "rejectBracket"],
    evidence: [
      "checkEvidence.operands",
      "checkEvidence.preflightWaits",
      "checkEvidence.acquisition",
      "checkEvidence.readers",
      "checkEvidence.clockCounts",
    ],
    tests: [
      "native-check-evidence.test.mjs",
      "retained-native-controller.test.mjs",
      "native-v2-runtime.test.mjs",
    ],
  },
  {
    phase: "arm",
    owner: "engine",
    methods: ["arm", "acknowledgeNativeArm"],
    evidence: [
      "checkEvidence.lifecycle",
      "checkEvidence.rejected",
      "checkEvidence.geometry",
      "checkEvidence.operands",
    ],
    tests: [
      "native-v2.test.mjs",
      "native-v2-runtime.test.mjs",
      "retained-native-controller.test.mjs",
    ],
  },
  {
    phase: "launch",
    owner: "engine",
    methods: ["tryLaunch", "launchNative", "deadline"],
    evidence: [
      "checkEvidence.launch",
      "checkEvidence.deadlineMs",
      "checkEvidence.operands",
      "checkEvidence.lifecycle",
    ],
    tests: ["native-v2.test.mjs", "native-v2-runtime.test.mjs"],
  },
  {
    phase: "capture",
    owner: "io",
    methods: [
      "begin",
      "arm",
      "configureV2",
      "validNumbers",
      "retainedFrame",
      "retentionEvent",
      "packet",
      "spectrumDiagnostics",
    ],
    evidence: [
      "checkEvidence.io",
      "checkEvidence.readers",
      "readerReason",
      "readerReadbacks",
    ],
    tests: [
      "retained-native-io.test.cjs",
      "native-check-evidence.test.mjs",
      "native-v2-runtime.test.mjs",
    ],
  },
  {
    phase: "capture",
    owner: "assembler",
    methods: ["pushEnvelope", "pushSpectrum", "drain", "reject", "abort"],
    evidence: [
      "checkEvidence.assembler",
      "checkEvidence.operands",
      "checkEvidence.rejected",
    ],
    tests: [
      "native-assembly.test.cjs",
      "retained-native-join.test.mjs",
      "native-v2-authenticated.test.mjs",
    ],
  },
  {
    phase: "capture",
    owner: "engine",
    methods: ["ingest", "finish", "tick", "terminate"],
    evidence: [
      "checkEvidence.operands",
      "checkEvidence.clockCounts",
      "checkEvidence.lastAccepted",
      "checkEvidence.coverage",
    ],
    tests: [
      "native-check-evidence.test.mjs",
      "retained-native-controller.test.mjs",
      "native-v2-runtime.test.mjs",
    ],
  },
  {
    phase: "post-binding",
    owner: "controller",
    methods: [
      "clock",
      "finishRetainedPost",
      "deadline",
      "confirmNativeHostBinding",
    ],
    evidence: [
      "postClockCount",
      "rejectedClock",
      "checkEvidence.operands",
      "checkEvidence.lifecycle",
    ],
    tests: ["retained-native-post.test.mjs", "retained-native-join.test.mjs"],
  },
  {
    phase: "cleanup",
    owner: "controller",
    methods: ["close", "disarmed", "release", "stop", "envelope"],
    evidence: [
      "checkEvidence.eventId",
      "cleanup.confirmed",
      "cleanup.elapsedMs",
      "cleanup.deadlineMs",
      "cleanup.io",
    ],
    tests: ["native-v2-runtime.test.mjs", "retained-native-io.test.cjs"],
  },
  {
    phase: "publication",
    owner: "sdk",
    methods: ["publishNative", "sendListenerMessage", "listenerFailure"],
    evidence: [
      "checkEvidence.sdk",
      "checkEvidence.coverage",
      "checkEvidence.eventId",
    ],
    tests: [
      "native-v2-runtime.test.mjs",
      "native-v2-authenticated.test.mjs",
      "native-session-authenticated.test.mjs",
    ],
  },
]);

export function nativeRejectionGuardInventory() {
  const files = [
    ["controller", "audio_listener_native_controller.js"],
    ["engine", "audio_listener_engine.js"],
    ["assembler", "audio_listener_native_assembler.js"],
    ["io", "audio_listener_native_io.js"],
    ["sdk", "../shared/agent_signal_client.js"],
  ];
  return files.flatMap(([owner, file]) => {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    const sites = [];
    const guard =
      /(?:throw new Error\(|this\.(?:reject|abort|fail|terminate|listenerFailure)\()\s*["']([a-z][a-z0-9_-]*)["']/g;
    for (const match of text.matchAll(guard)) {
      const prefix = text.slice(0, match.index);
      sites.push({
        owner,
        file,
        line: prefix.split("\n").length,
        check: match[1],
        carrier: "nativeFailureDiagnostic",
        missingEvidence: "checkEvidence.coverage.unavailable",
      });
    }
    return sites;
  });
}
