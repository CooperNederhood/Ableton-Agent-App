import { createHash } from "node:crypto";
import type { Buffer } from "node:buffer";

// Exact generated DSP documents, including their outlet wiring. These are
// source-integrity pins, NOT proof of execution by the Max compiler.
export const NATIVE_MEL_GEN_PINS = Object.freeze({
  "audio_listener_native_clock.gendsp":
    "cc072d2bc9f529740db48e66d94417bc072d041a75cd537bc3328207ef93bbb3",
  "audio_listener_native_envelope.gendsp":
    "d12f2f8d80036e4aebebafecc54ab432847cf9cbfd620ce207b334846165f136",
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native mel source binding");
  return value as Record<string, unknown>;
}
function patch(raw: Buffer | undefined) {
  if (!raw) throw new Error("Missing native mel source binding");
  const p = object(object(JSON.parse(raw.toString("utf8"))).patcher);
  if (!Array.isArray(p.boxes) || !Array.isArray(p.lines))
    throw new Error("Invalid native mel source binding");
  return {
    boxes: p.boxes.map((entry: unknown) => object(object(entry).box)),
    lines: p.lines.map((entry: unknown) => object(object(entry).patchline)),
  };
}
type Edge = readonly [string, number, string, number];
const melEdges: readonly Edge[] = [
  ["left", 0, "melEngine", 0],
  ["right", 0, "melEngine", 1],
  ["clock", 0, "melEngine", 2],
  ...[0, 2, 6, 7, 9, 13, 18].map((outlet, index): Edge => [
    "gen",
    outlet,
    "melEngine",
    index + 3,
  ]),
  ["melCommand", 0, "melEngine", 0],
  ["melEngine", 0, "melMessages", 0],
  ["melMessages", 0, "nativeMessages", 0],
];

export function validateNativeMelResources(
  contents: ReadonlyMap<string, Buffer>,
): void {
  for (const [name, sha256] of Object.entries(NATIVE_MEL_GEN_PINS)) {
    const raw = contents.get(name);
    if (!raw || createHash("sha256").update(raw).digest("hex") !== sha256)
      throw new Error(`Native mel executed-source document mismatch: ${name}`);
  }
  const analysis = patch(contents.get("audio_listener_native_analysis.maxpat"));
  const requireBox = (
    graph: ReturnType<typeof patch>,
    id: string,
    text: string,
  ) => {
    const matches = graph.boxes.filter((box) => box.id === id);
    if (
      matches.length !== 1 ||
      matches[0]?.text !== text ||
      matches[0]?.maxclass !== "newobj"
    )
      throw new Error("Invalid native mel source binding object");
    return matches[0];
  };
  for (const [id, text] of [
    ["left", "in~ 2"],
    ["right", "in~ 3"],
    ["clock", "in~ 4"],
    ["gen", "gen~ audio_listener_native_envelope.gendsp @nocache 1"],
    ["melCommand", "in 5"],
    ["melMessages", "prepend native_mel"],
    ["nativeMessages", "out 1"],
  ] as const)
    requireBox(analysis, id, text);
  const engine = requireBox(analysis, "melEngine", "listener.mel~");
  if (
    engine.numinlets !== 10 ||
    engine.numoutlets !== 1 ||
    analysis.boxes.filter((box) => box.text === "listener.mel~").length !== 1 ||
    /fluid\.(?:buf)?melbands~/.test(JSON.stringify(analysis))
  )
    throw new Error("Invalid native mel producer shape");
  const matches = (line: Record<string, unknown>, edge: Edge) =>
    JSON.stringify(line.source) === JSON.stringify(edge.slice(0, 2)) &&
    JSON.stringify(line.destination) === JSON.stringify(edge.slice(2));
  const owned = new Set(["melCommand", "melEngine", "melMessages"]);
  const relevant = analysis.lines.filter((line) =>
    [line.source, line.destination].some(
      (endpoint) => Array.isArray(endpoint) && owned.has(String(endpoint[0])),
    ),
  );
  if (
    relevant.length !== melEdges.length ||
    melEdges.some(
      (edge) => relevant.filter((line) => matches(line, edge)).length !== 1,
    )
  )
    throw new Error("Invalid native mel signal/control binding");
  for (const edge of [
    ["left", 0, "gen", 1],
    ["right", 0, "gen", 2],
    ["clock", 0, "gen", 3],
  ] as const)
    if (analysis.lines.filter((line) => matches(line, edge)).length !== 1)
      throw new Error("Native mel capture input binding mismatch");
  const clock = patch(contents.get("audio_listener_native_clock.maxpat"));
  requireBox(
    clock,
    "clock",
    "gen~ audio_listener_native_clock.gendsp @nocache 1",
  );
  requireBox(clock, "clockOutput", "out~ 1");
  const outputs = clock.lines.filter(
    (line) =>
      Array.isArray(line.destination) && line.destination[0] === "clockOutput",
  );
  if (
    outputs.length !== 1 ||
    !matches(outputs[0]!, ["clock", 1, "clockOutput", 0])
  )
    throw new Error("Native mel absolute counter binding mismatch");
}
