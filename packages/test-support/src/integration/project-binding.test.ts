import { describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { bindFixtureProject } from "./project-binding.js";
import type { ListenerBinding } from "./contracts.js";

const sourcePath = "Presets/Machine-Listening-Development.amxd";
const binding: ListenerBinding = {
  slot: "AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:3",
  sourcePath,
  dependency: "machine-listening",
  trackIndex: 0,
  deviceIndex: 0,
};
const device = {
  id: "machine-listening",
  sourceTarget: "dependencies/machine-listening/source.amxd",
  target: "dependencies/machine-listening/frozen/Device.amxd",
  sha256: "a".repeat(64),
  bytes: 100,
};
const patch = (id: number, path = sourcePath) =>
  `<MxDeviceAudioEffect Id="${id}"><PatchSlot><Value><MxDPatchRef Id="1"><FileRef><RelativePathType Value="3" /><RelativePath Value="${path}" /><Path Value="/original/${path}" /></FileRef><SourceContext /></MxDPatchRef></Value></PatchSlot></MxDeviceAudioEffect>`;
const set = (devices = patch(3)) =>
  `<Ableton Version="11"><LiveSet><Tempo Value="120" /><Tracks><AudioTrack Id="175"><DeviceChain><DeviceChain><Devices>${devices}</Devices></DeviceChain></DeviceChain></AudioTrack></Tracks></LiveSet></Ableton>`;
const text = (bytes: Uint8Array) => gunzipSync(bytes).toString();

describe("declared saved listener bindings", () => {
  it("changes only declared reference paths, leaving source bytes and unrelated devices intact", () => {
    const original = set(patch(3) + patch(4, "Presets/Unrelated.amxd"));
    const input = gzipSync(original);
    const result = text(
      bindFixtureProject(input, [binding], [device], "/owned/Project & Copy"),
    );
    expect(text(input)).toBe(original);
    expect(result).toContain("/owned/Project &amp; Copy/dependencies/");
    expect(result).toContain(patch(4, "Presets/Unrelated.amxd"));
    const mask = (xml: string) =>
      xml.replace(/<MxDPatchRef Id="1">[\s\S]*?<\/MxDPatchRef>/u, "<bound/>");
    expect(mask(result)).toBe(mask(original));
  });
  it("binds multiple explicit instances without inferring placement", () => {
    const second = {
      ...binding,
      slot: binding.slot.replace(":3", ":4"),
      deviceIndex: 1,
    };
    const result = text(
      bindFixtureProject(
        gzipSync(set(patch(3) + patch(4))),
        [binding, second],
        [device],
        "/owned",
      ),
    );
    expect(result.match(/RelativePath Value="dependencies/g)).toHaveLength(2);
  });
  it.each([
    { ...binding, trackIndex: 1 },
    { ...binding, deviceIndex: 1 },
    { ...binding, slot: binding.slot.replace("175", "176") },
    { ...binding, sourcePath: "stale.amxd" },
  ])("rejects stale or wrong-target binding %j", (wrong) => {
    expect(() =>
      bindFixtureProject(gzipSync(set()), [wrong], [device], "/owned"),
    ).toThrow();
  });
  it("rejects missing, duplicated, additional and external listener references", () => {
    expect(() =>
      bindFixtureProject(gzipSync(set("")), [binding], [device], "/owned"),
    ).toThrow("Missing");
    expect(() =>
      bindFixtureProject(
        gzipSync(set()),
        [binding, binding],
        [device],
        "/owned",
      ),
    ).toThrow("Missing");
    expect(() =>
      bindFixtureProject(
        gzipSync(set(patch(3) + patch(4))),
        [binding],
        [device],
        "/owned",
      ),
    ).toThrow("Unreviewed");
    expect(() =>
      bindFixtureProject(
        gzipSync(
          set().replace(
            'RelativePathType Value="3"',
            'RelativePathType Value="6"',
          ),
        ),
        [binding],
        [device],
        "/owned",
      ),
    ).toThrow("differs");
    expect(() =>
      bindFixtureProject(gzipSync(set()), [binding], [], "/owned"),
    ).toThrow("Missing frozen");
  });
  it("rejects malformed or unsupported XML without partial output", () => {
    for (const xml of [
      set().replace("</Tracks>", "</Wrong>"),
      set().replace("<LiveSet>", "<!DOCTYPE test><LiveSet>"),
      set().replace("</MxDPatchRef>", ""),
    ])
      expect(() =>
        bindFixtureProject(gzipSync(xml), [binding], [device], "/owned"),
      ).toThrow();
  });
});
