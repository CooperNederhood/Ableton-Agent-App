const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function prefixedId(prefix: string, uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) {
    throw new TypeError("Live event identifiers require a UUID");
  }
  return `${prefix}.${uuid.toLowerCase()}`;
}

export function createLiveEventId(uuid: string): string {
  return prefixedId("live-event", uuid);
}

export function createAgentEventListenerId(uuid: string): string {
  return prefixedId("event-listener", uuid);
}
