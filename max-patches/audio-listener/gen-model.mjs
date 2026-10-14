// Test-only executable GenExpr subset; not a Max compiler or DSP timing oracle.
export function genModel(code, outputs, sampleRate = 48000) {
  if (/\be\s*=/.test(code))
    throw new Error("Gen constant e cannot be assigned");
  const state = {},
    initial = {},
    delays = {},
    parameters = { sourceSampleRate: sampleRate };
  const histories = [],
    params = [],
    delayNames = [];
  let js = code
    .replace(/Delay (\w+)\((\d+)\);/g, (_, name, size) => {
      size = Number(size);
      if (size < 1 || size > 65536) throw new Error("unsupported model delay");
      const buffer = new Float64Array(size);
      let position = 0;
      delayNames.push(name);
      delays[name] = {
        read(samples) {
          if (!Number.isInteger(samples) || samples < 1 || samples > size)
            throw new Error("unsupported model delay read");
          return buffer[(position - samples + size) % size];
        },
        write(value) {
          buffer[position] = value;
          position = (position + 1) % size;
        },
        reset() {
          buffer.fill(0);
          position = 0;
        },
      };
      return `const ${name} = delays.${name};`;
    })
    .replace(/History (\w+)\(([^)]+)\);/g, (_, name, value) => {
      histories.push(name);
      initial[name] = state[name] = Number(value);
      return `let ${name} = state.${name};`;
    })
    .replace(/Param (\w+)\(([^)]+)\);/g, (_, name, value) => {
      params.push(name);
      return `let ${name} = params.${name} ?? ${value};`;
    });
  const outputNames = Array.from({ length: outputs }, (_, i) => `out${i + 1}`);
  const declared = new Set([
    ...histories,
    ...params,
    ...delayNames,
    ...outputNames,
  ]);
  const locals = [
    ...new Set([...js.matchAll(/\b(\w+)\s*=(?!=)/g)].map((m) => m[1])),
  ].filter((name) => !declared.has(name));
  js = `${locals.length ? `let ${locals.join(",")};` : ""} let ${outputNames.join(",")};\n${js}`;
  js += "\n" + histories.map((name) => `state.${name} = ${name};`).join("\n");
  js += `\nreturn [${outputNames.join(",")}];`;
  const fn = new Function(
    "state",
    "params",
    "delays",
    "samplerate",
    "in1",
    "in2",
    "in3",
    "in4",
    "in5",
    "max",
    "min",
    "abs",
    "sqrt",
    "round",
    "floor",
    js,
  );
  return {
    step(...values) {
      return fn(
        state,
        parameters,
        delays,
        sampleRate,
        ...Array.from({ length: 5 }, (_, i) => values[i] ?? 0),
        Math.max,
        Math.min,
        Math.abs,
        Math.sqrt,
        Math.round,
        Math.floor,
      );
    },
    configure(values) {
      Object.assign(parameters, values);
    },
    reset() {
      Object.assign(state, initial);
      for (const delay of Object.values(delays)) delay.reset();
    },
  };
}
