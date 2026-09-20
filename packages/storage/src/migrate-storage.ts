#!/usr/bin/env node

import { runMigrationCli } from "./migrate-cli.js";

process.exitCode = await runMigrationCli(process.argv.slice(2), process.env, {
  write: (text) => process.stdout.write(`${text}\n`),
  writeError: (text) => process.stderr.write(`${text}\n`),
});
