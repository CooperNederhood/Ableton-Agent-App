import { describe, expect, it } from "vitest";

import { resolvePackagedCopilotRuntimePath } from "./copilot-runtime.js";

describe("packaged Copilot runtime", () => {
  it("resolves the unpacked macOS runtime executable", () => {
    expect(
      resolvePackagedCopilotRuntimePath(
        "/Applications/Ableton Agent.app/Contents/Resources",
        "darwin",
        "arm64",
      ),
    ).toBe(
      "/Applications/Ableton Agent.app/Contents/Resources/app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime",
    );
  });

  it("uses the Windows executable name", () => {
    expect(
      resolvePackagedCopilotRuntimePath(
        "C:\\Ableton Agent\\resources",
        "win32",
        "x64",
      ).replaceAll("\\", "/"),
    ).toBe(
      "C:/Ableton Agent/resources/app.asar.unpacked/node_modules/@github/copilot-sdk-win32-x64/prebuilds/win32-x64/copilot-runtime.exe",
    );
  });
});
