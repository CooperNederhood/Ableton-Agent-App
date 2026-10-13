/* global module, require */
// Installed devices carry the common module beside this compatibility entry point.
let common;
try {
  common = require("./agent_signal_client_common.js");
} catch (error) {
  if (
    error.code !== "MODULE_NOT_FOUND" ||
    !String(error.message).includes("./agent_signal_client_common.js")
  )
    throw error;
  common = require("../shared/agent_signal_client.js");
}
module.exports = common;
