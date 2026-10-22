/* global URL */
import { register } from "node:module";

export { resolveNativeProtocolSource } from "./native-protocol-test-hooks.mjs";

register(new URL("./native-protocol-test-hooks.mjs", import.meta.url));
