function expression(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[;{}\r\n]/.test(value)
  )
    throw new Error("invalid_retained_measurement_expression");
  return value;
}

/** Private, fixed-size descriptor storage; no audio buffer or shared Max memory. */
export function retainedMeasurementSource({
  name = "measurement",
  capacity,
  values,
  publish,
  startSample,
  endSample,
  firstOutput = 1,
}) {
  if (
    !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(name) ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 128 ||
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 64 ||
    !Number.isInteger(firstOutput) ||
    firstOutput < 1 ||
    firstOutput > 256
  )
    throw new Error("invalid_retained_measurement_configuration");
  values.forEach(expression);
  [publish, startSample, endSample].forEach(expression);
  const width = values.length;
  const parameter = {
    epoch: `${name}Epoch`,
    requestedSequence: `${name}ReadSequence`,
    acknowledgedSequence: `${name}Acknowledged`,
  };
  const variable = (suffix) => `${name}${suffix}`;
  const epoch = variable("Owner");
  const produced = variable("Produced");
  const acknowledged = variable("AcceptedAck");
  const fault = variable("Fault");
  const data = variable("Records");
  const requested = variable("Requested");
  const readIndex = variable("ReadIndex");
  const next = variable("Next");
  const writeIndex = variable("WriteIndex");
  const validEpoch = variable("ValidEpoch");
  const slotEpoch = variable("SlotEpoch");
  const slotSequence = variable("SlotSequence");
  const slotStart = variable("SlotStart");
  const slotEnd = variable("SlotEnd");
  const selected = variable("Selected");
  const slotValues = values.map((_, index) => variable(`Value${index}`));
  const declarations = [
    `Param ${parameter.epoch}(0);`,
    `Param ${parameter.requestedSequence}(1);`,
    `Param ${parameter.acknowledgedSequence}(0);`,
    `History ${epoch}(0); History ${produced}(0);`,
    `History ${acknowledged}(0); History ${fault}(0);`,
    `History ${selected}(0);`,
    ...[slotEpoch, slotSequence, slotStart, slotEnd, ...slotValues].map(
      (value) => `History ${value}(0);`,
    ),
    `Data ${data}(${capacity}, ${width + 4});`,
  ].join("\n");
  const step = `${validEpoch} = ${parameter.epoch} >= 0 &&
 ${parameter.epoch} <= 1000000 && floor(${parameter.epoch}) == ${parameter.epoch};
if (${validEpoch} && ${parameter.epoch} != ${epoch}) {
 ${epoch} = ${parameter.epoch}; ${produced} = 0; ${acknowledged} = 0; ${fault} = 0;
 ${selected} = 0;
 ${[slotEpoch, slotSequence, slotStart, slotEnd, ...slotValues].map((value) => `${value} = 0;`).join(" ")}
}
${requested} = ${parameter.requestedSequence};
if (!${validEpoch}) { ${fault} = 2; }
if (${epoch} > 0 && ${fault} == 0) {
 if (!(${parameter.acknowledgedSequence} >= ${acknowledged} &&
   ${parameter.acknowledgedSequence} <= ${acknowledged} + 1 &&
   ${parameter.acknowledgedSequence} <= ${produced} &&
   floor(${parameter.acknowledgedSequence}) == ${parameter.acknowledgedSequence} &&
   ${requested} >= ${parameter.acknowledgedSequence} + 1 &&
   ${requested} <= ${produced} + 1 && floor(${requested}) == ${requested})) {
  ${fault} = 2;
 } else {
  ${acknowledged} = ${parameter.acknowledgedSequence};
 }
}
if (${epoch} > 0 && ${fault} == 0 && (${publish})) {
 if (${produced} - ${acknowledged} >= ${capacity}) {
  ${fault} = 1;
 } else if (floor((${produced} + 1) / 1048576) >= 16777216) {
  ${fault} = 2;
 } else {
  ${next} = ${produced} + 1;
  ${writeIndex} = ${next} - 1 - ${capacity} * floor((${next} - 1) / ${capacity});
  poke(${data}, ${epoch}, ${writeIndex}, 0);
  poke(${data}, ${startSample}, ${writeIndex}, 2);
  poke(${data}, ${endSample}, ${writeIndex}, 3);
${values.map((value, index) => `  poke(${data}, ${value}, ${writeIndex}, ${index + 4});`).join("\n")}
  poke(${data}, ${next}, ${writeIndex}, 1);
  ${produced} = ${next};
 }
}
if (${requested} != ${selected}) {
 ${selected} = ${requested};
 ${[slotEpoch, slotSequence, slotStart, slotEnd, ...slotValues].map((value) => `${value} = 0;`).join(" ")}
}
if (${epoch} > 0 && ${fault} == 0 && ${requested} >= 1 &&
 ${requested} <= ${produced} && floor(${requested}) == ${requested} &&
 (${slotSequence} != ${requested} || ${slotEpoch} != ${epoch})) {
 ${readIndex} = ${requested} - 1 - ${capacity} * floor((${requested} - 1) / ${capacity});
 ${slotEpoch} = peek(${data}, ${readIndex}, 0);
 ${slotSequence} = peek(${data}, ${readIndex}, 1);
 ${slotStart} = peek(${data}, ${readIndex}, 2);
 ${slotEnd} = peek(${data}, ${readIndex}, 3);
${slotValues.map((value, index) => ` ${value} = peek(${data}, ${readIndex}, ${index + 4});`).join("\n")}
}`;
  const outputValues = [
    "1",
    epoch,
    requested,
    slotEpoch,
    slotSequence,
    slotStart,
    slotEnd,
    produced,
    acknowledged,
    fault,
    ...slotValues,
    slotSequence,
    slotEpoch,
    requested,
    epoch,
  ];
  const outputs = outputValues
    .map((value, index) => `out${firstOutput + index} = ${value};`)
    .join("\n");
  return Object.freeze({
    declarations,
    step,
    outputs,
    parameters: Object.freeze(parameter),
    width,
    capacity,
    readbackWidth: outputValues.length,
    storageBytes: capacity * (width + 4) * 8,
  });
}
