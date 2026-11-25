import { describe, expect, it, vi } from "vitest";
import type { BrowserItemSummary } from "@ableton-agent/protocol";
import { addListenerDevice } from "./listener-device.js";

let next = 0;
const uuid = () =>
  `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;

function item(
  name: string,
  path: BrowserItemSummary["path"],
  loadable = false,
): BrowserItemSummary {
  return {
    reference: uuid(),
    root: "user_library",
    path,
    name,
    uri: `query:${name}`,
    isFolder: !loadable,
    isLoadable: loadable,
    isDevice: loadable,
    source: "User Library",
    isBuiltInDevice: false,
  };
}

function fakeLive() {
  const root = item("User Library", []);
  const tree = new Map<string, BrowserItemSummary[]>();
  let parent = root;
  for (const name of [
    "Presets",
    "Audio Effects",
    "Max Audio Effect",
    "Machine-Listening-Development",
  ]) {
    const child = item(name, [...parent.path, { index: 0, name }]);
    tree.set(parent.reference, [item("Other", []), child]);
    parent = child;
  }
  const device = item(
    "Machine-Listening-Development.amxd",
    [...parent.path, { index: 0, name: "Machine-Listening-Development.amxd" }],
    true,
  );
  tree.set(parent.reference, [device]);
  return {
    device,
    ableton: {
      inspectSession: vi.fn(async () => ({
        tracks: [{ index: 2, reference: "track-keys", name: "Keys" }],
      })),
      inspectBrowserRoots: vi.fn(async () => ({
        roots: [{ ...item("Sounds", []), root: "sounds" as const }, root],
        cacheLimit: 512,
      })),
      inspectBrowserChildren: vi.fn(
        async ({
          expectedItemReference,
        }: {
          expectedItemReference: string;
        }) => ({
          items: tree.get(expectedItemReference) ?? [],
          hasMore: false,
        }),
      ),
      loadBrowserItem: vi.fn(async () => ({ loaded: true })),
    },
  };
}

describe("addListenerDevice", () => {
  it("walks the User Library and loads the device onto the chosen track", async () => {
    const { ableton, device } = fakeLive();
    await addListenerDevice(ableton as never, "track-keys");
    expect(ableton.loadBrowserItem).toHaveBeenCalledWith({
      index: 2,
      expectedReference: "track-keys",
      expectedName: "Keys",
      expectedItemReference: device.reference,
      expectedItemRoot: "user_library",
      expectedItemPath: device.path,
      expectedItemName: device.name,
      expectedItemUri: device.uri,
    });
  });

  it("explains how to install the device when it is missing", async () => {
    const { ableton } = fakeLive();
    ableton.inspectBrowserChildren.mockResolvedValue({
      items: [],
      hasMore: false,
    });
    await expect(
      addListenerDevice(ableton as never, "track-keys"),
    ).rejects.toThrow(/Install the Ableton integrations/u);
    expect(ableton.loadBrowserItem).not.toHaveBeenCalled();
  });
});
