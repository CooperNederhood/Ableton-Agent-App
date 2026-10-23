import { describe, expect, it } from "vitest";

import { checkProductCompatibility } from "./compatibility.js";
import { PRODUCT_VERSIONS } from "./product-versions.generated.js";

describe("product compatibility", () => {
  it.each(["11.3.0", "11.3.42", "11.3.43", "11.3.44", "11.4.0"])(
    "accepts Live %s without pinning the development patch version",
    (liveVersion) => {
      expect(
        checkProductCompatibility({
          liveVersion,
          protocolVersion: PRODUCT_VERSIONS.protocol,
          remoteScriptVersion: PRODUCT_VERSIONS.remoteScript,
        }),
      ).toEqual({ compatible: true });
    },
  );

  it.each([
    ["protocol-incompatible", "11.3.43", 99, "0.5.0"],
    ["remote-script-outdated", "11.3.43", PRODUCT_VERSIONS.protocol, "0.4.9"],
    [
      "live-unsupported",
      "12.0.0",
      PRODUCT_VERSIONS.protocol,
      PRODUCT_VERSIONS.remoteScript,
    ],
    [
      "live-unsupported",
      "12.1.5",
      PRODUCT_VERSIONS.protocol,
      PRODUCT_VERSIONS.remoteScript,
    ],
    [
      "live-unsupported",
      "10.1.0",
      PRODUCT_VERSIONS.protocol,
      PRODUCT_VERSIONS.remoteScript,
    ],
    [
      "live-unsupported",
      "11.2.9",
      PRODUCT_VERSIONS.protocol,
      PRODUCT_VERSIONS.remoteScript,
    ],
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
