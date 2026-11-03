import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { decodeMaxCollective, encodeMaxCollective } from "./max-collective.js";
import { decodeAmxd, encodeAmxd, freezeAmxd } from "./max-device.js";

const document = {
  patcher: {
    boxes: [
      { box: { id: "runtime", text: "node.script runtime.js @autostart 1" } },
      { box: { id: "guard", text: "js guard.js" } },
    ],
    lines: [
      { patchline: { source: ["guard", 0], destination: ["runtime", 0] } },
    ],
  },
};
function editable(type = "aaaa", metadata = true) {
  const prefix = Buffer.from(
    `616d706604000000${Buffer.from(type).toString("hex")}${metadata ? "6d6574610400000001000000" : ""}70746368`,
    "hex",
  );
  return encodeAmxd({ prefix, suffix: Buffer.from("tail") }, document);
}
const resources = () =>
  new Map([
    ["runtime.js", Buffer.from('require("./dependency.js");')],
    ["dependency.js", Buffer.from('require("./agent_signal_storage.js");')],
    [
      "agent_signal_storage.js",
      Buffer.from('module.exports = {secretPath:"/profile/path"};'),
    ],
    ["guard.js", Buffer.from("function bang() {}")],
    ["clock.maxpat", Buffer.from('{"patcher":{"boxes":[]}}')],
    ["analysis.gendsp", Buffer.from('{"patcher":{"boxes":[]}}')],
    ["package.json", Buffer.from('{"type":"commonjs"}')],
  ]);

describe("headless Max collective freezing", () => {
  it("marks CommonJS dependencies and profile configuration for Node disk extraction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frozen-max-node-"));
    try {
      const decoded = decodeAmxd(
        freezeAmxd(editable(), "Listener.amxd", resources()),
      );
      // Max 8.5.8 extracts only flag-8 resources into node.script's directory.
      for (const file of decoded.frozenFiles!.filter(
        (entry) => entry.flags === 8,
      ))
        await writeFile(join(directory, file.name), file.data, { flag: "wx" });
      const require = createRequire(join(directory, "bootstrap.cjs"));
      expect(() => {
        require(join(directory, "runtime.js"));
      }).not.toThrow();
      expect(
        decoded.frozenFiles!.find(({ name }) => name === "package.json")?.flags,
      ).toBe(8);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["aaaa", "mmmm", "iiii"])(
    "preserves %s wrapper/graph and embeds exact complete resources",
    (type) => {
      const source = editable(type);
      const before = Buffer.from(source);
      const bytes = freezeAmxd(source, "Listener.amxd", resources());
      expect(source).toEqual(before);
      expect(bytes.toString("ascii", 8, 12)).toBe(type);
      expect(bytes.readUInt32LE(bytes.indexOf("meta") + 8)).toBe(7);
      const offset = bytes.indexOf("ptch") + 8;
      expect(bytes.toString("ascii", offset, offset + 4)).toBe("mx@c");
      expect(bytes.readUInt32BE(offset + 4)).toBe(16);
      const directory = offset + Number(bytes.readBigUInt64BE(offset + 8));
      expect(bytes.toString("ascii", directory, directory + 4)).toBe("dlst");
      expect(directory + bytes.readUInt32BE(directory + 4)).toBe(
        bytes.length - 4,
      );
      const decoded = decodeAmxd(bytes);
      expect(decoded.suffix.toString()).toBe("tail");
      expect(decoded.document).toMatchObject(document);
      expect(decoded.frozenFiles!.map(({ name }) => name)).toEqual([
        "Listener.amxd",
        ...[...resources().keys()].sort(),
      ]);
      expect(decoded.frozenFiles![0]).toMatchObject({
        flags: 17,
        type: "JSON",
      });
      for (const file of decoded.frozenFiles!.slice(1)) {
        expect(file.data).toEqual(resources().get(file.name));
        expect(file.flags).toBe(/\.(?:js|json)$/u.test(file.name) ? 8 : 0);
      }
      expect(
        decoded.frozenFiles!.find(({ name }) => name === "analysis.gendsp")
          ?.type,
      ).toBe("gDSP");
      expect(
        decoded.frozenFiles!.find(({ name }) => name === "clock.maxpat")?.type,
      ).toBe("JSON");
      expect(encodeAmxd(decoded, decoded.document)).toEqual(bytes);
    },
  );

  it("is deterministic across resource map ordering and adds absent frozen metadata", () => {
    const first = freezeAmxd(
      editable("aaaa", false),
      "Listener.amxd",
      resources(),
    );
    const second = freezeAmxd(
      editable("aaaa", false),
      "Listener.amxd",
      new Map([...resources()].reverse()),
    );
    expect(second).toEqual(first);
    expect(first.readUInt32LE(first.indexOf("meta") + 8)).toBe(7);
  });

  it("preserves every embedded dependency when editing the main frozen patcher", () => {
    const frozen = decodeAmxd(
      freezeAmxd(editable(), "Listener.amxd", resources()),
    );
    const changed = decodeAmxd(
      encodeAmxd(frozen, { patcher: { boxes: [], lines: [] } }),
    );
    expect(changed.document).toEqual({ patcher: { boxes: [], lines: [] } });
    expect(changed.frozenFiles!.slice(1)).toEqual(frozen.frozenFiles!.slice(1));
    expect(decodeAmxd(editable()).frozenFiles).toBeUndefined();
  });

  it("denies missing Node dependencies, double freezing, filename collisions and unsafe paths", () => {
    const missing = resources();
    missing.delete("runtime.js");
    expect(() => freezeAmxd(editable(), "Listener.amxd", missing)).toThrow(
      "Missing frozen Node",
    );
    const bytes = freezeAmxd(editable(), "Listener.amxd", resources());
    expect(() => freezeAmxd(bytes, "Listener.amxd", resources())).toThrow(
      "already frozen",
    );
    for (const name of [
      "../outside.js",
      "/secret.js",
      "bad\\path.js",
      "bad\0.js",
      "é.js",
      "x".repeat(129),
    ]) {
      expect(() =>
        freezeAmxd(
          editable(),
          "Listener.amxd",
          new Map([...resources(), [name, Buffer.alloc(0)]]),
        ),
      ).toThrow("flat ASCII");
    }
    for (const name of ["Listener.amxd", "RUNTIME.JS"]) {
      expect(() =>
        freezeAmxd(
          editable(),
          "Listener.amxd",
          new Map([...resources(), [name, Buffer.alloc(0)]]),
        ),
      ).toThrow("Duplicate");
    }
  });

  it("rejects file/count/byte limit excess and invalid main flags", () => {
    const main = {
      name: "main.amxd",
      type: "JSON",
      flags: 17,
      data: Buffer.from("{}"),
    };
    expect(() => encodeMaxCollective([])).toThrow("count");
    expect(() =>
      encodeMaxCollective(Array.from({ length: 513 }, () => main)),
    ).toThrow("count");
    expect(() =>
      encodeMaxCollective([{ ...main, data: Buffer.alloc(64 * 1024 * 1024) }]),
    ).toThrow("byte bound");
    expect(() => encodeMaxCollective([{ ...main, flags: 8 }])).toThrow("flags");
  });

  it.each([
    "header",
    "directory",
    "chunk",
    "offset",
    "size",
    "flags",
    "name",
    "duplicate-field",
    "unknown-field",
    "version",
    "type",
  ])("rejects corrupt %s rather than accepting a partial archive", (kind) => {
    const frozen = freezeAmxd(editable(), "Listener.amxd", resources());
    const start = frozen.indexOf("ptch") + 8;
    const body = Buffer.from(frozen.subarray(start, frozen.length - 4));
    const directory = body.readUInt32BE(12);
    const field = (name: string) => body.indexOf(name, directory) + 8;
    if (kind === "header") body.writeUInt32BE(1, 8);
    if (kind === "directory") body.writeUInt32BE(body.length, 12);
    if (kind === "chunk") body.writeUInt32BE(0, directory + 4);
    if (kind === "offset") body.writeUInt32BE(0, field("of32"));
    if (kind === "size") body.writeUInt32BE(body.length, field("sz32"));
    if (kind === "flags") body.writeUInt32BE(8, field("flag"));
    if (kind === "name") body.write("../", field("fnam"));
    if (kind === "duplicate-field") body.write("flag", field("vers") - 8);
    if (kind === "unknown-field") body.write("oops", field("vers") - 8);
    if (kind === "version") body.writeUInt32BE(1, field("vers"));
    if (kind === "type") body[field("type")] = 255;
    expect(() => decodeMaxCollective(body)).toThrow();
  });

  it("rejects every truncation of a minimal collective", () => {
    const body = encodeMaxCollective([
      { name: "main.amxd", type: "JSON", flags: 17, data: Buffer.from("{}") },
    ]);
    for (let length = 0; length < body.length; length++)
      expect(() => decodeMaxCollective(body.subarray(0, length))).toThrow();
  });
});
