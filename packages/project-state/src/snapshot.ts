import {
  arrangementClipSummarySchema,
  cuePointSummarySchema,
  deviceSummarySchema,
  entityKindSchema,
  entityReferenceSchema,
  projectSnapshotSchema,
  revisionSchema,
  sceneSummarySchema,
  sessionClipSummarySchema,
  trackSummarySchema,
  transportSummarySchema,
  type EntityKind,
  type EntityReference,
  type ArrangementClipSummary,
  type CuePointSummary,
  type DeviceSummary,
  type ProjectIdentity,
  type ProjectSnapshot,
  type SceneSummary,
  type SessionClipSummary,
  type TrackSummary,
  type TransportSummary,
} from "./schemas.js";

export type EntitySummary =
  | TrackSummary
  | SceneSummary
  | SessionClipSummary
  | ArrangementClipSummary
  | DeviceSummary
  | CuePointSummary;

export interface NormalizedSnapshot {
  readonly project: ProjectIdentity;
  readonly revision: number;
  readonly liveVersion: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly transport: TransportSummary;
  readonly entities: ReadonlyMap<
    EntityKind,
    ReadonlyMap<string, EntitySummary>
  >;
  readonly selected: readonly EntityReference[];
  readonly stale: ReadonlySet<string>;
  readonly lastSequence?: number;
}

export type SnapshotChange =
  | {
      readonly type: "entity.upserted";
      readonly kind: EntityKind;
      readonly entity: EntitySummary;
    }
  | { readonly type: "entity.removed"; readonly reference: EntityReference }
  | {
      readonly type: "entities.invalidated";
      readonly references: readonly EntityReference[];
    }
  | {
      readonly type: "selection.changed";
      readonly selected: readonly EntityReference[];
    }
  | {
      readonly type: "transport.changed";
      readonly transport: TransportSummary;
    };

export interface SnapshotEvent {
  readonly projectId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly change: SnapshotChange;
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).find((key) => !keys.includes(key));
  if (unexpected !== undefined) {
    throw new TypeError(`${label} has unexpected key '${unexpected}'`);
  }
  return input;
}

function referenceArray(value: unknown, label: string): EntityReference[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((item) => entityReferenceSchema.parse(item));
}

function parseUpsertEntity(kind: EntityKind, value: unknown): EntitySummary {
  switch (kind) {
    case "track":
    case "return-track":
    case "master-track": {
      const track = trackSummarySchema.parse(value);
      if (trackKind(track) !== kind) {
        throw new TypeError("Track entity kind does not match event kind");
      }
      return track;
    }
    case "scene":
      return sceneSummarySchema.parse(value);
    case "session-clip":
      return sessionClipSummarySchema.parse(value);
    case "arrangement-clip":
      return arrangementClipSummarySchema.parse(value);
    case "device":
      return deviceSummarySchema.parse(value);
    case "cue-point":
      return cuePointSummarySchema.parse(value);
  }
}

function parseSnapshotChange(value: unknown): SnapshotChange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("snapshot change must be an object");
  }
  const base = value as Record<string, unknown>;
  switch (base.type) {
    case "entity.upserted": {
      const input = strictRecord(
        base,
        ["type", "kind", "entity"],
        "entity upsert",
      );
      const kind = entityKindSchema.parse(input.kind);
      return {
        type: "entity.upserted",
        kind,
        entity: parseUpsertEntity(kind, input.entity),
      };
    }
    case "entity.removed": {
      const input = strictRecord(base, ["type", "reference"], "entity removal");
      return {
        type: "entity.removed",
        reference: entityReferenceSchema.parse(input.reference),
      };
    }
    case "entities.invalidated": {
      const input = strictRecord(
        base,
        ["type", "references"],
        "entity invalidation",
      );
      return {
        type: "entities.invalidated",
        references: referenceArray(input.references, "references"),
      };
    }
    case "selection.changed": {
      const input = strictRecord(
        base,
        ["type", "selected"],
        "selection change",
      );
      return {
        type: "selection.changed",
        selected: referenceArray(input.selected, "selected"),
      };
    }
    case "transport.changed": {
      const input = strictRecord(
        base,
        ["type", "transport"],
        "transport change",
      );
      return {
        type: "transport.changed",
        transport: transportSummarySchema.parse(input.transport),
      };
    }
    default:
      throw new TypeError("Unknown snapshot change type");
  }
}

export const snapshotEventSchema = {
  parse(value: unknown): SnapshotEvent {
    const input = strictRecord(
      value,
      ["projectId", "revision", "sequence", "change"],
      "snapshot event",
    );
    const sequence = revisionSchema.parse(input.sequence);
    return {
      projectId: entityReferenceSchema.parse({
        projectId: input.projectId,
        kind: "track",
        id: "_",
        revision: 0,
      }).projectId,
      revision: revisionSchema.parse(input.revision),
      sequence,
      change: parseSnapshotChange(input.change),
    };
  },
};

export type RefreshRequest =
  | { readonly scope: "none" }
  | {
      readonly scope: "targeted";
      readonly references: readonly EntityReference[];
      readonly reason: "unknown-detail";
    }
  | {
      readonly scope: "full";
      readonly reason:
        "project-mismatch" | "revision-regression" | "sequence-gap";
    };

export interface EventApplication {
  readonly snapshot: NormalizedSnapshot;
  readonly refresh: RefreshRequest;
  readonly applied: boolean;
}

const kinds: readonly EntityKind[] = [
  "track",
  "return-track",
  "master-track",
  "scene",
  "session-clip",
  "arrangement-clip",
  "device",
  "cue-point",
];

function keyOf(reference: Pick<EntityReference, "kind" | "id">): string {
  return `${reference.kind}:${reference.id}`;
}

function mutableIndexes(
  snapshot?: NormalizedSnapshot,
): Map<EntityKind, Map<string, EntitySummary>> {
  const indexes = new Map<EntityKind, Map<string, EntitySummary>>();
  for (const kind of kinds) {
    indexes.set(kind, new Map(snapshot?.entities.get(kind)));
  }
  return indexes;
}

function insertUnique(
  indexes: Map<EntityKind, Map<string, EntitySummary>>,
  kind: EntityKind,
  entity: EntitySummary,
): void {
  const index = indexes.get(kind);
  if (index === undefined) {
    throw new Error(`Unknown entity kind: ${kind}`);
  }
  if (index.has(entity.id)) {
    throw new Error(`Duplicate ${kind} id: ${entity.id}`);
  }
  index.set(entity.id, entity);
}

function trackKind(track: TrackSummary): EntityKind {
  if (track.kind === "return") {
    return "return-track";
  }
  if (track.kind === "master") {
    return "master-track";
  }
  return "track";
}

export function normalizeSnapshot(input: ProjectSnapshot): NormalizedSnapshot {
  const snapshot = projectSnapshotSchema.parse(input);
  const indexes = mutableIndexes();
  for (const track of snapshot.tracks) {
    insertUnique(indexes, trackKind(track), track);
  }
  for (const scene of snapshot.scenes) {
    insertUnique(indexes, "scene", scene);
  }
  for (const clip of snapshot.sessionClips) {
    insertUnique(indexes, "session-clip", clip);
  }
  for (const clip of snapshot.arrangementClips) {
    insertUnique(indexes, "arrangement-clip", clip);
  }
  for (const device of snapshot.devices) {
    insertUnique(indexes, "device", device);
  }
  for (const cuePoint of snapshot.cuePoints) {
    insertUnique(indexes, "cue-point", cuePoint);
  }

  const trackIds = new Set(
    snapshot.tracks.map((track) => `${trackKind(track)}:${track.id}`),
  );
  const hasTrack = (id: string): boolean =>
    trackIds.has(`track:${id}`) ||
    trackIds.has(`return-track:${id}`) ||
    trackIds.has(`master-track:${id}`);
  const sceneIds = new Set(snapshot.scenes.map((scene) => scene.id));
  for (const clip of snapshot.sessionClips) {
    if (!hasTrack(clip.trackId) || !sceneIds.has(clip.sceneId)) {
      throw new Error(`Session clip '${clip.id}' has an invalid parent`);
    }
  }
  for (const entity of [...snapshot.arrangementClips, ...snapshot.devices]) {
    if (!hasTrack(entity.trackId)) {
      throw new Error(`Entity '${entity.id}' has an invalid track`);
    }
  }

  for (const reference of snapshot.selected) {
    if (
      reference.projectId !== snapshot.project.id ||
      reference.revision !== snapshot.revision ||
      indexes.get(reference.kind)?.has(reference.id) !== true
    ) {
      throw new Error("Selected reference does not belong to snapshot");
    }
  }

  return {
    project: snapshot.project,
    revision: snapshot.revision,
    liveVersion: snapshot.liveVersion,
    capabilities: { ...snapshot.capabilities },
    transport: snapshot.transport,
    entities: indexes,
    selected: snapshot.selected,
    stale: new Set(),
  };
}

function sameProject(
  snapshot: NormalizedSnapshot,
  references: readonly EntityReference[],
): boolean {
  return references.every(
    (reference) => reference.projectId === snapshot.project.id,
  );
}

function hasTrack(
  indexes: Map<EntityKind, Map<string, EntitySummary>>,
  trackId: string,
): boolean {
  return (
    indexes.get("track")?.has(trackId) === true ||
    indexes.get("return-track")?.has(trackId) === true ||
    indexes.get("master-track")?.has(trackId) === true
  );
}

function assertValidParent(
  indexes: Map<EntityKind, Map<string, EntitySummary>>,
  kind: EntityKind,
  entity: EntitySummary,
): void {
  if (kind === "session-clip") {
    const clip = entity as SessionClipSummary;
    if (
      !hasTrack(indexes, clip.trackId) ||
      indexes.get("scene")?.has(clip.sceneId) !== true
    ) {
      throw new StaleReferenceError(
        `Session clip '${clip.id}' has a stale or missing parent`,
      );
    }
  }
  if (kind === "arrangement-clip" || kind === "device") {
    const child = entity as ArrangementClipSummary | DeviceSummary;
    if (!hasTrack(indexes, child.trackId)) {
      throw new StaleReferenceError(
        `${kind} '${child.id}' has a stale or missing track`,
      );
    }
  }
}

function removeDependents(
  indexes: Map<EntityKind, Map<string, EntitySummary>>,
  stale: Set<string>,
  removedReference: EntityReference,
): Set<string> {
  const removed = new Set([keyOf(removedReference)]);
  if (
    removedReference.kind === "track" ||
    removedReference.kind === "return-track" ||
    removedReference.kind === "master-track"
  ) {
    for (const kind of [
      "session-clip",
      "arrangement-clip",
      "device",
    ] as const) {
      const index = indexes.get(kind);
      for (const [id, entity] of index ?? []) {
        if ((entity as { trackId: string }).trackId === removedReference.id) {
          index?.delete(id);
          removed.add(`${kind}:${id}`);
          stale.delete(`${kind}:${id}`);
        }
      }
    }
  } else if (removedReference.kind === "scene") {
    const index = indexes.get("session-clip");
    for (const [id, entity] of index ?? []) {
      if ((entity as SessionClipSummary).sceneId === removedReference.id) {
        index?.delete(id);
        removed.add(`session-clip:${id}`);
        stale.delete(`session-clip:${id}`);
      }
    }
  }
  return removed;
}

export function applySnapshotEvent(
  current: NormalizedSnapshot,
  rawEvent: SnapshotEvent,
): EventApplication {
  const event = snapshotEventSchema.parse(rawEvent);
  if (event.projectId !== current.project.id) {
    return {
      snapshot: current,
      refresh: { scope: "full", reason: "project-mismatch" },
      applied: false,
    };
  }
  if (event.revision < current.revision) {
    return {
      snapshot: current,
      refresh: { scope: "full", reason: "revision-regression" },
      applied: false,
    };
  }
  if (
    current.lastSequence !== undefined &&
    event.sequence !== current.lastSequence + 1
  ) {
    return {
      snapshot: current,
      refresh: { scope: "full", reason: "sequence-gap" },
      applied: false,
    };
  }

  const indexes = mutableIndexes(current);
  const stale = new Set(current.stale);
  let selected = current.selected;
  let transport = current.transport;
  let refresh: RefreshRequest = { scope: "none" };

  switch (event.change.type) {
    case "entity.upserted": {
      const index = indexes.get(event.change.kind);
      if (index === undefined) {
        throw new Error(`Unknown entity kind: ${event.change.kind}`);
      }
      assertValidParent(indexes, event.change.kind, event.change.entity);
      index.set(event.change.entity.id, event.change.entity);
      stale.delete(
        keyOf({ kind: event.change.kind, id: event.change.entity.id }),
      );
      break;
    }
    case "entity.removed": {
      const removedReference = event.change.reference;
      if (!sameProject(current, [removedReference])) {
        return {
          snapshot: current,
          refresh: { scope: "full", reason: "project-mismatch" },
          applied: false,
        };
      }
      indexes.get(removedReference.kind)?.delete(removedReference.id);
      stale.delete(keyOf(removedReference));
      const removedKeys = removeDependents(indexes, stale, removedReference);
      selected = selected.filter(
        (reference) => !removedKeys.has(keyOf(reference)),
      );
      break;
    }
    case "entities.invalidated": {
      if (!sameProject(current, event.change.references)) {
        return {
          snapshot: current,
          refresh: { scope: "full", reason: "project-mismatch" },
          applied: false,
        };
      }
      for (const reference of event.change.references) {
        stale.add(keyOf(reference));
      }
      refresh = {
        scope: "targeted",
        references: event.change.references,
        reason: "unknown-detail",
      };
      break;
    }
    case "selection.changed": {
      if (!sameProject(current, event.change.selected)) {
        return {
          snapshot: current,
          refresh: { scope: "full", reason: "project-mismatch" },
          applied: false,
        };
      }
      if (
        event.change.selected.some(
          (reference) =>
            reference.revision !== event.revision ||
            indexes.get(reference.kind)?.has(reference.id) !== true,
        )
      ) {
        throw new StaleReferenceError(
          "Selection contains a stale or missing reference",
        );
      }
      selected = event.change.selected;
      break;
    }
    case "transport.changed": {
      transport = event.change.transport;
      break;
    }
  }

  selected = selected.map((reference) => ({
    ...reference,
    revision: event.revision,
  }));

  return {
    snapshot: {
      ...current,
      revision: event.revision,
      transport,
      entities: indexes,
      selected,
      stale,
      lastSequence: event.sequence,
    },
    refresh,
    applied: true,
  };
}

export class StaleReferenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaleReferenceError";
  }
}

export class AmbiguousReferenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AmbiguousReferenceError";
  }
}

export class SnapshotCache {
  #snapshot: NormalizedSnapshot | undefined;
  readonly #clipNotes = new Map<string, { revision: number; value: unknown }>();
  readonly #deviceParameters = new Map<
    string,
    { revision: number; value: unknown }
  >();

  public ingest(snapshot: ProjectSnapshot): NormalizedSnapshot {
    this.#snapshot = normalizeSnapshot(snapshot);
    this.#clipNotes.clear();
    this.#deviceParameters.clear();
    return this.#snapshot;
  }

  public clear(): void {
    this.#snapshot = undefined;
    this.#clipNotes.clear();
    this.#deviceParameters.clear();
  }

  public current(): NormalizedSnapshot | undefined {
    return this.#snapshot;
  }

  public apply(event: SnapshotEvent): EventApplication {
    if (this.#snapshot === undefined) {
      throw new Error("Cannot apply an event before snapshot ingestion");
    }
    const result = applySnapshotEvent(this.#snapshot, event);
    if (result.applied) {
      if (result.snapshot.revision !== this.#snapshot.revision) {
        this.#clipNotes.clear();
        this.#deviceParameters.clear();
      } else {
        this.invalidateDetails(result.snapshot.stale);
      }
      this.#snapshot = result.snapshot;
    }
    return result;
  }

  public entity(reference: EntityReference): EntitySummary | undefined {
    return this.#snapshot?.entities.get(reference.kind)?.get(reference.id);
  }

  public resolveByName(kind: EntityKind, name: string): EntityReference {
    const snapshot = this.requireSnapshot();
    const matches = [...(snapshot.entities.get(kind)?.values() ?? [])].filter(
      (entity) => entity.name === name,
    );
    if (matches.length !== 1) {
      throw new AmbiguousReferenceError(
        matches.length === 0
          ? `No ${kind} named '${name}'`
          : `Multiple ${kind} entities are named '${name}'`,
      );
    }
    const match = matches[0];
    if (match === undefined) {
      throw new AmbiguousReferenceError(`No ${kind} named '${name}'`);
    }
    return {
      projectId: snapshot.project.id,
      kind,
      id: match.id,
      revision: snapshot.revision,
    };
  }

  public assertMutable(reference: EntityReference): EntitySummary {
    const snapshot = this.requireSnapshot();
    if (reference.projectId !== snapshot.project.id) {
      throw new StaleReferenceError("Reference belongs to another project");
    }
    if (reference.revision !== snapshot.revision) {
      throw new StaleReferenceError("Reference revision is stale");
    }
    if (snapshot.stale.has(keyOf(reference))) {
      throw new StaleReferenceError("Reference is marked stale");
    }
    const entity = snapshot.entities.get(reference.kind)?.get(reference.id);
    if (entity === undefined) {
      throw new StaleReferenceError("Reference no longer resolves");
    }
    return entity;
  }

  public setClipNotes(reference: EntityReference, value: unknown): void {
    this.assertKind(reference, ["session-clip", "arrangement-clip"] as const);
    this.assertMutable(reference);
    this.#clipNotes.set(keyOf(reference), {
      revision: reference.revision,
      value,
    });
  }

  public clipNotes(reference: EntityReference): unknown {
    this.assertMutable(reference);
    return this.detail(this.#clipNotes, reference);
  }

  public setDeviceParameters(reference: EntityReference, value: unknown): void {
    this.assertKind(reference, ["device"] as const);
    this.assertMutable(reference);
    this.#deviceParameters.set(keyOf(reference), {
      revision: reference.revision,
      value,
    });
  }

  public deviceParameters(reference: EntityReference): unknown {
    this.assertMutable(reference);
    return this.detail(this.#deviceParameters, reference);
  }

  private detail(
    cache: ReadonlyMap<string, { revision: number; value: unknown }>,
    reference: EntityReference,
  ): unknown {
    const entry = cache.get(keyOf(reference));
    return entry !== undefined && entry.revision === reference.revision
      ? entry.value
      : undefined;
  }

  private assertKind(
    reference: EntityReference,
    allowed: readonly EntityKind[],
  ): void {
    if (!allowed.includes(reference.kind)) {
      throw new Error(`Detail is not valid for ${reference.kind}`);
    }
  }

  private invalidateDetails(stale: ReadonlySet<string>): void {
    for (const key of stale) {
      this.#clipNotes.delete(key);
      this.#deviceParameters.delete(key);
    }
  }

  private requireSnapshot(): NormalizedSnapshot {
    if (this.#snapshot === undefined) {
      throw new Error("No active project snapshot");
    }
    return this.#snapshot;
  }
}
