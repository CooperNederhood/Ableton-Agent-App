import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class OsCredentialVault {
  public constructor(
    private readonly directory: string,
    private readonly encryption: EncryptionProvider,
  ) {}

  public async get(key: string): Promise<string | undefined> {
    this.assertKey(key);
    try {
      return this.encryption.decryptString(
        await readFile(join(this.directory, key)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async set(key: string, value: string): Promise<void> {
    this.assertAvailable();
    this.assertKey(key);
    const path = join(this.directory, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, this.encryption.encryptString(value), {
      mode: 0o600,
    });
  }

  public async delete(key: string): Promise<void> {
    this.assertKey(key);
    await rm(join(this.directory, key), { force: true });
  }

  private assertAvailable(): void {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("OS-backed encryption is unavailable");
    }
  }

  private assertKey(key: string): void {
    if (!/^[a-z0-9-]+$/u.test(key)) throw new Error("Invalid credential key");
  }
}
