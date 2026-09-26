import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { parseDocument, stringify } from "yaml";

import {
  agentDefinitionNameSchema,
  agentDefinitionSchema,
  currentAgentDefinitionSchema,
  type AgentDefinition,
  skillMetadataSchema,
  skillNameSchema,
  type SkillMetadata,
} from "./schemas.js";

const maximumAgentBytes = 256 * 1024;
const maximumSkillBytes = 512 * 1024;

export type MutableArtifactKind = "agent" | "skill";

export interface ArtifactComparison {
  readonly equal: boolean;
  readonly leftFingerprint: string;
  readonly rightFingerprint: string;
}

export interface ArtifactTombstones {
  readonly version: 1;
  readonly revision: number;
  readonly names: readonly string[];
}

function fingerprint(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Expected a regular file at '${path}'`);
  }
  if (details.size > maximumBytes) {
    throw new Error(`File exceeds ${maximumBytes} bytes`);
  }
  return readFile(path);
}

async function assertPhysicalDirectory(path: string): Promise<void> {
  if (!isAbsolute(path))
    throw new Error("Artifact directories must be absolute");
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Expected a physical directory at '${path}'`);
  }
  if ((await realpath(path)) !== resolve(path)) {
    throw new Error(
      `Artifact directory contains a symbolic-link ancestor: '${path}'`,
    );
  }
  await assertNoSymlinks(path);
}

async function assertNoSymlinks(
  path: string,
  remainingEntries: { value: number } = { value: 4_096 },
): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    remainingEntries.value -= 1;
    if (remainingEntries.value < 0) {
      throw new Error("Artifact directory exceeds 4096 entries");
    }
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in '${path}'`);
    }
    if (entry.isDirectory()) await assertNoSymlinks(child, remainingEntries);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertWithin(root: string, path: string): void {
  const child = relative(root, path);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Artifact path resolves outside '${root}'`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertPhysicalDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function findAgent(
  agentsDirectory: string,
  name: string,
): Promise<string | undefined> {
  agentDefinitionNameSchema.parse(name);
  await assertPhysicalDirectory(agentsDirectory);
  for (const entry of await readdir(agentsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || ![".yaml", ".yml"].includes(extname(entry.name)))
      continue;
    const path = join(agentsDirectory, entry.name);
    const document = parseDocument(
      (await readRegularFile(path, maximumAgentBytes)).toString("utf8"),
      { customTags: [] },
    );
    if (document.errors.length > 0) continue;
    const definition = agentDefinitionSchema.safeParse(
      document.toJS({ maxAliasCount: 0 }),
    );
    if (definition.success && definition.data.name === name) return path;
  }
  return undefined;
}

async function findSkill(
  skillsDirectory: string,
  name: string,
): Promise<string | undefined> {
  skillNameSchema.parse(name);
  await assertPhysicalDirectory(skillsDirectory);
  for (const entry of await readdir(skillsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsDirectory, entry.name, "SKILL.md");
    try {
      const content = (await readRegularFile(path, maximumSkillBytes)).toString(
        "utf8",
      );
      const end = content.replace(/\r\n/gu, "\n").indexOf("\n---\n", 4);
      if (!content.startsWith("---\n") || end < 0) continue;
      const metadata = parseDocument(content.slice(4, end), {
        customTags: [],
      }).toJS({ maxAliasCount: 0 }) as { name?: unknown };
      if (metadata.name === name) return dirname(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function artifactPath(
  kind: MutableArtifactKind,
  directory: string,
  name: string,
): Promise<string | undefined> {
  return kind === "agent"
    ? findAgent(directory, name)
    : findSkill(directory, name);
}

export async function resolveArtifactPathInScope(options: {
  kind: MutableArtifactKind;
  directory: string;
  name: string;
}): Promise<string | undefined> {
  return artifactPath(options.kind, options.directory, options.name);
}

async function hashArtifact(
  kind: MutableArtifactKind,
  path: string,
): Promise<string> {
  if (kind === "agent") {
    return fingerprint(await readRegularFile(path, maximumAgentBytes));
  }
  await assertPhysicalDirectory(path);
  const hash = createHash("sha256");
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(directory, entry.name);
      const relativePath = relative(path, child);
      hash.update(relativePath);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        const content = await readRegularFile(child, maximumSkillBytes);
        totalBytes += content.byteLength;
        if (totalBytes > 2 * 1024 * 1024) {
          throw new Error("Skill artifact exceeds 2097152 bytes");
        }
        hash.update(content);
      }
    }
  };
  await visit(path);
  return hash.digest("hex");
}

export async function compareArtifacts(options: {
  readonly kind: MutableArtifactKind;
  readonly leftPath: string;
  readonly rightPath: string;
}): Promise<ArtifactComparison> {
  const leftFingerprint = await hashArtifact(options.kind, options.leftPath);
  const rightFingerprint = await hashArtifact(options.kind, options.rightPath);
  return {
    equal: leftFingerprint === rightFingerprint,
    leftFingerprint,
    rightFingerprint,
  };
}

export async function copyArtifact(options: {
  readonly kind: MutableArtifactKind;
  readonly name: string;
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
}): Promise<string> {
  await Promise.all([
    assertPhysicalDirectory(options.sourceDirectory),
    assertPhysicalDirectory(options.destinationDirectory),
  ]);
  const source = await artifactPath(
    options.kind,
    options.sourceDirectory,
    options.name,
  );
  if (source === undefined)
    throw new Error(`Artifact '${options.name}' does not exist`);
  if (
    (await artifactPath(
      options.kind,
      options.destinationDirectory,
      options.name,
    )) !== undefined
  ) {
    throw new Error(`Artifact '${options.name}' already exists`);
  }
  const destination =
    options.kind === "agent"
      ? join(options.destinationDirectory, `${options.name}.yaml`)
      : join(options.destinationDirectory, options.name);
  assertWithin(options.destinationDirectory, destination);
  if (await pathExists(destination)) {
    throw new Error(`Artifact destination '${destination}' already exists`);
  }
  const staged = `${destination}.${randomUUID()}.staged`;
  try {
    if (options.kind === "agent") {
      await writeFile(
        staged,
        await readRegularFile(source, maximumAgentBytes),
        { mode: 0o600, flag: "wx" },
      );
    } else {
      await cp(source, staged, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    await rename(staged, destination);
    return destination;
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

export async function moveArtifact(
  options: Parameters<typeof copyArtifact>[0],
): Promise<string> {
  const source = await artifactPath(
    options.kind,
    options.sourceDirectory,
    options.name,
  );
  const destination = await copyArtifact(options);
  try {
    await rm(source as string, { recursive: options.kind === "skill" });
    return destination;
  } catch (error) {
    await rm(destination, { recursive: options.kind === "skill", force: true });
    throw error;
  }
}

function renameSkillContent(content: string, replacementName: string): string {
  const normalized = content.replace(/\r\n/gu, "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (!normalized.startsWith("---\n") || end < 0) {
    throw new Error("SKILL.md must contain YAML frontmatter");
  }
  const document = parseDocument(normalized.slice(4, end), { customTags: [] });
  if (document.errors.length > 0)
    throw new Error("SKILL.md frontmatter is invalid");
  document.set("name", replacementName);
  return `---\n${document.toString().trimEnd()}\n---\n${normalized.slice(end + 5)}`;
}

export async function renameSkillInScope(options: {
  readonly agentsDirectory: string;
  readonly skillsDirectory: string;
  readonly currentName: string;
  readonly replacementName: string;
}): Promise<void> {
  skillNameSchema.parse(options.currentName);
  skillNameSchema.parse(options.replacementName);
  await Promise.all([
    assertPhysicalDirectory(options.agentsDirectory),
    assertPhysicalDirectory(options.skillsDirectory),
  ]);
  const source = await findSkill(options.skillsDirectory, options.currentName);
  if (source === undefined) {
    throw new Error(`Skill '${options.currentName}' does not exist`);
  }
  if (
    (await findSkill(options.skillsDirectory, options.replacementName)) !==
    undefined
  ) {
    throw new Error(`Skill '${options.replacementName}' already exists`);
  }
  const destination = join(options.skillsDirectory, options.replacementName);
  assertWithin(options.skillsDirectory, destination);
  if (await pathExists(destination)) {
    throw new Error(
      `Skill destination '${options.replacementName}' already exists`,
    );
  }
  const stagedSkill = `${destination}.${randomUUID()}.staged`;
  const stagedAgents: Array<{ path: string; staged: string; backup: string }> =
    [];
  try {
    await cp(source, stagedSkill, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const skillPath = join(stagedSkill, "SKILL.md");
    await atomicWrite(
      skillPath,
      renameSkillContent(
        (await readRegularFile(skillPath, maximumSkillBytes)).toString("utf8"),
        options.replacementName,
      ),
    );
    for (const entry of await readdir(options.agentsDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || ![".yaml", ".yml"].includes(extname(entry.name)))
        continue;
      const path = join(options.agentsDirectory, entry.name);
      const content = (await readRegularFile(path, maximumAgentBytes)).toString(
        "utf8",
      );
      const document = parseDocument(content, { customTags: [] });
      const definition = agentDefinitionSchema.safeParse(
        document.toJS({ maxAliasCount: 0 }),
      );
      if (
        !definition.success ||
        !definition.data.skills.includes(options.currentName)
      ) {
        continue;
      }
      document.set(
        "skills",
        definition.data.skills.map((name) =>
          name === options.currentName ? options.replacementName : name,
        ),
      );
      const staged = `${path}.${randomUUID()}.staged`;
      await writeFile(staged, document.toString(), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      stagedAgents.push({
        path,
        staged,
        backup: `${path}.${randomUUID()}.backup`,
      });
    }
    await rename(stagedSkill, destination);
    for (const agent of stagedAgents) {
      await rename(agent.path, agent.backup);
      await rename(agent.staged, agent.path);
    }
    await rm(source, { recursive: true });
    await Promise.all(
      stagedAgents.map(({ backup }) => rm(backup, { force: true })),
    );
  } catch (error) {
    await rm(stagedSkill, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
    for (const agent of stagedAgents) {
      await rm(agent.staged, { force: true });
      try {
        await rename(agent.backup, agent.path);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== "ENOENT")
          throw restoreError;
      }
    }
    throw error;
  }
}

export async function renameAgentInScope(options: {
  readonly agentsDirectory: string;
  readonly currentName: string;
  readonly replacementName: string;
}): Promise<string> {
  agentDefinitionNameSchema.parse(options.currentName);
  agentDefinitionNameSchema.parse(options.replacementName);
  const source = await findAgent(options.agentsDirectory, options.currentName);
  if (source === undefined)
    throw new Error(`Agent '${options.currentName}' does not exist`);
  if (
    (await findAgent(options.agentsDirectory, options.replacementName)) !==
    undefined
  ) {
    throw new Error(`Agent '${options.replacementName}' already exists`);
  }
  const document = parseDocument(
    (await readRegularFile(source, maximumAgentBytes)).toString("utf8"),
    { customTags: [] },
  );
  document.set("name", options.replacementName);
  const destination = join(
    options.agentsDirectory,
    `${options.replacementName}.yaml`,
  );
  assertWithin(options.agentsDirectory, destination);
  if (await pathExists(destination)) {
    throw new Error(
      `Agent destination '${options.replacementName}' already exists`,
    );
  }
  await atomicWrite(destination, document.toString());
  try {
    await rm(source);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  return destination;
}

export async function replaceAgentDefinitionInScope(options: {
  readonly agentsDirectory: string;
  readonly definition: AgentDefinition;
  readonly validatePublishedCatalog: () => Promise<void>;
}): Promise<{ path: string; fingerprint: string }> {
  const definition = currentAgentDefinitionSchema.parse(options.definition);
  await assertPhysicalDirectory(options.agentsDirectory);
  const existing = await findAgent(options.agentsDirectory, definition.name);
  const destination =
    existing ?? join(options.agentsDirectory, `${definition.name}.yaml`);
  assertWithin(options.agentsDirectory, destination);
  if (existing === undefined && (await pathExists(destination))) {
    throw new Error(
      `Artifact path '${basename(destination)}' is already occupied by another or invalid definition`,
    );
  }

  const staged = `${destination}.${randomUUID()}.staged`;
  const backup = `${destination}.${randomUUID()}.backup`;
  const content = stringify(definition, { lineWidth: 0 });
  let backedUp = false;
  let published = false;
  try {
    await writeFile(staged, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (existing !== undefined) {
      await rename(destination, backup);
      backedUp = true;
    }
    await rename(staged, destination);
    published = true;
    await options.validatePublishedCatalog();
    if (backedUp) await rm(backup, { force: true });
    return {
      path: destination,
      fingerprint: fingerprint(Buffer.from(content, "utf8")),
    };
  } catch (error) {
    if (published) await rm(destination, { force: true });
    if (backedUp) await rename(backup, destination);
    await rm(staged, { force: true });
    throw error;
  }
}

function skillDocumentContent(metadata: SkillMetadata, body: string): string {
  const validatedMetadata = skillMetadataSchema.parse(metadata);
  const validatedBody = body.trim();
  if (validatedBody.length === 0) {
    throw new Error("SKILL.md body must not be empty");
  }
  const frontmatter = stringify(validatedMetadata, { lineWidth: 0 }).trimEnd();
  const content = `---\n${frontmatter}\n---\n\n${validatedBody}\n`;
  if (Buffer.byteLength(content, "utf8") > maximumSkillBytes) {
    throw new Error(`SKILL.md exceeds ${maximumSkillBytes} bytes`);
  }
  return content;
}

export async function replaceSkillInScope(options: {
  readonly skillsDirectory: string;
  readonly metadata: SkillMetadata;
  readonly body: string;
  readonly validatePublishedCatalog: () => Promise<void>;
}): Promise<{ path: string; fingerprint: string }> {
  const metadata = skillMetadataSchema.parse(options.metadata);
  const content = skillDocumentContent(metadata, options.body);
  await assertPhysicalDirectory(options.skillsDirectory);
  const existing = await findSkill(options.skillsDirectory, metadata.name);
  const destinationDirectory =
    existing ?? join(options.skillsDirectory, metadata.name);
  const destination = join(destinationDirectory, "SKILL.md");
  assertWithin(options.skillsDirectory, destinationDirectory);
  if (existing === undefined && (await pathExists(destinationDirectory))) {
    throw new Error(
      `Artifact path '${basename(destinationDirectory)}' is already occupied by another or invalid skill`,
    );
  }
  if (existing !== undefined) {
    const staged = `${destination}.${randomUUID()}.staged`;
    const backup = `${destination}.${randomUUID()}.backup`;
    let backedUp = false;
    let published = false;
    try {
      await writeFile(staged, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(destination, backup);
      backedUp = true;
      await rename(staged, destination);
      published = true;
      await options.validatePublishedCatalog();
      await rm(backup, { force: true });
      return {
        path: destination,
        fingerprint: fingerprint(Buffer.from(content, "utf8")),
      };
    } catch (error) {
      if (published) await rm(destination, { force: true });
      if (backedUp) await rename(backup, destination);
      await rm(staged, { force: true });
      throw error;
    }
  }
  const stagingRoot = dirname(options.skillsDirectory);
  const staged = join(
    stagingRoot,
    `.${basename(options.skillsDirectory)}-${metadata.name}-${randomUUID()}.staged`,
  );
  let published = false;
  try {
    await mkdir(staged, { recursive: false, mode: 0o700 });
    await writeFile(join(staged, "SKILL.md"), content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(staged, destinationDirectory);
    published = true;
    await options.validatePublishedCatalog();
    return {
      path: destination,
      fingerprint: fingerprint(Buffer.from(content, "utf8")),
    };
  } catch (error) {
    if (published) {
      await rm(destinationDirectory, { recursive: true, force: true });
    }
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

export async function deleteArtifact(options: {
  readonly kind: MutableArtifactKind;
  readonly directory: string;
  readonly name: string;
}): Promise<void> {
  const path = await artifactPath(
    options.kind,
    options.directory,
    options.name,
  );
  if (path === undefined)
    throw new Error(`Artifact '${options.name}' does not exist`);
  await rm(path, { recursive: options.kind === "skill" });
}

export async function readArtifactTombstones(
  path: string,
): Promise<ArtifactTombstones> {
  try {
    const parsed = JSON.parse(
      (await readRegularFile(path, 256 * 1024)).toString("utf8"),
    ) as Partial<ArtifactTombstones>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.revision) ||
      !Array.isArray(parsed.names)
    ) {
      throw new Error("Artifact tombstone state is invalid");
    }
    const names = parsed.names.map((name) => skillNameSchema.parse(name));
    return { version: 1, revision: parsed.revision as number, names };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, revision: 0, names: [] };
    }
    throw error;
  }
}

async function mutateTombstone(
  path: string,
  name: string,
  expectedRevision: number,
  disabled: boolean,
): Promise<ArtifactTombstones> {
  skillNameSchema.parse(name);
  const current = await readArtifactTombstones(path);
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Artifact state revision conflict: expected ${expectedRevision}, current ${current.revision}`,
    );
  }
  const names = new Set(current.names);
  if (disabled) names.add(name);
  else names.delete(name);
  const updated: ArtifactTombstones = {
    version: 1,
    revision: current.revision + 1,
    names: [...names].sort(),
  };
  await atomicWrite(path, `${JSON.stringify(updated, undefined, 2)}\n`);
  return updated;
}

export async function disableArtifact(
  path: string,
  name: string,
  expectedRevision: number,
): Promise<ArtifactTombstones> {
  return mutateTombstone(path, name, expectedRevision, true);
}

export async function restoreArtifact(
  path: string,
  name: string,
  expectedRevision: number,
): Promise<ArtifactTombstones> {
  return mutateTombstone(path, name, expectedRevision, false);
}
