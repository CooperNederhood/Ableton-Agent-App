export interface MutationLease {
  readonly resource: string;
  readonly owner: string;
  readonly released: boolean;
  release(): void;
}

export interface MutationLeaseManager {
  acquire(resource: string, owner: string): Promise<MutationLease>;
}

interface Waiter {
  readonly owner: string;
  readonly resolve: (lease: MutationLease) => void;
}

interface ResourceQueue {
  active: boolean;
  readonly waiters: Waiter[];
}

export class InMemoryMutationLeaseManager implements MutationLeaseManager {
  readonly #resources = new Map<string, ResourceQueue>();

  public acquire(resource: string, owner: string): Promise<MutationLease> {
    if (resource.trim() === "" || owner.trim() === "") {
      return Promise.reject(new Error("Lease resource and owner are required"));
    }
    const queue = this.#resources.get(resource) ?? {
      active: false,
      waiters: [],
    };
    this.#resources.set(resource, queue);
    return new Promise((resolve) => {
      queue.waiters.push({ owner, resolve });
      this.#dispatch(resource, queue);
    });
  }

  #dispatch(resource: string, queue: ResourceQueue): void {
    if (queue.active) return;
    const waiter = queue.waiters.shift();
    if (waiter === undefined) {
      this.#resources.delete(resource);
      return;
    }
    queue.active = true;
    let released = false;
    const lease: MutationLease = {
      resource,
      owner: waiter.owner,
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        queue.active = false;
        this.#dispatch(resource, queue);
      },
    };
    waiter.resolve(lease);
  }
}
