import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  inspectAcceptanceProject,
  readAcceptanceProjectReferences,
  verifyBuiltinResources,
  readSavedFollowAction,
} from "../../tests/electron/acceptance-project.js";

function document(relative: string, kind = "3") {
  return gzipSync(
    `<Ableton MajorVersion="5"><FileRef><RelativePathType Value="${kind}"/><RelativePath Value="${relative}"/><Path Value="/authoring/source.wav"/></FileRef></Ableton>`,
  );
}

describe("saved fixture dependency admission", () => {
  it("reads only the exact saved Session follow-action flag and never substitutes false for missing evidence", () => {
    const clip = (value: string) =>
      `<ClipSlot><ClipSlot><Value><AudioClip><FollowAction><FollowActionEnabled Value="${value}"/></FollowAction></AudioClip></Value></ClipSlot></ClipSlot>`;
    const xml = `<Ableton Version="11"><LiveSet><Tracks><AudioTrack><DeviceChain><MainSequencer><ClipSlotList>${clip("true")}${clip("false")}</ClipSlotList></MainSequencer></DeviceChain></AudioTrack></Tracks></LiveSet></Ableton>`;
    const bytes = gzipSync(xml);
    expect(readSavedFollowAction(bytes, 0, 0)).toBe(true);
    expect(readSavedFollowAction(bytes, 0, 1)).toBe(false);
    expect(() => readSavedFollowAction(bytes, 1, 0)).toThrow("Missing");
    expect(() => readSavedFollowAction(bytes, 0, 2)).toThrow("Missing");
    expect(() =>
      readSavedFollowAction(
        gzipSync(xml.replace('Value="false"', 'Value="unknown"')),
        0,
        1,
      ),
    ).toThrow("Missing");
    expect(() =>
      readSavedFollowAction(
        gzipSync(xml.replace("<FollowActionEnabled", "<Unknown")),
        0,
        0,
      ),
    ).toThrow("Missing");
  });
  it("excludes last-preset provenance but still requires declared active Builtin media", () => {
    const ref =
      '<FileRef><RelativePathType Value="7"/><RelativePath Value="Samples/IR.wav"/><Path Value="/installed/IR.wav"/></FileRef>';
    const bytes = gzipSync(
      `<Ableton Version="11"><LastPresetRef><Value>${ref}</Value></LastPresetRef><SampleRef>${ref}</SampleRef></Ableton>`,
    );
    expect(readAcceptanceProjectReferences(bytes)).toHaveLength(2);
    expect(readAcceptanceProjectReferences(bytes, true)).toHaveLength(1);
    expect(() => inspectAcceptanceProject(bytes, new Set(), false)).toThrow(
      "dependency",
    );
    const declared = [
      { path: "Samples/IR.wav", bytes: 3, sha256: "a".repeat(64) },
    ];
    expect(inspectAcceptanceProject(bytes, new Set(), false, declared)).toEqual(
      [],
    );
    expect(() =>
      inspectAcceptanceProject(
        document("Samples/IR.wav", "0"),
        new Set(),
        false,
        declared,
      ),
    ).toThrow("dependency");
    expect(() =>
      readAcceptanceProjectReferences(
        gzipSync(
          '<Ableton Version="11"><LastPresetRef></SourceContext></Ableton>',
        ),
        true,
      ),
    ).toThrow("Unbalanced");
  });
  it("verifies licensed Builtin files in place and rejects drift, symlinks, missing files and cancellation", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "acceptance-builtin-")),
    );
    const path = "Samples/IR.wav";
    const parent = join(root, "Contents/App-Resources/Builtin/Samples");
    const bytes = Buffer.from("controlled impulse response");
    const resources = [
      {
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ];
    const signal = new AbortController().signal;
    try {
      await mkdir(parent, { recursive: true });
      await writeFile(join(parent, "IR.wav"), bytes);
      expect(await verifyBuiltinResources(resources, root, signal)).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      await expect(
        verifyBuiltinResources(resources, root, AbortSignal.abort()),
      ).rejects.toThrow();
      await writeFile(join(parent, "IR.wav"), Buffer.alloc(bytes.length));
      await expect(
        verifyBuiltinResources(resources, root, signal),
      ).rejects.toThrow("hash mismatch");
      await rm(join(parent, "IR.wav"));
      await expect(
        verifyBuiltinResources(resources, root, signal),
      ).rejects.toThrow("ENOENT");
      await writeFile(join(root, "outside"), bytes);
      await symlink(join(root, "outside"), join(parent, "IR.wav"));
      await expect(
        verifyBuiltinResources(resources, root, signal),
      ).rejects.toThrow("symlink");
      await expect(
        verifyBuiltinResources(
          [{ ...resources[0]!, path: "../outside" }],
          root,
          signal,
        ),
      ).rejects.toThrow("Unsafe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("distinguishes inactive source history from active resource dependencies without changing intake reports", () => {
    const ref =
      '<FileRef><RelativePathType Value="6"/><RelativePath Value="historic.amxd"/><Path Value="/library/historic.amxd"/></FileRef>';
    const bytes = gzipSync(
      `<Ableton Version="11"><SourceContext>${ref}</SourceContext></Ableton>`,
    );
    expect(readAcceptanceProjectReferences(bytes)).toHaveLength(1);
    expect(inspectAcceptanceProject(bytes, new Set(), false)).toEqual([]);
    expect(() =>
      inspectAcceptanceProject(
        gzipSync(`<Ableton Version="11">${ref}</Ableton>`),
        new Set(),
        false,
      ),
    ).toThrow();
    expect(
      inspectAcceptanceProject(
        gzipSync(
          `<Ableton Version="11"><SourceContext /><SourceContext><SourceContext>${ref}</SourceContext></SourceContext></Ableton>`,
        ),
        new Set(),
        false,
      ),
    ).toEqual([]);
    expect(() =>
      inspectAcceptanceProject(
        gzipSync(`<Ableton Version="11"><SourceContext>${ref}</Ableton>`),
        new Set(),
        false,
      ),
    ).toThrow("Unterminated");
  });
  it("admits declared relative references without changing bytes", () => {
    const source = document("media/source.wav");
    const original = Buffer.from(source);
    expect(
      inspectAcceptanceProject(source, new Set(["media/source.wav"])),
    ).toEqual(["media/source.wav"]);
    expect(source).toEqual(original);
  });
  it.each([
    "../source.wav",
    "/source.wav",
    "media/other.wav",
    "media\\source.wav",
  ])("rejects unsafe or undeclared reference %s", (path) => {
    expect(() =>
      inspectAcceptanceProject(document(path), new Set(["media/source.wav"])),
    ).toThrow("dependency");
  });
  it("does not accept an absolute-reference fallback", () => {
    expect(() =>
      inspectAcceptanceProject(
        document("media/source.wav", "0"),
        new Set(["media/source.wav"]),
      ),
    ).toThrow("dependency");
  });
  it("rejects entity declarations and unrelated bytes", () => {
    expect(() =>
      inspectAcceptanceProject(
        gzipSync('<!DOCTYPE x><Ableton MajorVersion="5"/>'),
        new Set(),
      ),
    ).toThrow("document");
    expect(() =>
      inspectAcceptanceProject(Buffer.from("not a Set"), new Set()),
    ).toThrow();
  });
});
