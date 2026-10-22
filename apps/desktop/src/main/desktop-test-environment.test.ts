import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import { preferencesSchema } from "../contracts.js";
import {
  createDesktopTestEnvironment,
  createDesktopTestPreferences,
  writeDesktopTestPreferences,
} from "../../../../tests/electron/desktop-test-environment.js";

const profile = resolve(".synthetic-electron-environment-fixture");
const ownedProfiles: string[] = [];
afterEach(async () => {
  await Promise.all(
    ownedProfiles
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("Electron launch isolation", () => {
  it("never reads inherited credentials and rejects global homes, endpoints and renderer overrides", () => {
    const inherited: NodeJS.ProcessEnv = {
      PATH: "/fixture/bin",
      LANG: "en_US.UTF-8",
      HOME: "/unowned-home",
      LIVE_AGENT_HOME: "/unowned-store",
      ABLETON_AGENT_PORT: "8765",
      VITE_DEV_SERVER_URL: "https://unowned.invalid",
      COPILOT_CLI_PATH: "/unowned-cli",
      NODE_OPTIONS: "--unowned-option",
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/unowned-descriptor",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/unowned-credential",
    };
    const readCredential = vi.fn(() => {
      throw new Error("Inherited credentials must not be read");
    });
    for (const key of [
      "ABLETON_AGENT_TOKEN",
      "ABLETON_AGENT_SIGNAL_INGRESS_SECRET",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "OPENAI_API_KEY",
    ])
      Object.defineProperty(inherited, key, {
        enumerable: true,
        get: readCredential,
      });
    const environment = createDesktopTestEnvironment(
      { profile, bridgePort: 51234 },
      inherited,
    );
    expect(readCredential).not.toHaveBeenCalled();
    expect(environment.PATH).toBe("/fixture/bin");
    expect(environment.HOME).toBe(join(profile, "home"));
    expect(environment.LIVE_AGENT_HOME).toBe(join(profile, "live-agent"));
    expect(environment.ABLETON_AGENT_PORT).toBe("51234");
    expect(environment.ABLETON_AGENT_TOKEN).toBe(
      "synthetic-electron-rejecting-bridge-only",
    );
    expect(createDesktopTestPreferences(environment, 51236).abletonPort).toBe(
      51234,
    );
    expect(createDesktopTestPreferences(environment, 51236).signalPort).toBe(
      51236,
    );
    expect(environment.TMPDIR).toBe(join(profile, "runtime-temp"));
    for (const key of [
      "VITE_DEV_SERVER_URL",
      "COPILOT_CLI_PATH",
      "NODE_OPTIONS",
      "ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR",
      "ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ])
      expect(environment).not.toHaveProperty(key);
  });
  it("allows only explicit fixture endpoints and uses the actual automation profile", () => {
    const environment = createDesktopTestEnvironment(
      {
        profile,
        bridgePort: 51234,
        automation: true,
        overrides: {
          ABLETON_AGENT_PORT: "51235",
          ABLETON_AGENT_TOKEN: "explicit-synthetic-fixture",
        },
      },
      {},
    );
    expect(environment.ABLETON_AGENT_PORT).toBe("51235");
    expect(environment.ABLETON_AGENT_TOKEN).toBe("explicit-synthetic-fixture");
    expect(environment.LIVE_AGENT_PROFILE).toBe("automation");
    expect(() =>
      createDesktopTestEnvironment(
        {
          profile,
          bridgePort: 51234,
          overrides: { HOME: "/unowned" },
        },
        {},
      ),
    ).toThrow("Only explicit synthetic");
    for (const bridgePort of [0, -1, 65536, NaN])
      expect(() =>
        createDesktopTestEnvironment({ profile, bridgePort }, {}),
      ).toThrow("owned bridge port");
    for (const invalid of ["relative-profile", resolve(".."), process.cwd()])
      expect(() =>
        createDesktopTestEnvironment(
          { profile: invalid, bridgePort: 51234 },
          {},
        ),
      ).toThrow("owned directories");
  });

  it.each([false, true])(
    "writes exact resolver-owned bridge/signal preferences across initial and restart options (automation=%s)",
    async (automation) => {
      const profile = resolve(`.electron-preferences-unit-${randomUUID()}`);
      await mkdir(profile);
      ownedProfiles.push(profile);
      const inherited = {
        PATH: "/synthetic/bin",
        HOME: "/unowned-home",
        LIVE_AGENT_HOME: "/unowned-store",
        ABLETON_AGENT_PORT: "8765",
        ABLETON_AGENT_TOKEN: "inherited-synthetic-bridge-token",
        ABLETON_AGENT_SIGNAL_INGRESS_SECRET:
          "inherited-synthetic-ingress-token",
        GITHUB_TOKEN: "inherited-synthetic-github-token",
        GH_TOKEN: "inherited-synthetic-gh-token",
        COPILOT_GITHUB_TOKEN: "inherited-synthetic-copilot-token",
        OPENAI_API_KEY: "inherited-synthetic-cloud-token",
        ANTHROPIC_API_KEY: "inherited-synthetic-other-cloud-token",
        AZURE_OPENAI_API_KEY: "inherited-synthetic-azure-token",
        VITE_DEV_SERVER_URL: "https://unowned.invalid",
      };
      const options = { profile, bridgePort: 51234, automation };
      const initial = createDesktopTestEnvironment(options, inherited);
      const restart = createDesktopTestEnvironment(options, inherited);
      expect(restart).toEqual(initial);
      for (const environment of [initial, restart]) {
        expect(environment.HOME).toBe(join(profile, "home"));
        expect(environment.HOME).not.toBe(inherited.HOME);
        expect(environment.ABLETON_AGENT_TOKEN).not.toBe(
          inherited.ABLETON_AGENT_TOKEN,
        );
        expect(environment.ABLETON_AGENT_PORT).toBe("51234");
        for (const key of [
          "ABLETON_AGENT_SIGNAL_INGRESS_SECRET",
          "GITHUB_TOKEN",
          "GH_TOKEN",
          "COPILOT_GITHUB_TOKEN",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "AZURE_OPENAI_API_KEY",
          "VITE_DEV_SERVER_URL",
        ])
          expect(environment).not.toHaveProperty(key);
      }
      const expected = resolveLiveAgentStorage({
        homeDirectory: join(profile, "home"),
        environment: initial,
      });
      const written = await writeDesktopTestPreferences(initial, 51236);
      expect(written.preferencesPath).toBe(expected.preferencesPath);
      const read = async () =>
        preferencesSchema.parse(
          JSON.parse(
            await readFile(expected.preferencesPath, "utf8"),
          ) as unknown,
        );
      expect(await read()).toMatchObject({
        abletonPort: 51234,
        signalPort: 51236,
      });
      expect((await read()).abletonPort).not.toBe(8765);
      // Restart consumes the persisted preferences without falling back to defaults.
      expect(
        resolveLiveAgentStorage({ environment: restart }).preferencesPath,
      ).toBe(expected.preferencesPath);
      expect(await read()).toMatchObject(
        createDesktopTestPreferences(restart, 51236),
      );
      await writeDesktopTestPreferences(restart, 51237);
      expect(await read()).toMatchObject({
        abletonPort: 51234,
        signalPort: 51237,
      });
      await expect(
        writeDesktopTestPreferences(
          {
            ...initial,
            LIVE_AGENT_HOME: resolve("..", ".unowned-electron-store"),
          },
          51236,
        ),
      ).rejects.toThrow("below the workspace");
    },
  );
});
