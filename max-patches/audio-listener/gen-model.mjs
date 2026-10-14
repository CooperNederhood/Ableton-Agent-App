// Test-only executable GenExpr subset; not a Max compiler or DSP timing oracle.
export function genModel(code, outputs, sampleRate = 48000) {
  if (/\be\s*=/.test(code))
    throw new Error("Gen constant e cannot be assigned");
  const state = {},
    initial = {},
    parameters = { sourceSampleRate: sampleRate };
  const histories = [],
    params = [];
  let js = code
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
  const declared = new Set([...histories, ...params, ...outputNames]);
  const locals = [
    ...new Set([...js.matchAll(/\b(\w+)\s*=(?!=)/g)].map((m) => m[1])),
  ].filter((name) => !declared.has(name));
  js = `${locals.length ? `let ${locals.join(",")};` : ""} let ${outputNames.join(",")};\n${js}`;
  js += "\n" + histories.map((name) => `state.${name} = ${name};`).join("\n");
  js += `\nreturn [${outputNames.join(",")}];`;
  const fn = new Function(
    "state",
    "params",
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
    },
  };
}
