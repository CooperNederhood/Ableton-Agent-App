import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

function breakingChanges(previous, current) {
  const breaking = [];
  for (const [name, definition] of Object.entries(previous.envelopes)) {
    if (
      JSON.stringify(current.envelopes[name]) !== JSON.stringify(definition)
    ) {
      breaking.push(`envelope ${name}`);
    }
  }
  for (const [name, definition] of Object.entries(previous.commands)) {
    if (JSON.stringify(current.commands[name]) !== JSON.stringify(definition)) {
      breaking.push(`command ${name}`);
    }
  }
  return breaking;
}

const baseRef = process.argv[2];
if (!baseRef) {
  console.error(
    "Usage: node scripts/check-protocol-compatibility.mjs <git-ref>",
  );
  process.exit(2);
}

const contractPath = "packages/protocol/contracts/protocol.schema.json";
const current = JSON.parse(await readFile(contractPath, "utf8"));
const baselinePath = execFileSync(
  "git",
  ["ls-tree", "--name-only", baseRef, "--", contractPath],
  { encoding: "utf8" },
).trim();
if (baselinePath === "") {
  console.log(
    `No protocol contract exists at ${baseRef}; compatibility check skipped.`,
  );
  process.exit(0);
}
const previous = JSON.parse(
  execFileSync("git", ["show", `${baseRef}:${contractPath}`], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }),
);

if (current.protocolVersion > previous.protocolVersion) {
  console.log(
    `Protocol version increased from ${previous.protocolVersion} to ${current.protocolVersion}.`,
  );
  process.exit(0);
}
if (current.protocolVersion !== previous.protocolVersion) {
  throw new Error(
    `Protocol version moved backward from ${previous.protocolVersion} to ${current.protocolVersion}.`,
  );
}

const breaking = breakingChanges(previous, current);
if (breaking.length > 0) {
  throw new Error(
    `Breaking protocol changes require a protocol-version bump: ${breaking.join(", ")}`,
  );
}
console.log(
  `Protocol ${current.protocolVersion} preserves all envelopes and existing commands from ${baseRef}.`,
);
