/* global URL */
import { registerHooks } from "node:module";

const protocolSource = new URL("../../packages/protocol/src/", import.meta.url);

export function resolveNativeProtocolSource(specifier, context, nextResolve) {
  if (
    !context.parentURL?.startsWith(protocolSource.href) ||
    !context.parentURL.endsWith(".ts") ||
    !(specifier.startsWith("./") || specifier.startsWith("../")) ||
    !specifier.endsWith(".js")
  )
    return nextResolve(specifier, context);

  const requested = new URL(specifier, context.parentURL);
  if (!requested.href.startsWith(protocolSource.href))
    return nextResolve(specifier, context);

  try {
    return nextResolve(specifier, context);
  } catch (cause) {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND" || cause.url !== requested.href)
      throw cause;
    // Native Node strips TS but does not remap emitted .js source imports.
    return nextResolve(requested.href.slice(0, -3) + ".ts", context);
  }
}

registerHooks({ resolve: resolveNativeProtocolSource });
