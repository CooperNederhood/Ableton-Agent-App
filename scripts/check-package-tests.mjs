import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(target)));
    else result.push(target);
  }
  return result;
}

const workspaces = [
  ...(await directories("packages")),
  ...(await directories("apps")),
];
const missing = [];
for (const workspace of workspaces) {
  const packageDocument = JSON.parse(
    await readFile(join(workspace, "package.json"), "utf8"),
  );
  if (packageDocument.abletonAgent?.testOwnership === "type-only") continue;
  const source = join(workspace, "src");
  if (!(await stat(source).catch(() => undefined))?.isDirectory()) continue;
  const tests = (await files(source)).filter((path) =>
    /\.test\.[cm]?[jt]sx?$/u.test(path),
  );
  if (tests.length === 0) missing.push(workspace);
}
if (missing.length > 0) {
  throw new Error(
    `Every application-owned workspace requires unit tests. Missing: ${missing.join(", ")}`,
  );
}
console.log(
  `Validated package-level test ownership for ${workspaces.length} workspaces.`,
);
