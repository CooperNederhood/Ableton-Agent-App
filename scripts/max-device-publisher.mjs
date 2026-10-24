// Runtime primitives are shared with the packaged installer, not reimplemented here.
export {
  decodeAmxd,
  encodeAmxd,
  renderPortableDevice,
  renderInstalledDevice,
  publishResources,
} from "../packages/shared/dist/max-device.js";
