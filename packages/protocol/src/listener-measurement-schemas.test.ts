import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  LISTENER_MEASUREMENT_COUNTER_MAX,
  listenerMeasurementDeclarationSchema,
  listenerMeasurementReadbackSchema,
  listenerMeasurementRecordSchema,
  type ListenerMeasurementDeclaration,
} from "./listener-measurement-schemas.js";

const require = createRequire(import.meta.url);
const core =
  require("../../../max-patches/audio-listener/audio_listener_measurements.js") as {
    validateDeclaration: (value: unknown) => unknown;
    validateRecord: (value: unknown, declaration: unknown) => unknown;
    createReader: (options: {
      declaration: unknown;
      epoch: number;
      consume: (value: unknown) => boolean;
    }) => { begin: () => unknown; poll: (row: number[]) => { status: string } };
  };
function declaration(
  width = 13,
  sampleRate: 44_100 | 48_000 = 48_000,
): ListenerMeasurementDeclaration {
  return {
    version: 1,
    kind: "future-vector",
    algorithmVersion: "v1",
    sampleRate,
    hopSamples: 64,
    windowSamples: 2048,
    width,
    capacity: 32,
    fields: Array.from({ length: width }, (_, i) => ({
      name: `field${i}`,
      unit: "linear",
    })),
  };
}
function record(d = declaration()) {
  return {
    version: 1 as const,
    kind: d.kind,
    epoch: 7,
    sequence: 1,
    startSample: 2 ** 35,
    endSample: 2 ** 35 + 64,
    values: Array.from({ length: d.width }, (_, i) => i + 0.125),
  };
}
function accepts(fn: () => unknown) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

describe("bounded measurement protocol agrees with classic Max core", () => {
  it("supports explicit future declarations at both rates and all bounded dimensions", () => {
    for (const width of [1, 6, 13, 16, 64]) {
      for (const rate of [44_100, 48_000] as const) {
        const d = declaration(width, rate);
        expect(listenerMeasurementDeclarationSchema.parse(d)).toEqual(
          core.validateDeclaration(d),
        );
        expect(listenerMeasurementRecordSchema(d).parse(record(d))).toEqual(
          core.validateRecord(record(d), d),
        );
      }
    }
  });

  it("rejects undeclared, wrong dimension, unbounded and arbitrary JSON declarations", () => {
    const base = declaration();
    const invalid: unknown[] = [
      null,
      {},
      { ...base, width: 65 },
      { ...base, width: 0 },
      { ...base, capacity: 0 },
      { ...base, capacity: 129 },
      { ...base, sampleRate: 96000 },
      { ...base, hopSamples: Infinity },
      { ...base, hopSamples: 65537 },
      { ...base, windowSamples: -1 },
      { ...base, hopSamples: 0.1 },
      { ...base, fields: [] },
      { ...base, algorithmVersion: "" },
      { ...base, kind: "x".repeat(65) },
      { ...base, extra: {} },
      { ...base, fields: base.fields.map(() => base.fields[0]) },
      { ...base, fields: base.fields.map((f) => ({ ...f, extra: true })) },
      { ...base, kind: "native-envelope", algorithmVersion: "v2" },
    ];
    for (const value of invalid) {
      expect(
        listenerMeasurementDeclarationSchema.safeParse(value).success,
      ).toBe(false);
      expect(accepts(() => core.validateDeclaration(value))).toBe(false);
    }
    expect(() =>
      listenerMeasurementRecordSchema(
        null as unknown as ListenerMeasurementDeclaration,
      ),
    ).toThrow();
  });

  it("pins current native payload widths/capacities without interpreting fields", () => {
    for (const [kind, width, capacity] of [
      ["native-envelope", 16, 16],
      ["native-spectrum", 6, 32],
      ["native-envelope/v2", 16, 16],
      ["native-spectrum/v2", 6, 32],
    ] as const) {
      const d = {
        ...declaration(width),
        kind,
        capacity,
        algorithmVersion: "2.0.0",
      };
      expect(listenerMeasurementDeclarationSchema.parse(d)).toEqual(
        core.validateDeclaration(d),
      );
    }
  });

  it("validates exact large counters, finite payloads and descriptor-only normalized records", () => {
    const d = declaration();
    const valid = {
      ...record(d),
      sequence: LISTENER_MEASUREMENT_COUNTER_MAX,
      endSample: LISTENER_MEASUREMENT_COUNTER_MAX,
      values: Array(13).fill(Number.MAX_SAFE_INTEGER) as number[],
    };
    expect(listenerMeasurementRecordSchema(d).parse(valid)).toEqual(
      core.validateRecord(valid, d),
    );
    const candidates = [
      { ...valid, sequence: 0 },
      { ...valid, sequence: 2 ** 44 },
      { ...valid, epoch: 1_000_001 },
      { ...valid, epoch: 0 },
      { ...valid, startSample: -1 },
      { ...valid, endSample: valid.startSample - 1 },
      { ...valid, endSample: 2 ** 44 },
      { ...valid, kind: "unknown" },
      { ...valid, values: [1] },
      { ...valid, sourceId: "fabricated" },
      ...[NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1"].map(
        (value) => ({ ...valid, values: Array(13).fill(value) as unknown[] }),
      ),
    ];
    for (const value of candidates) {
      expect(listenerMeasurementRecordSchema(d).safeParse(value).success).toBe(
        accepts(() => core.validateRecord(value, d)),
      );
      expect(listenerMeasurementRecordSchema(d).safeParse(value).success).toBe(
        false,
      );
    }
  });

  it("checks the fixed width+14 wire layout against reader guards", () => {
    for (const width of [1, 13, 64]) {
      const d = declaration(width);
      const data = record(d);
      const row = [
        1,
        7,
        1,
        7,
        1,
        data.startSample,
        data.endSample,
        1,
        0,
        0,
        ...data.values,
        1,
        7,
        1,
        7,
      ];
      expect(listenerMeasurementReadbackSchema(d).parse(row)).toEqual(row);
      const empty = [...row];
      empty[3] =
        empty[4] =
        empty[7] =
        empty[width + 10] =
        empty[width + 11] =
          0;
      expect(
        listenerMeasurementReadbackSchema(d).safeParse(empty).success,
      ).toBe(true);
      const noOwner = Array<number>(width + 14).fill(0);
      noOwner[0] = 1;
      for (const requested of [0, 1]) {
        noOwner[2] = noOwner[width + 12] = requested;
        expect(
          listenerMeasurementReadbackSchema(d).safeParse(noOwner).success,
        ).toBe(true);
        const reader = core.createReader({
          declaration: d,
          epoch: 7,
          consume: () => true,
        });
        reader.begin();
        expect(reader.poll(noOwner).status).toBe("waiting");
      }
      for (const index of [0, 3, 5, 7, 8, 9, 10, width + 13]) {
        const dirty = [...noOwner];
        dirty[index] = 2;
        expect(
          listenerMeasurementReadbackSchema(d).safeParse(dirty).success,
        ).toBe(false);
      }
      const mutations: ((r: number[]) => void)[] = [
        (r) => {
          r.pop();
        },
        (r) => {
          r[0] = 2;
        },
        (r) => {
          r[9] = 1;
        },
        (r) => {
          r[9] = 2;
        },
        (r) => {
          r[10] = NaN;
        },
        (r) => {
          r[7] = 33;
        },
        (r) => {
          r[6] = r[5]! - 1;
        },
        (r) => {
          r[3] = r[width + 11] = 6;
        },
      ];
      for (const mutate of mutations) {
        const bad = [...row];
        mutate(bad);
        const reader = core.createReader({
          declaration: d,
          epoch: 7,
          consume: () => true,
        });
        reader.begin();
        expect(
          listenerMeasurementReadbackSchema(d).safeParse(bad).success,
        ).toBe(false);
        expect(reader.poll(bad).status).toBe("failed");
      }
      for (const index of [width + 10, width + 11, width + 12, width + 13]) {
        const torn = [...row];
        torn[index] = torn[index]! + 1;
        let accepted = 0;
        const reader = core.createReader({
          declaration: d,
          epoch: 7,
          consume: () => {
            accepted++;
            return true;
          },
        });
        reader.begin();
        expect(
          listenerMeasurementReadbackSchema(d).safeParse(torn).success,
        ).toBe(false);
        expect(reader.poll(torn).status).toBe("unstable");
        expect(accepted).toBe(0);
        expect(reader.poll(row).status).toBe("settling");
        expect(reader.poll(row).status).toBe("accepted");
        expect(accepted).toBe(1);
      }
    }
  });

  it("version grammar supports semantic versions but keeps native algorithm identity pinned", () => {
    for (const algorithmVersion of [
      "2.0.0",
      "2.0.0-beta.1+build5",
      "v1",
      "2".repeat(64),
    ]) {
      const d = { ...declaration(), algorithmVersion };
      expect(listenerMeasurementDeclarationSchema.parse(d)).toEqual(
        core.validateDeclaration(d),
      );
    }
    for (const algorithmVersion of [
      "",
      "2".repeat(65),
      "2/0/0",
      "2.0.0 secret",
    ]) {
      const d = { ...declaration(), algorithmVersion };
      expect(listenerMeasurementDeclarationSchema.safeParse(d).success).toBe(
        false,
      );
      expect(accepts(() => core.validateDeclaration(d))).toBe(false);
    }
    const oldAbiVersion = {
      ...declaration(16),
      kind: "native-envelope",
      capacity: 16,
      algorithmVersion: "v2",
    };
    expect(
      listenerMeasurementDeclarationSchema.safeParse(oldAbiVersion).success,
    ).toBe(false);
    expect(accepts(() => core.validateDeclaration(oldAbiVersion))).toBe(false);
  });
});
