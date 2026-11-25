import type { AbletonService } from "@ableton-agent/ableton-contracts";
import type {
  BrowserItemSummary,
  LoadBrowserItemResult,
} from "@ableton-agent/protocol";

const DEVICE_NAME = "Machine-Listening-Development";
/** Where the Ableton integrations installer puts the device in the User Library. */
const LIBRARY_PATH = [
  "Presets",
  "Audio Effects",
  "Max Audio Effect",
  DEVICE_NAME,
] as const;

type BrowserPort = Pick<
  AbletonService,
  | "inspectSession"
  | "inspectBrowserRoots"
  | "inspectBrowserChildren"
  | "loadBrowserItem"
>;

const target = (item: BrowserItemSummary) => ({
  expectedItemReference: item.reference,
  expectedItemRoot: item.root,
  expectedItemPath: item.path,
  expectedItemName: item.name,
  expectedItemUri: item.uri,
});

async function children(
  ableton: BrowserPort,
  parent: BrowserItemSummary,
): Promise<BrowserItemSummary[]> {
  const items: BrowserItemSummary[] = [];
  for (let offset = 0; ; offset += 64) {
    const page = await ableton.inspectBrowserChildren({
      ...target(parent),
      offset,
      limit: 64,
    });
    items.push(...page.items);
    if (!page.hasMore || offset + 64 > 4096) return items;
  }
}

/** Loads the installed Machine Listening device onto the end of a track's device chain. */
export async function addListenerDevice(
  ableton: BrowserPort,
  trackReference: string,
): Promise<LoadBrowserItemResult> {
  const session = await ableton.inspectSession();
  const track = session.tracks.find(
    ({ reference }) => reference === trackReference,
  );
  if (track === undefined) throw new Error("That track is no longer in Live");
  const { roots } = await ableton.inspectBrowserRoots();
  let item = roots.find(({ root }) => root === "user_library");
  for (const name of LIBRARY_PATH) {
    if (item === undefined) break;
    item = (await children(ableton, item)).find((child) => child.name === name);
  }
  const device =
    item === undefined
      ? undefined
      : (await children(ableton, item)).find(
          ({ name, isLoadable }) => isLoadable && name.startsWith(DEVICE_NAME),
        );
  if (device === undefined) {
    throw new Error(
      `${DEVICE_NAME} is not installed in the User Library. Install the Ableton integrations from Settings, then try again.`,
    );
  }
  return ableton.loadBrowserItem({
    index: track.index,
    expectedReference: track.reference,
    expectedName: track.name,
    ...target(device),
  });
}
