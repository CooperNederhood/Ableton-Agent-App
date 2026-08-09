import { describe, expect, it } from "vitest";

import { checkProductCompatibility } from "./compatibility.js";
import { PRODUCT_VERSIONS } from "./product-versions.generated.js";

describe("product compatibility", () => {
  it("accepts supported Live and matching component versions", () => {
    expect(
      checkProductCompatibility({
        liveVersion: "12.1.5",
        protocolVersion: PRODUCT_VERSIONS.protocol,
        remoteScriptVersion: PRODUCT_VERSIONS.remoteScript,
      }),
    ).toEqual({ compatible: true });
  });

  it.each([
    ["protocol-incompatible", "12.0.0", 99, "0.4.0"],
    ["remote-script-outdated", "12.0.0", 2, "0.3.9"],
    ["live-unsupported", "10.1.0", 2, "0.4.0"],
    ["live-unsupported", "11.2.9", 2, "0.4.0"],
  ] as const)(
    "reports %s",
    (reason, liveVersion, protocolVersion, remoteScriptVersion) => {
      expect(
        checkProductCompatibility({
          liveVersion,
          protocolVersion,
          remoteScriptVersion,
        }),
      ).toMatchObject({ compatible: false, reason });
    },
  );
});
