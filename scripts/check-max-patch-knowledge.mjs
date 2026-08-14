import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ".github/agents/max-patch-creator.md",
  ".github/skills/patch-database/SKILL.md",
  ".github/skills/debug-raw-amxd/SKILL.md",
  ".github/skills/document-learnings/SKILL.md",
];
const errors = [];

for (const path of files) {
  const absolutePath = join(repoRoot, path);
  if (!existsSync(absolutePath)) {
    errors.push(`Missing required adapter: ${path}`);
    continue;
  }

  const content = readFileSync(absolutePath, "utf8");
  if (!content.includes("MAX4LIVE_MCP_ROOT")) {
    errors.push(`${path} does not reference MAX4LIVE_MCP_ROOT`);
  }
  if (/(^|[\s"'`(])max_knowledge\//m.test(content)) {
    errors.push(
      `${path} contains a knowledge path not rooted at MAX4LIVE_MCP_ROOT`,
    );
  }
  if (
    /(^|[\s"'`(])\.github\/skills\/(?:patch-database\/patch_db|debug-raw-amxd\/amxd_debug)\.py/m.test(
      content,
    )
  ) {
    errors.push(
      `${path} contains a helper path not rooted at MAX4LIVE_MCP_ROOT`,
    );
  }
  if (/(^|[\s"'`(])scripts\/ingest_learning\.py/m.test(content)) {
    errors.push(`${path} contains a bare ingest_learning.py path`);
  }
}

const patchDocs = files
  .filter(
    (path) =>
      path.includes("max-patch-creator") || path.includes("patch-database"),
  )
  .map((path) => [path, readFileSync(join(repoRoot, path), "utf8")]);

for (const [path, content] of patchDocs) {
  for (const line of content.split("\n")) {
    if (
      line.includes('python3 "$PATCH_DB"') &&
      !line.includes('--db "$KNOWLEDGE_DB"')
    ) {
      errors.push(
        `${path} has a patch database command without an explicit --db`,
      );
    }
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const skillsRoot = join(repoRoot, ".github", "skills");
for (const path of walk(skillsRoot)) {
  const extension = extname(path);
  if (extension === ".py" || extension === ".db") {
    errors.push(
      `Canonical implementation/data must not be copied here: ${relative(repoRoot, path)}`,
    );
  }
}

if (existsSync(join(repoRoot, "max_knowledge"))) {
  errors.push(
    "Canonical max_knowledge must not be copied into ableton-agent-app",
  );
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Max Patch Creator knowledge adapters are correctly rooted.");
}
