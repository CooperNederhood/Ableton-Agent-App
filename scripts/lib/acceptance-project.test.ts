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
  verifyInstalledLiveResources,
  readSavedFollowAction,
} from "../../tests/electron/acceptance-project.js";

function document(relative: string, kind = "3") {
  return gzipSync(
    `<Ableton MajorVersion="5"><FileRef><RelativePathType Value="${kind}"/><RelativePath Value="${relative}"/><Path Value="/authoring/source.wav"/></FileRef></Ableton>`,
  );
}

describe("saved fixture dependency admission", () => {
  it("retains bounded Drum Rack preset history during intake without enlarging active dependency admission", () => {
    const ref =
      '<FileRef><RelativePathType Value="5"/><RelativePath Value="Samples/kick.wav"/><Path Value="/installed/kick.wav"/></FileRef>';
    const source = (count: number) =>
      gzipSync(
        `<Ableton Version="11"><SourceContext>${ref.repeat(count)}</SourceContext>${ref}</Ableton>`,
      );
    expect(readAcceptanceProjectReferences(source(229))).toHaveLength(230);
    expect(readAcceptanceProjectReferences(source(229), true)).toHaveLength(1);
    expect(() => readAcceptanceProjectReferences(source(512))).toThrow(
      "reference count",
    );
    expect(() =>
      readAcceptanceProjectReferences(
        gzipSync(`<Ableton Version="11">${ref.repeat(129)}</Ableton>`),
        true,
      ),
    ).toThrow("reference count");
  });
  it.each(["Audio", "Midi"])(
    "reads the exact saved %s Session follow-action flag without substituting missing evidence",
    (kind) => {
      const clip = (value: string) =>
        `<ClipSlot><ClipSlot><Value><${kind}Clip><FollowAction><FollowActionEnabled Value="${value}"/></FollowAction></${kind}Clip></Value></ClipSlot></ClipSlot>`;
      const xml = `<Ableton Version="11"><LiveSet><Tracks><${kind}Track><DeviceChain><MainSequencer><ClipSlotList>${clip("true")}${clip("false")}</ClipSlotList></MainSequencer></DeviceChain></${kind}Track></Tracks></LiveSet></Ableton>`;
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
    },
  );
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
  it("admits only explicitly pinned Core Library references, independently of Builtin declarations", () => {
    const bytes = document("Samples/kick.wav", "5");
    const declared = [
      { path: "Samples/kick.wav", bytes: 3, sha256: "a".repeat(64) },
    ];
    expect(
      inspectAcceptanceProject(bytes, new Set(), false, [], declared),
    ).toEqual([]);
    expect(() =>
      inspectAcceptanceProject(bytes, new Set(), false, declared),
    ).toThrow("dependency");
    expect(() =>
      inspectAcceptanceProject(
        document("Samples/kick.wav", "0"),
        new Set(),
        false,
        [],
        declared,
      ),
    ).toThrow("dependency");
    expect(() =>
      inspectAcceptanceProject(
        document("../kick.wav", "5"),
        new Set(),
        false,
        [],
        [{ ...declared[0]!, path: "../kick.wav" }],
      ),
    ).toThrow("Unsafe");
  });
  it.each(["Builtin", "Core Library"] as const)(
    "verifies licensed %s files in place and rejects drift, symlinks, missing files and cancellation",
    async (library) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "acceptance-builtin-")),
      );
      const path = "Samples/IR.wav";
      const parent = join(root, "Contents/App-Resources", library, "Samples");
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
        expect(
          await verifyInstalledLiveResources(resources, root, signal, library),
        ).toMatch(/^[a-f0-9]{64}$/u);
        await expect(
          verifyInstalledLiveResources(
            resources,
            root,
            AbortSignal.abort(),
            library,
          ),
        ).rejects.toThrow();
        await writeFile(join(parent, "IR.wav"), Buffer.alloc(bytes.length));
        await expect(
          verifyInstalledLiveResources(resources, root, signal, library),
        ).rejects.toThrow("hash mismatch");
        await rm(join(parent, "IR.wav"));
        await expect(
          verifyInstalledLiveResources(resources, root, signal, library),
        ).rejects.toThrow("ENOENT");
        await writeFile(join(root, "outside"), bytes);
        await symlink(join(root, "outside"), join(parent, "IR.wav"));
        await expect(
          verifyInstalledLiveResources(resources, root, signal, library),
        ).rejects.toThrow("symlink");
        await expect(
          verifyInstalledLiveResources(
            [{ ...resources[0]!, path: "../outside" }],
            root,
            signal,
            library,
          ),
        ).rejects.toThrow("Unsafe");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
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
