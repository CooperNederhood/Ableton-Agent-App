import type { OutputConnection, OutputProducer } from "./contracts.js";
import { outputProducerSchema } from "./contracts.js";
import type { SignalRoutingSummaryPublisher } from "./summaries.js";

export interface ConnectionRegistryOptions {
  readonly staleAfterMs: number;
  readonly now?: () => number;
  readonly publisher?: SignalRoutingSummaryPublisher;
}

export class InMemoryConnectionRegistry {
  readonly #connections = new Map<string, OutputConnection>();
  readonly #connectionIdByProducer = new Map<string, string>();
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  readonly #publisher: SignalRoutingSummaryPublisher | undefined;

  constructor(options: ConnectionRegistryOptions) {
    if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs <= 0) {
      throw new RangeError("staleAfterMs must be positive");
    }
    this.#staleAfterMs = options.staleAfterMs;
    this.#now = options.now ?? Date.now;
    this.#publisher = options.publisher;
  }

  register(
    connectionId: string,
    producerInput: OutputProducer,
  ): OutputConnection {
    const producer = outputProducerSchema.parse(producerInput);
    const now = this.#now();
    const previousId = this.#connectionIdByProducer.get(producer.producerId);
    if (previousId !== undefined) {
      const previous = this.#connections.get(previousId);
      if (previous !== undefined) {
        this.#connections.set(previousId, {
          ...previous,
          status: "disconnected",
          disconnectedAt: now,
        });
      }
    }

    const connection: OutputConnection = {
      connectionId,
      producer,
      status: "connected",
      connectedAt: now,
      lastHeartbeatAt: now,
    };
    this.#connections.set(connectionId, connection);
    this.#connectionIdByProducer.set(producer.producerId, connectionId);
    this.#publish();
    return connection;
  }

  heartbeat(connectionId: string): OutputConnection | undefined {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.status === "disconnected") {
      return undefined;
    }
    const updated: OutputConnection = {
      ...connection,
      status: "connected",
      lastHeartbeatAt: this.#now(),
    };
    this.#connections.set(connectionId, updated);
    this.#publish();
    return updated;
  }

  markStale(): readonly OutputConnection[] {
    const now = this.#now();
    const changed: OutputConnection[] = [];
    for (const [connectionId, connection] of this.#connections) {
      if (
        connection.status === "connected" &&
        now - connection.lastHeartbeatAt >= this.#staleAfterMs
      ) {
        const stale: OutputConnection = { ...connection, status: "stale" };
        this.#connections.set(connectionId, stale);
        changed.push(stale);
      }
    }
    if (changed.length > 0) {
      this.#publish();
    }
    return changed;
  }

  disconnect(connectionId: string): OutputConnection | undefined {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.status === "disconnected") {
      return connection;
    }
    const disconnected: OutputConnection = {
      ...connection,
      status: "disconnected",
      disconnectedAt: this.#now(),
    };
    this.#connections.set(connectionId, disconnected);
    if (
      this.#connectionIdByProducer.get(connection.producer.producerId) ===
      connectionId
    ) {
      this.#connectionIdByProducer.delete(connection.producer.producerId);
    }
    this.#publish();
    return disconnected;
  }

  get(connectionId: string): OutputConnection | undefined {
    return this.#connections.get(connectionId);
  }

  getCurrentForProducer(producerId: string): OutputConnection | undefined {
    const connectionId = this.#connectionIdByProducer.get(producerId);
    return connectionId === undefined
      ? undefined
      : this.#connections.get(connectionId);
  }

  list(): readonly OutputConnection[] {
    return [...this.#connections.values()];
  }

  listCurrent(): readonly OutputConnection[] {
    const current: OutputConnection[] = [];
    for (const connectionId of this.#connectionIdByProducer.values()) {
      const connection = this.#connections.get(connectionId);
      if (connection !== undefined) current.push(connection);
    }
    return current;
  }

  #publish(): void {
    this.#publisher?.publishConnections(this.listCurrent());
  }
}
