import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const docsRoot = join(root, "docs");

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? markdownFiles(path)
        : Promise.resolve(extname(entry.name) === ".md" ? [path] : []);
    }),
  );
  return nested.flat();
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const files = await markdownFiles(docsRoot);
const failures = [];

for (const path of files) {
  const relativePath = relative(docsRoot, path);
  const segments = relativePath.split("/");
  if (
    segments.length === 2 &&
    !relativePath.endsWith("-implementation-to-do.md")
  ) {
    const expected = path.replace(/\.md$/u, "-implementation-to-do.md");
    if (!(await exists(expected))) {
      failures.push(
        `${relativePath}: missing paired plan ${relative(docsRoot, expected)}`,
      );
    }
  }

  const content = await readFile(path, "utf8");
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1]?.trim();
    if (
      target === undefined ||
      target === "" ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(target)
    ) {
      continue;
    }
    const fileTarget = decodeURIComponent(target.split(/[?#]/u, 1)[0] ?? "");
    if (fileTarget === "") continue;
    const resolved = resolve(dirname(path), fileTarget);
    if (!(await exists(resolved))) {
      failures.push(`${relativePath}: broken local link ${target}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Documentation validation failed:\n${failures.join("\n")}`);
}

process.stdout.write(
  `Validated ${files.length} documentation files and paired plans.\n`,
);
