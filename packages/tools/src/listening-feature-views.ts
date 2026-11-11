import {
  contextFeatureSchema,
  contextFeatureDerivationSchema,
  listeningFeatureDefinition,
  listeningFeatureGridSchema,
  listeningFeatureSchema,
  MAX_CONTEXT_FEATURES_PER_DERIVATION,
  MAX_ANALYZER_FRAMES,
  type ContextFeature,
  type ContextFeatureDerivation,
  type ListeningFeature,
} from "@ableton-agent/protocol";
import { z } from "zod";

export const MAX_FEATURE_PAGE_CELLS = 32;
export const contextFeatureDerivationViewSchema = z
  .strictObject(contextFeatureDerivationSchema.shape)
  .omit({ featureIds: true })
  .extend({
    featureCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONTEXT_FEATURES_PER_DERIVATION),
  })
  .superRefine((value, context) => {
    if (
      (value.status === "ready" &&
        (value.featureCount === 0 || value.reason !== null)) ||
      (value.status === "pending" &&
        (value.featureCount !== 0 || value.reason !== null)) ||
      (!["ready", "pending"].includes(value.status) && value.reason === null) ||
      (["failed", "cancelled"].includes(value.status) &&
        value.featureCount !== 0)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid derivation summary",
      });
  });

export function projectListeningFeatureDerivation(
  derivation: ContextFeatureDerivation,
) {
  const { featureIds, ...metadata } = derivation;
  return contextFeatureDerivationViewSchema.parse({
    ...metadata,
    featureCount: featureIds.length,
  });
}
const index = z.number().int().min(0).max(2000);
const channelSupportCountsSchema = z.tuple([
  index.max(MAX_ANALYZER_FRAMES),
  index.max(MAX_ANALYZER_FRAMES),
]);
const gridMetadataSchema = z
  .strictObject(listeningFeatureGridSchema.shape)
  .omit({ cells: true })
  .extend({
    cellCount: index,
  });
const featureIdentitySchema = z
  .strictObject(listeningFeatureSchema.shape)
  .omit({
    values: true,
    support: true,
    channelSupport: true,
    grid: true,
    profileKey: true,
    limitations: true,
  });
const featureMetadataSchema = featureIdentitySchema
  .extend({
    valueCount: z
      .number()
      .int()
      .min(0)
      .max(2000 * 48),
    supportIntervalCount: index,
    channelSupportIntervalCounts: channelSupportCountsSchema.optional(),
    grid: gridMetadataSchema.nullable(),
  })
  .superRefine((feature, context) => {
    const definition = listeningFeatureDefinition(feature.type);
    const count = definition.grid ? (feature.grid?.cellCount ?? 0) : 1;
    const channelAware =
      definition.profile === "pitch-profile/v1" ||
      definition.profile === "spectral-shape-profile/v1";
    if (
      feature.distanceDefinition !== definition.distanceDefinition ||
      feature.units !== definition.units ||
      feature.distanceUnits !== definition.distanceUnits ||
      feature.profile !== definition.profile ||
      feature.normalization !== definition.normalization ||
      channelAware !== (feature.channelSupportIntervalCounts !== undefined) ||
      channelAware !== (feature.channelReasons !== undefined) ||
      feature.coveredSamples > feature.expectedSamples ||
      (!definition.grid && feature.grid !== null) ||
      (feature.status === "ready" &&
        (feature.reason !== null ||
          count === 0 ||
          feature.valueCount !== count * definition.dimensions)) ||
      (feature.status === "unavailable" &&
        (feature.reason === null || feature.valueCount !== 0))
    )
      context.addIssue({
        code: "custom",
        message: "Invalid canonical feature metadata",
      });
  });
export const contextFeatureMetadataSchema = z
  .strictObject(contextFeatureSchema.shape)
  .extend({
    feature: featureMetadataSchema,
  });

export const listeningFeaturePageSchema = z
  .strictObject({
    offset: index,
    limit: z.number().int().min(1).max(MAX_FEATURE_PAGE_CELLS),
    totalCells: index,
    nextOffset: index.nullable(),
    dimensions: z.number().int().min(1).max(48),
    values: z
      .array(listeningFeatureSchema.shape.values.unwrap().element)
      .max(MAX_FEATURE_PAGE_CELLS * 48)
      .nullable(),
    cells: z
      .array(listeningFeatureGridSchema.shape.cells.element)
      .max(MAX_FEATURE_PAGE_CELLS),
    supportOffset: index,
    supportIntervals: listeningFeatureSchema.shape.support.max(
      MAX_FEATURE_PAGE_CELLS,
    ),
    totalSupportIntervals: index,
    nextSupportOffset: index.nullable(),
    channelSupportIntervals: z
      .tuple([
        listeningFeatureSchema.shape.support.max(MAX_FEATURE_PAGE_CELLS),
        listeningFeatureSchema.shape.support.max(MAX_FEATURE_PAGE_CELLS),
      ])
      .optional(),
    totalChannelSupportIntervals: channelSupportCountsSchema.optional(),
    nextChannelSupportOffsets: z
      .tuple([index.nullable(), index.nullable()])
      .optional(),
    profileKey: listeningFeatureSchema.shape.profileKey,
    limitations: listeningFeatureSchema.shape.limitations,
  })
  .superRefine((page, context) => {
    const {
      channelSupportIntervals,
      totalChannelSupportIntervals,
      nextChannelSupportOffsets,
    } = page;
    if (
      channelSupportIntervals !== undefined ||
      totalChannelSupportIntervals !== undefined ||
      nextChannelSupportOffsets !== undefined
    ) {
      if (
        channelSupportIntervals === undefined ||
        totalChannelSupportIntervals === undefined ||
        nextChannelSupportOffsets === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Incomplete channel support page",
        });
      } else {
        for (const channel of [0, 1] as const) {
          const total = totalChannelSupportIntervals[channel];
          const count = Math.max(
            0,
            Math.min(page.limit, total - page.supportOffset),
          );
          if (
            channelSupportIntervals[channel].length !== count ||
            nextChannelSupportOffsets[channel] !==
              (page.supportOffset + count < total
                ? page.supportOffset + count
                : null)
          )
            context.addIssue({
              code: "custom",
              message: "Invalid channel support continuation",
            });
        }
      }
    }
    const count = Math.max(
      0,
      Math.min(page.limit, page.totalCells - page.offset),
    );
    const supportCount = Math.max(
      0,
      Math.min(page.limit, page.totalSupportIntervals - page.supportOffset),
    );
    if (
      (page.values !== null &&
        page.values.length !== count * page.dimensions) ||
      (page.cells.length !== 0 && page.cells.length !== count) ||
      page.supportIntervals.length !== supportCount ||
      page.nextOffset !==
        (page.offset + count < page.totalCells ? page.offset + count : null) ||
      page.nextSupportOffset !==
        (page.supportOffset + supportCount < page.totalSupportIntervals
          ? page.supportOffset + supportCount
          : null)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid feature value/support page continuation",
      });
  });

export function listeningFeaturePageMasksMatch(
  feature: z.infer<typeof featureMetadataSchema>,
  page: z.infer<typeof listeningFeaturePageSchema>,
): boolean {
  const definition = listeningFeatureDefinition(feature.type);
  const channelAware = feature.channelReasons !== undefined;
  if (
    page.cells.some(
      (cell) =>
        channelAware !== (cell.channelReasons !== undefined) ||
        channelAware !== (cell.channelCoveredSamples !== undefined) ||
        (cell.reason === null &&
          cell.coveredSamples !== cell.expectedSamples) ||
        cell.channelCoveredSamples?.some(
          (covered, channel) =>
            covered > cell.coveredSamples ||
            (cell.channelReasons?.[channel] === null &&
              covered !== cell.expectedSamples),
        ),
    )
  )
    return false;
  return (
    page.values === null ||
    page.values.every((value, index) => {
      const channel = index % definition.dimensions;
      const cell = page.cells[Math.floor(index / definition.dimensions)];
      const reason = definition.grid
        ? channelAware
          ? cell?.channelReasons?.[channel]
          : cell?.reason
        : channelAware
          ? feature.channelReasons?.[channel]
          : null;
      return (value === null) === (reason !== null);
    })
  );
}

export function projectListeningFeatureRecord(record: ContextFeature) {
  const { values, support, channelSupport, grid } = record.feature;
  const metadata = featureIdentitySchema.strip().parse(record.feature);
  const gridMetadata =
    grid === null
      ? null
      : {
          stepBeats: grid.stepBeats,
          meter: grid.meter,
          phaseBeats: grid.phaseBeats,
          cellCount: grid.cells.length,
        };
  return contextFeatureMetadataSchema.parse({
    ...record,
    feature: {
      ...metadata,
      valueCount: values?.length ?? 0,
      supportIntervalCount: support.length,
      ...(channelSupport === undefined
        ? {}
        : {
            channelSupportIntervalCounts: channelSupport.map(
              (intervals) => intervals.length,
            ),
          }),
      grid: gridMetadata,
    },
  });
}

export function projectListeningFeaturePage(
  feature: ListeningFeature,
  offset: number,
  limit: number,
  supportOffset: number,
) {
  const definition = listeningFeatureDefinition(feature.type);
  const totalCells = definition.grid ? (feature.grid?.cells.length ?? 0) : 1;
  const end = Math.min(totalCells, offset + limit);
  const supportEnd = Math.min(feature.support.length, supportOffset + limit);
  return listeningFeaturePageSchema.parse({
    offset,
    limit,
    totalCells,
    nextOffset: end < totalCells ? end : null,
    dimensions: definition.dimensions,
    values:
      feature.values?.slice(
        offset * definition.dimensions,
        end * definition.dimensions,
      ) ?? null,
    cells: feature.grid?.cells.slice(offset, end) ?? [],
    supportOffset,
    supportIntervals: feature.support.slice(supportOffset, supportEnd),
    totalSupportIntervals: feature.support.length,
    nextSupportOffset: supportEnd < feature.support.length ? supportEnd : null,
    ...(feature.channelSupport === undefined
      ? {}
      : {
          channelSupportIntervals: feature.channelSupport.map((intervals) =>
            intervals.slice(supportOffset, supportOffset + limit),
          ),
          totalChannelSupportIntervals: feature.channelSupport.map(
            (intervals) => intervals.length,
          ),
          nextChannelSupportOffsets: feature.channelSupport.map((intervals) =>
            supportOffset + limit < intervals.length
              ? supportOffset + limit
              : null,
          ),
        }),
    profileKey: feature.profileKey,
    limitations: feature.limitations,
  });
}
