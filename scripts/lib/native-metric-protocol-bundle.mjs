import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = "max-patches/audio-listener/audio_listener_metric_protocol.mjs";
const requireProtocol = createRequire(
  join(root, "packages/protocol/package.json"),
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const NATIVE_METRIC_PROTOCOL_FILE = "audio_listener_metric_protocol.js";

function beneath(directory, file) {
  const suffix = relative(directory, file);
  return suffix &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix)
    ? suffix.split(sep).join("/")
    : null;
}

/**
 * Produces resources for the existing publisher; it never installs, advertises
 * readiness or writes a bundle. Lifecycle attribution belongs to the caller.
 */
export async function compileNativeMetricProtocol({ stage, signal } = {}) {
  if (typeof stage !== "function")
    throw new Error("native_metric_codec_lifecycle_required");
  return stage(
    "native-metric-protocol-compile",
    async () => {
      signal?.throwIfAborted();
      const zodRoot = dirname(requireProtocol.resolve("zod/package.json"));
      const license = await readFile(join(zodRoot, "LICENSE"), "utf8");
      if (
        license.length > 64 * 1024 ||
        license.includes("*/") ||
        !license.includes("MIT License") ||
        !license.includes("Copyright")
      )
        throw new Error("native_metric_codec_license_invalid");
      const lock = await readFile(join(root, "pnpm-lock.yaml"));
      const inputs = new Map();
      let inputBytes = 0;
      let compiled;
      try {
        compiled = await build({
          absWorkingDir: root,
          entryPoints: [entry],
          alias: {
            "@ableton-agent/protocol": join(
              root,
              "packages/protocol/src/index.ts",
            ),
          },
          bundle: true,
          format: "cjs",
          platform: "node",
          target: "es2020",
          write: false,
          metafile: true,
          sourcemap: false,
          legalComments: "inline",
          logLevel: "silent",
          plugins: [
            {
              name: "pinned-native-metric-inputs",
              setup(context) {
                context.onLoad(
                  { filter: /\.(?:[cm]?[jt]s|json)$/ },
                  async ({ path }) => {
                    signal?.throwIfAborted();
                    const dependency = beneath(zodRoot, path);
                    const source = beneath(root, path);
                    if (
                      !dependency &&
                      (!source || source.split("/").includes("node_modules"))
                    )
                      throw new Error(
                        "native_metric_codec_unreviewed_dependency",
                      );
                    const contents = await readFile(path);
                    inputBytes += contents.length;
                    if (
                      inputs.has(path) ||
                      inputs.size >= 512 ||
                      inputBytes > MAX_INPUT_BYTES
                    )
                      throw new Error("native_metric_codec_input_budget");
                    inputs.set(path, {
                      path: dependency
                        ? `dependency:zod/${dependency}`
                        : source,
                      bytes: contents.length,
                      sha256: digest(contents),
                    });
                    return {
                      contents,
                      loader: path.endsWith(".json")
                        ? "json"
                        : /\.[cm]?ts$/u.test(path)
                          ? "ts"
                          : "js",
                    };
                  },
                );
              },
            },
          ],
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      signal?.throwIfAborted();
      if (
        compiled.outputFiles.length !== 1 ||
        Object.values(compiled.metafile.outputs).some((output) =>
          output.imports.some((imported) => imported.external),
        )
      )
        throw new Error("native_metric_codec_not_self_contained");
      for (const name of Object.keys(compiled.metafile.inputs))
        if (!inputs.has(resolve(root, name)))
          throw new Error("native_metric_codec_unpinned_input");
      for (const [path, pin] of inputs) {
        signal?.throwIfAborted();
        if (digest(await readFile(path)) !== pin.sha256)
          throw new Error("native_metric_codec_input_changed");
      }
      if (
        digest(await readFile(join(root, "pnpm-lock.yaml"))) !== digest(lock) ||
        (await readFile(join(zodRoot, "LICENSE"), "utf8")) !== license
      )
        throw new Error("native_metric_codec_input_changed");
      const source = `/* Bundled Zod license:\n${license}\n*/\n${compiled.outputFiles[0].text}`;
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > MAX_OUTPUT_BYTES)
        throw new Error("native_metric_codec_output_budget");
      signal?.throwIfAborted();
      const provenance = {
        schema: "native-metric-protocol-bundle/v1",
        entry,
        compiler: Object.freeze({
          name: "esbuild",
          version,
          format: "cjs",
          syntaxTarget: "es2020",
        }),
        bytes,
        sha256: digest(source),
        lockfileSha256: digest(lock),
        licenseSha256: digest(license),
        inputs: Object.freeze(
          [...inputs.values()]
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
            .map((input) => Object.freeze(input)),
        ),
      };
      return Object.freeze({
        fileName: NATIVE_METRIC_PROTOCOL_FILE,
        source,
        provenance: Object.freeze(provenance),
      });
    },
    { artifact: NATIVE_METRIC_PROTOCOL_FILE, syntaxTarget: "es2020" },
  );
}
