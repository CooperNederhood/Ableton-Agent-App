import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { SignalIngressDiscoveryDescriptor } from "./ingress-contracts.js";

export class DiscoveryDescriptorLifecycle {
  readonly #path: string;
  #writtenContent: string | undefined;
  #writtenIdentity:
    { readonly device: number; readonly inode: number } | undefined;

  constructor(path: string) {
    if (path.length === 0) {
      throw new TypeError("Descriptor path must not be empty");
    }
    this.#path = path;
  }

  async write(descriptor: SignalIngressDiscoveryDescriptor): Promise<void> {
    const content = `${JSON.stringify(descriptor)}\n`;
    const directory = dirname(this.#path);
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.#path);
      const descriptorStat = await stat(this.#path);
      this.#writtenContent = content;
      this.#writtenIdentity = {
        device: descriptorStat.dev,
        inode: descriptorStat.ino,
      };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async remove(): Promise<void> {
    const expected = this.#writtenContent;
    const expectedIdentity = this.#writtenIdentity;
    if (expected === undefined || expectedIdentity === undefined) {
      return;
    }
    this.#writtenContent = undefined;
    this.#writtenIdentity = undefined;
    try {
      const [current, currentStat] = await Promise.all([
        readFile(this.#path, "utf8"),
        stat(this.#path),
      ]);
      if (
        current === expected &&
        currentStat.dev === expectedIdentity.device &&
        currentStat.ino === expectedIdentity.inode
      ) {
        await rm(this.#path);
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
}
