/* global __dirname, process */
const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");

module.exports = async function beforePack() {
  const root = resolve(__dirname, "../../..");
  execFileSync(
    process.execPath,
    [resolve(root, "scripts/build-ableton-integrations.mjs")],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
};
