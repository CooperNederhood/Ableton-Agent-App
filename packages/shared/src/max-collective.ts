import { Buffer } from "node:buffer";

// mx@c/dlst layout cross-checked against Ableton/maxdevtools' frozen-device reader.
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 512;
const MAC_EPOCH = 2_082_844_800;
const fields = ["type", "fnam", "sz32", "of32", "vers", "flag", "mdat"];

export interface FrozenMaxFile {
  readonly name: string;
  readonly type: string;
  readonly flags: number;
  readonly data: Buffer;
}

function checkName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/u.test(name))
    throw new Error("Frozen resource requires a bounded, flat ASCII name");
}

function number(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function chunk(tag: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(tag, "ascii"),
    number(data.length + 8),
    data,
  ]);
}

function chunks(bytes: Buffer, start: number, end: number) {
  const result: { tag: string; data: Buffer }[] = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8) throw new Error("Truncated frozen directory");
    const size = bytes.readUInt32BE(offset + 4);
    if (size < 8 || size > end - offset)
      throw new Error("Invalid frozen directory chunk size");
    result.push({
      tag: bytes.toString("latin1", offset, offset + 4),
      data: bytes.subarray(offset + 8, offset + size),
    });
    if (result.length > MAX_FILES)
      throw new Error("Frozen directory exceeds entry bound");
    offset += size;
  }
  return result;
}

export function encodeMaxCollective(files: readonly FrozenMaxFile[]): Buffer {
  if (files.length < 1 || files.length > MAX_FILES)
    throw new Error("Frozen file count exceeds bound");
  const names = new Set<string>();
  let offset = 16;
  const directory: Buffer[] = [];
  for (const [index, file] of files.entries()) {
    checkName(file.name);
    const key = file.name.toLowerCase();
    if (names.has(key)) throw new Error("Duplicate frozen resource name");
    names.add(key);
    if (
      !/^[\x20-\x7e]{4}$/u.test(file.type) ||
      (index === 0
        ? file.type !== "JSON" || file.flags !== 17
        : ![0, 8].includes(file.flags))
    )
      throw new Error("Invalid frozen resource type or flags");
    if (offset + file.data.length > MAX_BYTES)
      throw new Error("Frozen device exceeds byte bound");
    const name = Buffer.alloc(Math.ceil((file.name.length + 1) / 4) * 4);
    name.write(file.name, "ascii");
    directory.push(
      chunk(
        "dire",
        Buffer.concat([
          chunk("type", Buffer.from(file.type, "ascii")),
          chunk("fnam", name),
          chunk("sz32", number(file.data.length)),
          chunk("of32", number(offset)),
          chunk("vers", number(0)),
          chunk("flag", number(file.flags)),
          chunk("mdat", number(MAC_EPOCH)),
        ]),
      ),
    );
    offset += file.data.length;
  }
  const listing = chunk("dlst", Buffer.concat(directory));
  if (offset + listing.length > MAX_BYTES)
    throw new Error("Frozen device exceeds byte bound");
  return Buffer.concat([
    Buffer.from("mx@c", "ascii"),
    number(16),
    number(0),
    number(offset),
    ...files.map((file) => file.data),
    listing,
  ]);
}

export function decodeMaxCollective(bytes: Buffer): readonly FrozenMaxFile[] {
  if (
    bytes.length < 24 ||
    bytes.length > MAX_BYTES ||
    bytes.toString("ascii", 0, 4) !== "mx@c" ||
    bytes.readUInt32BE(4) !== 16 ||
    bytes.readUInt32BE(8) !== 0
  )
    throw new Error("Invalid or oversized frozen device header");
  const directoryOffset = bytes.readUInt32BE(12);
  if (directoryOffset < 16 || directoryOffset > bytes.length - 8)
    throw new Error("Frozen directory offset is out of bounds");
  const listing = chunks(bytes, directoryOffset, bytes.length);
  if (listing.length !== 1 || listing[0]!.tag !== "dlst")
    throw new Error("Missing frozen directory listing");
  const directory = listing[0]!.data;
  const result: FrozenMaxFile[] = [];
  const names = new Set<string>();
  let expectedOffset = 16;
  for (const entry of chunks(directory, 0, directory.length)) {
    if (entry.tag !== "dire") throw new Error("Invalid frozen directory entry");
    const attributes = new Map<string, Buffer>();
    for (const field of chunks(entry.data, 0, entry.data.length)) {
      if (!fields.includes(field.tag) || attributes.has(field.tag))
        throw new Error("Unknown or duplicate frozen resource field");
      attributes.set(field.tag, field.data);
    }
    if (attributes.size !== fields.length)
      throw new Error("Incomplete frozen resource fields");
    const readNumber = (name: string) => {
      const data = attributes.get(name)!;
      if (data.length !== 4) throw new Error("Invalid frozen numeric field");
      return data.readUInt32BE();
    };
    const rawName = attributes.get("fnam")!;
    const terminator = rawName.indexOf(0);
    if (
      terminator < 1 ||
      rawName.length % 4 !== 0 ||
      rawName.subarray(terminator).some((byte) => byte !== 0) ||
      rawName.subarray(0, terminator).some((byte) => byte > 127)
    )
      throw new Error("Invalid frozen resource filename");
    const name = rawName.toString("ascii", 0, terminator);
    checkName(name);
    if (names.has(name.toLowerCase()))
      throw new Error("Duplicate frozen resource name");
    names.add(name.toLowerCase());
    const type = attributes.get("type")!.toString("latin1");
    const flags = readNumber("flag");
    if (
      attributes.get("type")!.length !== 4 ||
      !/^[\x20-\x7e]{4}$/u.test(type) ||
      readNumber("vers") !== 0 ||
      (result.length === 0
        ? type !== "JSON" || flags !== 17
        : ![0, 8].includes(flags))
    )
      throw new Error("Invalid frozen resource type or flags");
    readNumber("mdat");
    const offset = readNumber("of32");
    const size = readNumber("sz32");
    if (offset !== expectedOffset || size > directoryOffset - offset)
      throw new Error("Frozen resources overlap or exceed the data section");
    expectedOffset += size;
    result.push({
      name,
      type,
      flags,
      data: bytes.subarray(offset, offset + size),
    });
  }
  if (result.length === 0 || expectedOffset !== directoryOffset)
    throw new Error("Frozen data does not match its directory");
  return result;
}
