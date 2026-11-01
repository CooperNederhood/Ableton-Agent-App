import { retainedMeasurementSource } from "./retained-measurement-source.mjs";
import {
  descriptiveEnvelopeCode,
  musicalEnvelopeCode,
  MUSICAL_CONFIGURATION_FIELDS,
  MUSICAL_RECORD_FIELDS,
} from "./synchronized-envelope-source.mjs";
import { descriptiveSpectrumCode } from "./synchronized-spectrum-source.mjs";
import { genDocument } from "./native-source.mjs";

// Prototype compositions only. Production graph selection requires native-host
// readback/compilation evidence and a matching versioned reader handshake.
export function retainedNativeSpectrumSource() {
  const retention = retainedMeasurementSource({
    capacity: 32,
    firstOutput: 12,
    values: [
      "publishedEnd",
      "publishedCentroid",
      "publishedEnergy",
      "publishedStart",
      "publishedEnd",
      "invalidFrames",
    ],
    startSample: "publishedStart",
    endSample: "publishedEnd",
    publish:
      "publishedEnd >= 2048 && (publishedEnd != retainedSpectrumEnd || invalidFrames != retainedInvalidFrames)",
  });
  const code = `${retention.declarations}
History retainedSpectrumOwner(0);
History retainedSpectrumEnd(-1); History retainedInvalidFrames(-1);
${descriptiveSpectrumCode()}
out11 = 2;
if (measurementEpoch != retainedSpectrumOwner) {
 retainedSpectrumOwner = measurementEpoch;
 retainedSpectrumEnd = -1; retainedInvalidFrames = -1;
}
${retention.step}
retainedSpectrumEnd = publishedEnd; retainedInvalidFrames = invalidFrames;
${retention.outputs}`;
  return Object.freeze({ code, retention, outputs: 31 });
}

export function retainedNativeEnvelopeSource() {
  const retention = retainedMeasurementSource({
    capacity: 16,
    firstOutput: 24,
    values: Array.from({ length: 16 }, (_, index) => `out${index + 1}`),
    startSample: "out15 + retainedEnvelopeCompleted",
    endSample: "out15 + out13",
    publish:
      "seenEpoch == measurementEpoch && out13 > 0 && out13 != retainedEnvelopeCompleted",
  });
  const code = `${retention.declarations}
History retainedEnvelopeEpoch(0); History retainedEnvelopeCompleted(0);
${descriptiveEnvelopeCode({ configurationReadback: true })}
if (seenEpoch != retainedEnvelopeEpoch) {
 retainedEnvelopeEpoch = seenEpoch; retainedEnvelopeCompleted = 0;
}
${retention.step}
if (seenEpoch == measurementEpoch && out13 > 0) { retainedEnvelopeCompleted = out13; }
${retention.outputs}`;
  return Object.freeze({ code, retention, outputs: 53 });
}

// Explicit opt-in only: no selection by nativeRuntimeDocuments or installed
// capability. Both independent descriptor rings reuse the existing capacity16
// machinery; a slow reader faults rather than growing or overwriting records.
export function retainedMusicalEnvelopeSource() {
  const recordNames = [
    "Sequence",
    "Start",
    "End",
    "Count",
    "PeakL",
    "PeakR",
    "SumL",
    "SumR",
  ];
  const family = (name, firstOutput) =>
    retainedMeasurementSource({
      name: `${name}Measurement`,
      capacity: 16,
      firstOutput,
      values: recordNames.map((field) => `${name}Published${field}`),
      startSample: `out7 + ${name}PublishedStart`,
      endSample: `out7 + ${name}PublishedEnd`,
      publish: `epoch > 0 && epoch == seenEpoch && seenEpoch == ${name}MeasurementEpoch && rejected == 0 && ${name}PublishedSequence > retained${name === "level" ? "Level" : "Attack"}Sequence`,
    });
  const level = family("level", 21);
  const attacks = family("attack", 43);
  const code = `${level.declarations}
${attacks.declarations}
History retainedMusicalEpoch(0);
History retainedLevelSequence(0); History retainedAttackSequence(0);
${musicalEnvelopeCode({ compactReadback: true })}
if (retainedMusicalEpoch != seenEpoch) {
 retainedMusicalEpoch = seenEpoch;
 retainedLevelSequence = 0; retainedAttackSequence = 0;
}
${level.step}
${attacks.step}
retainedLevelSequence = levelPublishedSequence;
retainedAttackSequence = attackPublishedSequence;
${level.outputs}
${attacks.outputs}`;
  return Object.freeze({
    code,
    outputs: 64,
    envelopeAbi: 3,
    configurationVersion: 1,
    configuration: Object.freeze({
      firstOutput: 9,
      fields: MUSICAL_CONFIGURATION_FIELDS,
    }),
    timingFields: Object.freeze([
      "seenEpoch",
      "launchClock",
      "rejected",
      "active",
      "launchPhaseSamples",
      "armCounter",
      "originCounter",
      "envelopeAbi",
    ]),
    readbacks: Object.freeze({
      level: Object.freeze({ firstOutput: 21, width: 22 }),
      attacks: Object.freeze({ firstOutput: 43, width: 22 }),
    }),
    fields: MUSICAL_RECORD_FIELDS,
    coordinates: "capture-local-values/native-source-headers",
    level,
    attacks,
  });
}

export function retainedMusicalEnvelopeDocument() {
  return genDocument(retainedMusicalEnvelopeSource().code, 4, 64, {
    outputSpacing: 12,
  });
}

export function retainedNativePrototypeDocuments() {
  const document = (source, inputs) => {
    const result = genDocument(source.code, inputs, source.outputs);
    for (const { box } of result.patcher.boxes) {
      if (box.id === "code") box.patching_rect[2] = 430;
      if (/^out\d+$/.test(box.id)) {
        const index = Number(box.id.slice(3));
        box.patching_rect = [
          550 + Math.floor(index / 19) * 80,
          20 + (index % 19) * 18,
          60,
          22,
        ];
      }
    }
    return result;
  };
  return {
    "retained-envelope-prototype.gendsp": document(
      retainedNativeEnvelopeSource(),
      4,
    ),
    "retained-spectrum-prototype.gendsp": document(
      retainedNativeSpectrumSource(),
      7,
    ),
  };
}
