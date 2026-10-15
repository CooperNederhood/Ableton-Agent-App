const {
  NativeCaptureController,
} = require("./audio_listener_native_controller.js");
const OWNER = { passId: "v2-pass", connectionEpoch: "v2-connection" };

function v2Fixture(options = {}) {
  let now = 0;
  const rate = options.rate ?? 48000;
  const total = options.total ?? rate;
  const geometry = {
    sampleRate: rate,
    vectorSize: options.vector ?? 64,
    tempoBpm: 93,
    startBeat: 5.25,
    endBeat: 5.25 + (total * 93) / (rate * 60),
    hopSamples: rate / 10,
    totalSamples: total,
    ...options.geometry,
  };
  const timingPolicy = options.policy ?? {
    mode: "descriptive",
    maxClockDisagreementSamples: 64,
  };
  const command = {
    ...OWNER,
    traceId: "v2-trace",
    correlationId: "v2-correlation",
    causationId: "v2-root",
    geometry,
    timingPolicy,
  };
  const sent = [],
    events = [],
    observed = [],
    armed = [];
  const controller =
    options.controller ??
    new NativeCaptureController({
      listenerId: "v2-listener",
      nativeVersion: 2,
      now: () => now,
      send: (value) => {
        sent.push(value);
        return options.send?.(value) ?? true;
      },
      onArmed: (value) => {
        armed.push(value);
        return options.onArmed?.(value) ?? true;
      },
      emit: (value) => {
        events.push(value);
        return options.emit?.(value);
      },
      observe: (value) => {
        observed.push(value);
        options.observe?.(value);
      },
      onDisarmed: options.onDisarmed,
    });
  const launchPhase = Math.min(64, geometry.vectorSize);
  const armCounter = 65536,
    origin = armCounter + 512;
  const offset = options.offset ?? 1000000;
  const fftBaseline = 64000;
  const packet = (type, values, generation = controller.pass?.generation) =>
    controller.ingest({ generation, type, values });
  const clock = (
    counter,
    playing = true,
    deviation = options.deviation ?? 0,
  ) => {
    const beat = playing
      ? geometry.startBeat +
        (counter - origin) / ((rate * 60) / geometry.tempoBpm)
      : geometry.startBeat;
    const sample = counter + offset + (playing ? deviation : 0);
    return [
      Number(playing),
      beat,
      sample,
      31,
      counter,
      beat % 1,
      counter,
      Number(playing),
      beat,
      sample,
      31,
    ];
  };
  const spectrum = (end, centroid = rate / 32, energy = 1) => [
    end,
    centroid,
    energy,
    end - 2048,
    end,
    11,
  ];
  const envelope = (count = 0) => [
    controller.pass?.nativeEpoch ?? 0,
    512 + launchPhase,
    -1,
    0,
    0,
    count === total ? 0 : 1,
    launchPhase,
    -1,
    ...(options.silent
      ? [0, 0, 0, 0]
      : (options.envelopeLevels?.(count) ?? [0.8, 0.6, 0.3, 0.2])),
    count,
    armCounter,
    origin,
    2,
  ];
  const preflight = () => {
    for (const [type, values] of [
      ["dsp", [1, rate, geometry.vectorSize]],
      ["tempo", [geometry.tempoBpm]],
      ["fftInfo", [2048, 2048, 2048, 1]],
      ["abi-clock", [2]],
      ["abi-envelope", [2]],
      ["abi-spectrum", [2]],
    ])
      packet(type, values);
    packet("envelope", [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 2]);
    packet("spectrum", spectrum(fftBaseline, 0, 0));
    for (let i = 0; i < 32; i++)
      packet("clock", clock(armCounter - (32 - i) * 64, false));
  };
  const ack = () =>
    packet("envelope", [
      controller.pass?.nativeEpoch,
      -1,
      -1,
      0,
      0,
      0,
      -1,
      -1,
      0,
      0,
      0,
      0,
      0,
      armCounter,
      -1,
      2,
    ]);
  const configReceipt = () =>
    packet("config", [
      controller.pass?.nativeEpoch,
      total,
      geometry.hopSamples,
      geometry.tempoBpm,
      geometry.startBeat % 1,
      geometry.vectorSize,
      controller.pass?.nativeEpoch,
    ]);
  const start = async () => {
    controller.prepare(command);
    const pending = controller.arm(OWNER);
    preflight();
    configReceipt();
    ack();
    await pending;
    packet("clock", clock(origin + 640));
    packet("envelope", envelope());
  };
  const capture = () => {
    let nextFFT = fftBaseline + 2048;
    for (
      let count = geometry.hopSamples;
      ;
      count = Math.min(count + geometry.hopSamples, total)
    ) {
      const end = origin + count;
      packet("clock", clock(end + 64));
      while (nextFFT <= end) {
        packet(
          "spectrum",
          spectrum(
            nextFFT,
            options.silent
              ? 0
              : rate / (16 + (Math.floor(nextFFT / 2048) % 3) * 8),
            options.silent ? 0 : 1 + (Math.floor(nextFFT / 2048) % 3),
          ),
        );
        nextFFT += 2048;
      }
      packet("envelope", envelope(count));
      if (count === total || !controller.pass) break;
    }
  };
  const post = () => {
    for (let i = 0; i < 32; i++)
      packet("clock", clock(origin + total + 128 + i * 64));
  };
  return {
    controller,
    command,
    geometry,
    timingPolicy,
    sent,
    events,
    observed,
    armed,
    packet,
    clock,
    spectrum,
    envelope,
    preflight,
    ack,
    configReceipt,
    start,
    capture,
    post,
    armCounter,
    origin,
    time: (value) => {
      now = value;
      options.setTime?.(value);
    },
  };
}
module.exports = { v2Fixture, V2_OWNER: OWNER };
