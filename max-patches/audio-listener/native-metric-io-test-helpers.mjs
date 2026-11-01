import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import vm from "node:vm";
import { genModel } from "./gen-model.mjs";
import { retainedNativeSpectrumSource } from "./retained-native-source.mjs";

const require = createRequire(import.meta.url);
export const { NativeMessageIO } = require("./audio_listener_native_io.js");
export const GENERATION = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const EPOCH = 7;

export function spectrumFixture(options = {}) {
  const source = retainedNativeSpectrumSource();
  // Test instrumentation of the executed counter; not a production graph tap.
  const model = genModel(
    `${source.code}\nout32 = sourceClock;`,
    32,
    options.rate ?? 48000,
  );
  const packets = [],
    controls = [],
    diagnostics = [],
    pending = [];
  let time = 10,
    nextCounter = 65536,
    frame,
    io;
  const control = (value) => {
    controls.push([...value]);
    if (value[0].startsWith("measurement")) {
      if (
        options.deferControls ||
        (options.deferDisable &&
          value[0] === "measurementEpoch" &&
          value[1] === 0)
      )
        pending.push(value);
      else model.configure({ [value[0]]: value[1] });
    }
    return options.control?.(value, io);
  };
  io = new NativeMessageIO(
    "spectrum",
    (packet) => {
      packets.push(packet);
      return options.send?.(packet, io);
    },
    control,
    (reason) => diagnostics.push(reason),
    { now: () => (options.now ? options.now(time) : time) },
  );
  function advance() {
    let output;
    do {
      const counter = nextCounter++;
      output = model.step(
        0,
        0,
        0,
        0,
        counter % 2048,
        counter % 1048576,
        Math.floor(counter / 1048576),
      );
    } while ((nextCounter - 1) % 2048 !== 2047);
    frame = [output[31], ...output.slice(11, 31), output[31]];
    return frame;
  }
  return {
    io,
    model,
    packets,
    controls,
    diagnostics,
    advance,
    get frame() {
      return frame;
    },
    get time() {
      return time;
    },
    setTime(value) {
      time = value;
    },
    begin: (generation = GENERATION, epoch = EPOCH) =>
      io.begin(generation, epoch, options.rate ?? 48000),
    poll: (value = frame, generation = GENERATION, epoch = EPOCH) =>
      io.retainedSpectrumFrame(generation, epoch, value),
    request: (outcome = "complete", deadline = 100) =>
      io.requestSpectrumStop(GENERATION, EPOCH, outcome, deadline),
    evidence: () => io.spectrumCleanupEvidence(GENERATION, EPOCH),
    flush() {
      for (const [name, value] of pending.splice(0))
        model.configure({ [name]: value });
    },
  };
}

export function classicFixture(
  mode = "spectrum",
  args = [mode, "metric-v1"],
  options = {},
) {
  const f = spectrumFixture();
  const packets = [],
    controls = [],
    controlDeliveryKinds = [],
    diagnostics = [];
  let throwGetter = false;
  const context = vm.createContext({
    ...(options.maxRequire ? { require: () => ({}) } : {}),
    jsarguments: ["audio_listener_native_io.js", ...args],
    Date: class {
      getTime() {
        return f.time;
      }
    },
    outlet(index, ...args) {
      const value =
        args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      if (index === 0) {
        if (throwGetter && value[0] === "native_metric_spectrum_cleanup")
          throw new Error("private getter transport failure");
        packets.push(JSON.parse(JSON.stringify(value)));
      } else {
        controlDeliveryKinds.push(
          args.length === 1 && Array.isArray(args[0]) ? "list" : "named",
        );
        controls.push([...value]);
        if (value[0].startsWith("measurement"))
          f.model.configure({ [value[0]]: value[1] });
      }
    },
    post: (value) => diagnostics.push(value),
    arrayfromargs: (values) => Array.from(values),
    include(file) {
      vm.runInContext(
        readFileSync(new URL(file, import.meta.url), "utf8"),
        context,
      );
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("./audio_listener_native_io.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  return {
    f,
    context,
    packets,
    controls,
    controlDeliveryKinds,
    diagnostics,
    setThrowGetter(value) {
      throwGetter = value;
    },
  };
}
