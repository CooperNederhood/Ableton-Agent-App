import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OsCredentialVault, type EncryptionProvider } from "./secure-store.js";

const roots: string[] = [];
const key = "ableton-bridge-token";
const token = "synthetic-credential";
const ciphertext = Buffer.from("encrypted-fixture-bytes");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ableton-native-vault-"));
  roots.push(root);
  const storage = resolveLiveAgentStorage({
    environment: { LIVE_AGENT_HOME: root, LIVE_AGENT_PROFILE: "automation" },
  });
  const encryption = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(() => ciphertext),
    decryptString: vi.fn(() => token),
  } satisfies EncryptionProvider;
  return {
    directory: storage.credentialsDirectory,
    path: join(storage.credentialsDirectory, key),
    encryption,
    vault: new OsCredentialVault(storage.credentialsDirectory, encryption),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("OS credential vault adapter", () => {
  it("does not invoke native decryption when the profile has no stored token", async () => {
    const { vault, encryption } = await fixture();
    await expect(vault.get(key)).resolves.toBeUndefined();
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });

  it("persists only encrypted bytes and decrypts them after reopening the profile", async () => {
    const { vault, encryption, directory, path } = await fixture();
    await vault.set(key, token);
    expect(encryption.encryptString).toHaveBeenCalledExactlyOnceWith(token);
    expect(await readFile(path)).toEqual(ciphertext);
    expect((await readFile(path)).includes(Buffer.from(token))).toBe(false);
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      new OsCredentialVault(directory, encryption).get(key),
    ).resolves.toBe(token);
    expect(encryption.decryptString).toHaveBeenCalledExactlyOnceWith(
      ciphertext,
    );
  });

  it("rejects unavailable OS encryption without writing a plaintext fallback", async () => {
    const { vault, encryption, path } = await fixture();
    vi.mocked(encryption.isEncryptionAvailable).mockReturnValue(false);
    await expect(vault.set(key, token)).rejects.toThrow(
      "OS-backed encryption is unavailable",
    );
    expect(encryption.encryptString).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates native encryption denial and preserves the previous ciphertext", async () => {
    const { vault, encryption, path } = await fixture();
    await vault.set(key, token);
    const denial = new Error("Keychain access denied");
    vi.mocked(encryption.encryptString).mockImplementation(() => {
      throw denial;
    });
    await expect(vault.set(key, "replacement-credential")).rejects.toBe(denial);
    expect(await readFile(path)).toEqual(ciphertext);
  });

  it("does not disguise native decryption denial as a missing credential", async () => {
    const { vault, encryption, path } = await fixture();
    await vault.set(key, token);
    const denial = new Error("Keychain access denied");
    vi.mocked(encryption.decryptString).mockImplementation(() => {
      throw denial;
    });
    await expect(vault.get(key)).rejects.toBe(denial);
    expect(await readFile(path)).toEqual(ciphertext);
  });

  it("rejects keys outside the credential namespace before reading or encrypting", async () => {
    const { vault, encryption } = await fixture();
    await expect(vault.get("../other-profile")).rejects.toThrow(
      "Invalid credential key",
    );
    await expect(vault.set("../other-profile", token)).rejects.toThrow(
      "Invalid credential key",
    );
    expect(encryption.encryptString).not.toHaveBeenCalled();
    expect(encryption.decryptString).not.toHaveBeenCalled();
  });
});
